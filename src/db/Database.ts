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

export interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  win_rate: number;
  profit: number;
  loss: number;
  net: number;
  avg_gale: number;
  best_balance: number;
  worst_drawdown: number;
}

export interface BalanceRecord {
  timestamp: number;
  balance: number;
  currency: string;
}

export class AppDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(config.logsDir, 'arbinomo.db');
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);

    // Configuracao de performance e durabilidade
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('cache_size = -8000'); // 8MB cache
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('auto_vacuum = INCREMENTAL');

    this.migrate();
    this.integrityCheck();
    log.info('Banco SQLite inicializado: %s', this.dbPath);
  }

  private integrityCheck(): void {
    try {
      const result = this.db.pragma('integrity_check') as { integrity_check: string }[];
      const ok = result.every(r => r.integrity_check === 'ok');
      if (!ok) {
        log.error('CORRUPCAO DETECTADA no banco de dados!');
        for (const r of result) {
          log.error('  DB integrity: %s', r.integrity_check);
        }
      }
    } catch (err) {
      log.error('Falha ao verificar integridade do banco: %s', (err as Error).message);
    }
  }

  private migrate(): void {
    // --- Tabelas principais ---

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
        started_at INTEGER NOT NULL,
        ended_at INTEGER
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
        market_state TEXT,
        placed_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        asset TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
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
        value TEXT,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
      );

      -- Historico de alteracoes de config
      CREATE TABLE IF NOT EXISTS settings_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_at INTEGER NOT NULL
      );

      -- Historico de saldo da conta Binomo
      CREATE TABLE IF NOT EXISTS balance_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        balance REAL NOT NULL,
        currency TEXT DEFAULT 'BRL',
        session_id TEXT
      );

      -- Estatisticas diarias agregadas (pre-computadas ao fim do dia)
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        ties INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        loss REAL DEFAULT 0,
        net REAL DEFAULT 0,
        avg_gale_level REAL DEFAULT 0,
        total_gales INTEGER DEFAULT 0,
        best_balance REAL DEFAULT 0,
        worst_drawdown REAL DEFAULT 0,
        peak_balance REAL DEFAULT 0,
        updated_at INTEGER
      );

      -- Log de erros e eventos do bot
      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        service TEXT,
        message TEXT NOT NULL,
        stack TEXT,
        created_at INTEGER NOT NULL
      );
    `);

    // --- Indices ---
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
      CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(placed_at);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset, placed_at);
      CREATE INDEX IF NOT EXISTS idx_candles_time ON candles(time);
      CREATE INDEX IF NOT EXISTS idx_candles_asset ON candles(asset, time);
      CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_balance_time ON balance_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_balance_session ON balance_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_error_date ON error_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_error_level ON error_log(level);
    `);

    // Migracoes incrementais (colunas adicionadas posteriormente)
    this.addColumnIfMissing('trades', 'market_state', 'TEXT');
    this.addColumnIfMissing('trades', 'resolved_at', 'INTEGER');
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      log.info('Migracao: coluna %s.%s adicionada', table, column);
    } catch {
      // coluna ja existe
    }
  }

  // ==================== SESSAO ====================

  createSession(id: string): void {
    const today = new Date().toISOString().slice(0, 10);
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, date, started_at) VALUES (?, ?, ?)'
    ).run(id, today, Date.now());
  }

  endSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET ended_at=? WHERE id=?')
      .run(Date.now(), sessionId);
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

  getActiveSessions(): SessionRecord[] {
    return this.db.prepare(
      'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC'
    ).all() as SessionRecord[];
  }

  // ==================== TRADES ====================

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

  getTrades(limit = 100, offset = 0): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades ORDER BY placed_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as TradeRecord[];
  }

  getTradesByDate(date: string): TradeRecord[] {
    const start = new Date(date + 'T00:00:00Z').getTime();
    const end = new Date(date + 'T23:59:59.999Z').getTime();
    return this.db.prepare(
      'SELECT * FROM trades WHERE placed_at >= ? AND placed_at <= ? ORDER BY placed_at ASC'
    ).all(start, end) as TradeRecord[];
  }

  getTradesBySession(sessionId: string): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades WHERE session_id=? ORDER BY placed_at DESC'
    ).all(sessionId) as TradeRecord[];
  }

  getPendingTrades(): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades WHERE status=? ORDER BY placed_at DESC'
    ).all('PENDING') as TradeRecord[];
  }

  countTradesToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.prepare(
      'SELECT COUNT(*) as c FROM trades WHERE placed_at >= ?'
    ).get(startOfDay.getTime()) as { c: number };
    return row.c;
  }

  sumLossesToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(entry_value),0) as s FROM trades WHERE placed_at >= ? AND status=?'
    ).get(startOfDay.getTime(), 'LOSS') as { s: number };
    return row.s;
  }

  // ==================== CANDLES ====================

  insertCandle(c: Candle, asset: string): void {
    this.db.prepare(
      'INSERT INTO candles (time, open, high, low, close, asset) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(c.time, c.open, c.high, c.low, c.close, asset);
  }

  getCandles(limit = 200, asset?: string): Candle[] {
    if (asset) {
      const rows = this.db.prepare(
        'SELECT time, open, high, low, close FROM candles WHERE asset=? ORDER BY time DESC LIMIT ?'
      ).all(asset, limit) as Candle[];
      return rows.reverse();
    }
    const rows = this.db.prepare(
      'SELECT time, open, high, low, close FROM candles ORDER BY time DESC LIMIT ?'
    ).all(limit) as Candle[];
    return rows.reverse();
  }

  // ==================== SIGNALS ====================

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

  getSignals(limit = 100): Signal[] {
    return this.db.prepare(
      'SELECT * FROM signals ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as unknown as Signal[];
  }

  // ==================== SETTINGS ====================

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    const old = this.getSetting(key);
    // Registra no historico se houve mudanca
    if (old !== null && old !== value) {
      this.db.prepare(
        'INSERT INTO settings_history (key, old_value, new_value, changed_at) VALUES (?, ?, ?, ?)'
      ).run(key, old, value, Date.now());
    }
    this.db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(key, value, Date.now());
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const r of rows) {
      settings[r.key] = r.value;
    }
    return settings;
  }

  // ==================== BALANCE HISTORY ====================

  recordBalance(balance: number, currency: string, sessionId?: string): void {
    this.db.prepare(
      'INSERT INTO balance_history (timestamp, balance, currency, session_id) VALUES (?, ?, ?, ?)'
    ).run(Date.now(), balance, currency, sessionId ?? null);
  }

  getBalanceHistory(limit = 200): BalanceRecord[] {
    return this.db.prepare(
      'SELECT timestamp, balance, currency FROM balance_history ORDER BY timestamp DESC LIMIT ?'
    ).all(limit).reverse() as BalanceRecord[];
  }

  getLastBalance(): BalanceRecord | null {
    const row = this.db.prepare(
      'SELECT timestamp, balance, currency FROM balance_history ORDER BY timestamp DESC LIMIT 1'
    ).get() as BalanceRecord | undefined;
    return row ?? null;
  }

  // ==================== DAILY STATS ====================

  computeDailyStats(dateStr?: string): DailyStats | null {
    const date = dateStr ?? new Date().toISOString().slice(0, 10);
    const start = new Date(date + 'T00:00:00Z').getTime();
    const end = new Date(date + 'T23:59:59.999Z').getTime();

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as trades,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status='TIE' THEN 1 ELSE 0 END) as ties,
        COALESCE(SUM(CASE WHEN status='WIN' THEN payout ELSE 0 END), 0) as profit,
        COALESCE(SUM(CASE WHEN status='LOSS' THEN entry_value ELSE 0 END), 0) as loss,
        CASE WHEN COUNT(*) > 0 THEN ROUND(CAST(SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) ELSE 0 END as win_rate,
        COALESCE(AVG(CASE WHEN martingale_level > 0 THEN martingale_level END), 0) as avg_gale_level,
        SUM(CASE WHEN martingale_level > 0 THEN 1 ELSE 0 END) as total_gales
      FROM trades
      WHERE placed_at >= ? AND placed_at <= ? AND status IN ('WIN','LOSS','TIE')
    `).get(start, end) as {
      trades: number; wins: number; losses: number; ties: number;
      profit: number; loss: number; win_rate: number;
      avg_gale_level: number; total_gales: number;
    };

    if (!row || row.trades === 0) return null;

    // Busca pico de saldo do dia
    const balanceRow = this.db.prepare(`
      SELECT MAX(balance) as peak, MIN(balance) as low
      FROM balance_history
      WHERE timestamp >= ? AND timestamp <= ?
    `).get(start, end) as { peak: number; low: number };

    const net = row.profit - row.loss;
    const peakBal = balanceRow?.peak ?? 0;
    const lowBal = balanceRow?.low ?? 0;
    const drawdown = peakBal > 0 ? ((peakBal - lowBal) / peakBal) * 100 : 0;

    return {
      date,
      trades: row.trades,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      win_rate: row.win_rate,
      profit: row.profit,
      loss: row.loss,
      net,
      avg_gale: row.avg_gale_level,
      best_balance: peakBal,
      worst_drawdown: Math.round(drawdown * 100) / 100,
    };
  }

  saveDailyStats(dateStr?: string): void {
    const date = dateStr ?? new Date().toISOString().slice(0, 10);
    const stats = this.computeDailyStats(date);
    if (!stats) return;

    this.db.prepare(`
      INSERT OR REPLACE INTO daily_stats (date, trades, wins, losses, ties, win_rate, profit, loss, net, avg_gale_level, total_gales, best_balance, worst_drawdown, peak_balance, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      date, stats.trades, stats.wins, stats.losses, stats.ties,
      stats.win_rate, stats.profit, stats.loss, stats.net,
      stats.avg_gale,
      this.countGalesForDate(date),
      stats.best_balance,
      stats.worst_drawdown,
      stats.best_balance,
      Date.now()
    );
  }

  getDailyStats(days = 30): DailyStats[] {
    return this.db.prepare(
      'SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?'
    ).all(days).reverse() as DailyStats[];
  }

  private countGalesForDate(date: string): number {
    const start = new Date(date + 'T00:00:00Z').getTime();
    const end = new Date(date + 'T23:59:59.999Z').getTime();
    const row = this.db.prepare(
      'SELECT COUNT(*) as c FROM trades WHERE placed_at >= ? AND placed_at <= ? AND martingale_level > 0'
    ).get(start, end) as { c: number };
    return row.c;
  }

  // ==================== ERROR LOG ====================

  logError(level: string, message: string, service?: string, stack?: string): void {
    try {
      this.db.prepare(
        'INSERT INTO error_log (level, service, message, stack, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(level, service ?? null, message, stack ?? null, Date.now());
    } catch {
      // falha silenciosa - nao queremos loop de erro
    }
  }

  getErrorLogs(limit = 50): { level: string; service: string; message: string; created_at: number }[] {
    return this.db.prepare(
      'SELECT level, service, message, created_at FROM error_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as { level: string; service: string; message: string; created_at: number }[];
  }

  // ==================== STATS ====================

  getOverallStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    ties: number;
    winRate: number;
    netProfit: number;
    totalProfit: number;
    bestStreak: number;
    worstStreak: number;
  } {
    const row = this.db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status='TIE' THEN 1 ELSE 0 END) as ties,
        COALESCE(SUM(payout), 0) as net,
        COALESCE(SUM(CASE WHEN status='WIN' THEN payout ELSE 0 END), 0) as profit
      FROM trades WHERE status IN ('WIN','LOSS','TIE')`
    ).get() as { total: number; wins: number; losses: number; ties: number; net: number; profit: number };

    // Calcula streaks
    const streaks = this.computeStreaks();

    return {
      totalTrades: row.total ?? 0,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      ties: row.ties ?? 0,
      winRate: row.total > 0 ? ((row.wins / row.total) * 100) : 0,
      netProfit: row.net ?? 0,
      totalProfit: row.profit ?? 0,
      bestStreak: streaks.best,
      worstStreak: streaks.worst,
    };
  }

  private computeStreaks(): { best: number; worst: number } {
    const trades = this.db.prepare(
      "SELECT status FROM trades WHERE status IN ('WIN','LOSS') ORDER BY placed_at ASC"
    ).all() as { status: string }[];

    let bestW = 0, worstL = 0, curW = 0, curL = 0;
    for (const t of trades) {
      if (t.status === 'WIN') {
        curW++; curL = 0;
        if (curW > bestW) bestW = curW;
      } else {
        curL++; curW = 0;
        if (curL > worstL) worstL = curL;
      }
    }
    return { best: bestW, worst: worstL };
  }

  getAnalytics(): {
    galeStats: { avgLevel: number; totalGales: number; distribution: Record<string, number> };
    hourlyGales: { hour: number; count: number }[];
    hourlyPerformance: { hour: number; wins: number; losses: number; total: number; winRate: number }[];
    marketStateStats: { state: string; wins: number; losses: number; total: number; winRate: number }[];
  } {
    const galeDist = this.db.prepare(
      `SELECT martingale_level as level, COUNT(*) as count FROM trades WHERE martingale_level > 0 GROUP BY martingale_level ORDER BY level`
    ).all() as { level: number; count: number }[];

    const totalGales = galeDist.reduce((s, r) => s + r.count, 0);
    const sumLevels = galeDist.reduce((s, r) => s + r.level * r.count, 0);
    const avgLevel = totalGales > 0 ? Math.round((sumLevels / totalGales) * 10) / 10 : 0;
    const distribution: Record<string, number> = {};
    for (const r of galeDist) distribution[`nivel_${r.level}`] = r.count;

    const hourlyGales = this.db.prepare(
      `SELECT CAST(strftime('%H', placed_at / 1000, 'unixepoch') AS INTEGER) as hour, COUNT(*) as count
       FROM trades WHERE martingale_level > 0 AND status IN ('WIN','LOSS')
       GROUP BY hour ORDER BY hour`
    ).all() as { hour: number; count: number }[];

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

  getSystemInfo(): { tradeCount: number; candleCount: number; dbSizeBytes: number; sessionCount: number; errorCount: number } {
    const tradeCount = (this.db.prepare('SELECT COUNT(*) as c FROM trades').get() as { c: number }).c;
    const candleCount = (this.db.prepare('SELECT COUNT(*) as c FROM candles').get() as { c: number }).c;
    const sessionCount = (this.db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM trades').get() as { c: number }).c;
    const errorCount = (this.db.prepare('SELECT COUNT(*) as c FROM error_log').get() as { c: number }).c;
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.dbPath).size;
    } catch { /* ignore */ }
    return { tradeCount, candleCount, dbSizeBytes, sessionCount, errorCount };
  }

  // ==================== EXPORTACAO ====================

  exportTradesCSV(dateFrom?: string, dateTo?: string): string {
    let query = 'SELECT * FROM trades';
    const params: number[] = [];
    if (dateFrom || dateTo) {
      const clauses: string[] = [];
      if (dateFrom) {
        clauses.push('placed_at >= ?');
        params.push(new Date(dateFrom + 'T00:00:00Z').getTime());
      }
      if (dateTo) {
        clauses.push('placed_at <= ?');
        params.push(new Date(dateTo + 'T23:59:59.999Z').getTime());
      }
      query += ' WHERE ' + clauses.join(' AND ');
    }
    query += ' ORDER BY placed_at ASC';

    const rows = this.db.prepare(query).all(...params) as TradeRecord[];
    if (rows.length === 0) return '';

    const headers = Object.keys(rows[0]).join(',');
    const lines = rows.map(r =>
      Object.values(r).map(v => {
        if (v === null) return '';
        if (typeof v === 'string') return '"' + v.replace(/"/g, '""') + '"';
        return String(v);
      }).join(',')
    );
    return headers + '\n' + lines.join('\n');
  }

  exportTradesJSON(dateFrom?: string, dateTo?: string): object[] {
    let query = 'SELECT * FROM trades';
    const params: number[] = [];
    if (dateFrom || dateTo) {
      const clauses: string[] = [];
      if (dateFrom) {
        clauses.push('placed_at >= ?');
        params.push(new Date(dateFrom + 'T00:00:00Z').getTime());
      }
      if (dateTo) {
        clauses.push('placed_at <= ?');
        params.push(new Date(dateTo + 'T23:59:59.999Z').getTime());
      }
      query += ' WHERE ' + clauses.join(' AND ');
    }
    query += ' ORDER BY placed_at ASC';

    return this.db.prepare(query).all(...params) as object[];
  }

  // ==================== MANUTENCAO ====================

  /** Remove candles mais antigos que N dias para economizar espaco */
  vacuumCandles(retainDays = 30): number {
    const cutoff = Date.now() - retainDays * 86400000;
    const result = this.db.prepare('DELETE FROM candles WHERE time < ?').run(cutoff);
    return result.changes;
  }

  /** Remove signals e error_logs mais antigos que N dias */
  vacuumLogs(retainDays = 90): { signals: number; errors: number } {
    const cutoff = Date.now() - retainDays * 86400000;
    const sigResult = this.db.prepare('DELETE FROM signals WHERE created_at < ?').run(cutoff);
    const errResult = this.db.prepare('DELETE FROM error_log WHERE created_at < ?').run(cutoff);
    return { signals: sigResult.changes, errors: errResult.changes };
  }

  /** Executa manutencao periodica (chamar a cada 6-12h) */
  maintenance(): void {
    try {
      this.vacuumCandles(30);
      this.vacuumLogs(90);
      // Atualiza estatisticas do dia corrente
      const today = new Date().toISOString().slice(0, 10);
      this.saveDailyStats(today);
      // Libera espaco do WAL
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.warn('Manutencao do banco falhou: %s', (err as Error).message);
    }
  }

  /** Compacta o banco de dados (chamar raramente, fora de pico) */
  vacuum(): void {
    log.info('Iniciando VACUUM do banco de dados...');
    this.db.exec('VACUUM');
    log.info('VACUUM concluido.');
  }

  // ==================== FECHAMENTO ====================

  close(): void {
    try {
      // Garante consistencia antes de fechar
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
      log.info('Banco fechado com seguranca.');
    } catch (err) {
      log.error('Erro ao fechar banco: %s', (err as Error).message);
    }
  }
}
