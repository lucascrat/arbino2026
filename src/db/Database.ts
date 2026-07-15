import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { TradeResult, Signal, Candle, Direction } from '../types.js';

const log = service('Database');

export interface TradeRecord {
  id: number;
  session_id: string;
  direction: Direction;
  entry_value: number;
  expiration: number;
  score: number;
  status: string;
  payout: number | null;
  asset: string;
  entry_price: number | null;
  exit_price: number | null;
  martingale_level: number;
  patterns: string;
  reasons: string;
  ai_approved: boolean;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  market_state: string | null;
  placed_at: number;
  resolved_at: number | null;
}

export interface SessionRecord {
  id: string;
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pending: number;
  win_rate: number;
  net_profit: number;
  max_consecutive_losses: number;
  started_at: number;
}

export class AppDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(config.logsDir, 'arbinomo.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    log.info('Banco SQLite inicializado: %s', file);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        pending INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0,
        net_profit REAL DEFAULT 0,
        max_consecutive_losses INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_value REAL NOT NULL,
        expiration INTEGER NOT NULL,
        score INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        payout REAL,
        asset TEXT NOT NULL,
        entry_price REAL,
        exit_price REAL,
        martingale_level INTEGER DEFAULT 0,
        patterns TEXT,
        reasons TEXT,
        ai_approved INTEGER DEFAULT 1,
        ai_confidence REAL,
        ai_reasoning TEXT,
        placed_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS candles (
        time INTEGER PRIMARY KEY,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        asset TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        score INTEGER NOT NULL,
        patterns TEXT,
        reasons TEXT,
        ai_approved INTEGER,
        ai_confidence REAL,
        ai_reasoning TEXT,
        executed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
      CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(placed_at);
      CREATE INDEX IF NOT EXISTS idx_candles_time ON candles(time);
    `);

    // Migracoes posteriores
    this.addColumnIfMissing('trades', 'market_state', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Coluna ja existe — ignora
    }
  }

  // ===== Sessions =====
  createSession(id: string): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, date, started_at) VALUES (?, ?, ?)'
    ).run(id, today, Date.now());
  }

  updateSessionStats(sessionId: string, stats: {
    trades: number; wins: number; losses: number; pending: number;
    netProfit: number; maxConsecutiveLosses: number;
  }): void {
    const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
    this.db.prepare(
      `UPDATE sessions SET trades=?, wins=?, losses=?, pending=?, win_rate=?, net_profit=?, max_consecutive_losses=? WHERE id=?`
    ).run(stats.trades, stats.wins, stats.losses, stats.pending, winRate, stats.netProfit, stats.maxConsecutiveLosses, sessionId);
  }

  getSessions(limit = 30): SessionRecord[] {
    return this.db.prepare(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as SessionRecord[];
  }

  // ===== Trades =====
  insertTrade(trade: {
    sessionId: string;
    direction: Direction;
    entryValue: number;
    expiration: number;
    score: number;
    asset: string;
    entryPrice: number | null;
    martingaleLevel: number;
    patterns: string[];
    reasons: string[];
    aiApproved: boolean;
    aiConfidence: number | null;
    aiReasoning: string | null;
    marketState?: string | null;
  }): number {
    // Garante que a sessao existe (FK constraint)
    this.createSession(trade.sessionId);
    const result = this.db.prepare(
      `INSERT INTO trades (session_id, direction, entry_value, expiration, score, status, asset, entry_price, martingale_level, patterns, reasons, ai_approved, ai_confidence, ai_reasoning, market_state, placed_at)
       VALUES (@sessionId, @direction, @entryValue, @expiration, @score, 'PENDING', @asset, @entryPrice, @martingaleLevel, @patterns, @reasons, @aiApproved, @aiConfidence, @aiReasoning, @marketState, @placedAt)`
    ).run({
      sessionId: trade.sessionId,
      direction: trade.direction,
      entryValue: trade.entryValue,
      expiration: trade.expiration,
      score: trade.score,
      asset: trade.asset,
      entryPrice: trade.entryPrice,
      martingaleLevel: trade.martingaleLevel,
      patterns: trade.patterns.join(', '),
      reasons: trade.reasons.join(' | '),
      aiApproved: trade.aiApproved ? 1 : 0,
      aiConfidence: trade.aiConfidence,
      aiReasoning: trade.aiReasoning,
      marketState: trade.marketState ?? null,
      placedAt: Date.now(),
    });
    return Number(result.lastInsertRowid);
  }

  updateTradeResult(id: number, status: string, payout: number | null, exitPrice: number | null): void {
    this.db.prepare(
      'UPDATE trades SET status=?, payout=?, exit_price=?, resolved_at=? WHERE id=?'
    ).run(status, payout, exitPrice, Date.now(), id);
  }

  getTrades(limit = 100): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades ORDER BY placed_at DESC LIMIT ?'
    ).all(limit) as TradeRecord[];
  }

  getTradesBySession(sessionId: string): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades WHERE session_id=? ORDER BY placed_at DESC'
    ).all(sessionId) as TradeRecord[];
  }

  // ===== Candles =====
  insertCandle(c: Candle, asset: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO candles (time, open, high, low, close, asset) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(c.time, c.open, c.high, c.low, c.close, asset);
  }

  getCandles(limit = 200): Candle[] {
    const rows = this.db.prepare(
      'SELECT time, open, high, low, close FROM candles ORDER BY time DESC LIMIT ?'
    ).all(limit) as Candle[];
    return rows.reverse();
  }

  // ===== Signals =====
  insertSignal(signal: Signal, aiApproved: boolean | null, aiConfidence: number | null, aiReasoning: string | null, executed: boolean): void {
    this.db.prepare(
      `INSERT INTO signals (direction, score, patterns, reasons, ai_approved, ai_confidence, ai_reasoning, executed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      signal.direction,
      signal.score,
      signal.patterns.join(', '),
      signal.reasons.join(' | '),
      aiApproved === null ? null : aiApproved ? 1 : 0,
      aiConfidence,
      aiReasoning,
      executed ? 1 : 0,
      Date.now()
    );
  }

  // ===== Settings =====
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  // ===== Stats =====
  getOverallStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netProfit: number;
    bestStreak: number;
    worstStreak: number;
  } {
    const row = this.db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(payout), 0) as net
      FROM trades WHERE status IN ('WIN','LOSS')`
    ).get() as { total: number; wins: number; losses: number; net: number };

    return {
      totalTrades: row.total ?? 0,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      winRate: row.total > 0 ? ((row.wins / row.total) * 100) : 0,
      netProfit: row.net ?? 0,
      bestStreak: 0,
      worstStreak: 0,
    };
  }

  getAnalytics(): {
    galeStats: { avgLevel: number; totalGales: number; distribution: Record<string, number> };
    hourlyGales: { hour: number; count: number }[];
    hourlyPerformance: { hour: number; wins: number; losses: number; total: number; winRate: number }[];
    marketStateStats: { state: string; wins: number; losses: number; total: number; winRate: number }[];
  } {
    // Gale distribution
    const galeDist = this.db.prepare(
      `SELECT martingale_level as level, COUNT(*) as count FROM trades WHERE martingale_level > 0 GROUP BY martingale_level ORDER BY level`
    ).all() as { level: number; count: number }[];

    const totalGales = galeDist.reduce((s, r) => s + r.count, 0);
    const sumLevels = galeDist.reduce((s, r) => s + r.level * r.count, 0);
    const avgLevel = totalGales > 0 ? Math.round((sumLevels / totalGales) * 10) / 10 : 0;
    const distribution: Record<string, number> = {};
    for (const r of galeDist) distribution[`nivel_${r.level}`] = r.count;

    // Hourly gales
    const hourlyGales = this.db.prepare(
      `SELECT CAST(strftime('%H', placed_at / 1000, 'unixepoch') AS INTEGER) as hour, COUNT(*) as count
       FROM trades WHERE martingale_level > 0 AND status IN ('WIN','LOSS')
       GROUP BY hour ORDER BY hour`
    ).all() as { hour: number; count: number }[];

    // Hourly performance
    const hourlyPerf = this.db.prepare(
      `SELECT CAST(strftime('%H', placed_at / 1000, 'unixepoch') AS INTEGER) as hour,
              SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
              COUNT(*) as total
       FROM trades WHERE status IN ('WIN','LOSS')
       GROUP BY hour ORDER BY hour`
    ).all() as { hour: number; wins: number; losses: number; total: number }[];

    const hourlyPerformance = hourlyPerf.map((r) => ({
      hour: r.hour,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
      winRate: r.total > 0 ? Math.round((r.wins / r.total) * 100) : 0,
    }));

    // Market state stats
    const marketRows = this.db.prepare(
      `SELECT market_state as state,
              SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
              COUNT(*) as total
       FROM trades WHERE status IN ('WIN','LOSS') AND market_state IS NOT NULL
       GROUP BY market_state ORDER BY total DESC`
    ).all() as { state: string; wins: number; losses: number; total: number }[];

    const marketStateStats = marketRows.map((r) => ({
      state: r.state,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
      winRate: r.total > 0 ? Math.round((r.wins / r.total) * 100) : 0,
    }));

    return {
      galeStats: { avgLevel, totalGales, distribution },
      hourlyGales,
      hourlyPerformance,
      marketStateStats,
    };
  }

  getSystemInfo(): { tradeCount: number; candleCount: number; dbSizeBytes: number; sessionCount: number } {
    const tradeCount = (this.db.prepare('SELECT COUNT(*) as c FROM trades').get() as { c: number }).c;
    const candleCount = (this.db.prepare('SELECT COUNT(*) as c FROM candles').get() as { c: number }).c;
    const sessionCount = (this.db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM trades').get() as { c: number }).c;
    let dbSizeBytes = 0;
    try {
      const dbPath = this.db.name;
      dbSizeBytes = fs.statSync(dbPath).size;
    } catch { /* ignore */ }
    return { tradeCount, candleCount, dbSizeBytes, sessionCount };
  }

  close(): void {
    this.db.close();
    log.info('Banco fechado.');
  }
}
