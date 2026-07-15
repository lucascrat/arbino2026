import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { AppDatabase } from '../db/Database.js';
import { service } from '../logger.js';
import { config } from '../config.js';
import type { Direction } from '../types.js';

const log = service('API');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

export interface BotState {
  running: boolean;
  mode: string;
  asset: string;
  candleTimeframe: number;
  expiration: number;
  entryValue: number;
  minSignalScore: number;
  martingaleLevels: number;
  martingaleMultiplier: number;
  cooldownSeconds: number;
  maxDailyTrades: number;
  maxDailyLoss: number;
  maxDailyProfit: number;
  aiEnabled: boolean;
  aiModel: string;
  tradesToday: number;
  lossesToday: number;
  consecutiveLosses: number;
  balance: number | null;
  lastSignal: unknown;
  lastTrade: unknown;
}

export interface DiagnosticInfo {
  wsFramesReceived: number;
  wsFramesSent: number;
  candleCount: number;
  socketCount: number;
  lastPrice: number | null;
  asset: string;
  sessionReady: boolean;
  uptime: number;
  lastTickTime: number | null;
  lastFramePreview: string;
  pageUrl?: string;
  pageTitle?: string;
}

export type BotEvent =
  | { type: 'log'; level: string; service: string; message: string; ts: number }
  | { type: 'candle'; candle: { time: number; open: number; high: number; low: number; close: number } }
  | { type: 'signal'; signal: unknown; aiVerdict: unknown; executed: boolean }
  | { type: 'trade'; trade: unknown }
  | { type: 'result'; trade: unknown }
  | { type: 'balance'; balance: number; currency: string }
  | { type: 'state'; state: BotState }
  | { type: 'warmup'; candles: number; target: number }
  | { type: 'diagnostic'; info: DiagnosticInfo };

export class ApiServer {
  private app = express();
  private server: http.Server;
  private io: IOServer;
  public port: number;
  public db: AppDatabase;
  private botProcess: ChildProcess | null = null;
  private botRunning = false;
  private state: BotState;
  private lastDiagnostic: DiagnosticInfo | null = null;
  private setupProcess: ChildProcess | null = null;

  constructor(port = 3456, db?: AppDatabase) {
    this.port = port;
    this.db = db ?? new AppDatabase();
    this.server = http.createServer(this.app);
    this.io = new IOServer(this.server, { cors: { origin: '*' } });
    this.state = this.buildBaseState();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocket();
    this.setupVncProxy();
  }

  private buildBaseState(): BotState {
    return {
      running: false,
      mode: config.mode,
      asset: config.asset,
      candleTimeframe: config.candleTimeframeSeconds,
      expiration: config.expirationSeconds,
      entryValue: config.entryValue,
      minSignalScore: config.minSignalScore,
      martingaleLevels: config.martingaleLevels,
      martingaleMultiplier: config.martingaleMultiplier,
      cooldownSeconds: config.cooldownSeconds,
      maxDailyTrades: config.maxDailyTrades,
      maxDailyLoss: config.maxDailyLoss,
      maxDailyProfit: config.maxDailyProfit,
      aiEnabled: config.aiEnabled,
      aiModel: config.aiModel,
      tradesToday: 0,
      lossesToday: 0,
      consecutiveLosses: 0,
      balance: null,
      lastSignal: null,
      lastTrade: null,
    };
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  private setupRoutes(): void {
    // Servir frontend (sem cache para debug)
    const frontendDir = path.resolve(__dirname, '..', '..', 'frontend');
    this.app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
      next();
    });
    this.app.use(express.static(frontendDir));

    // Serve entire noVNC package (core/ + vendor/pako/) via /novnc/ alias
    const novncDir = path.resolve(projectRoot, 'node_modules', '@novnc', 'novnc');
    this.app.use('/novnc', express.static(novncDir));

    // ===== API =====
    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    this.app.get('/api/system', (_req, res) => {
      const mem = process.memoryUsage();
      const dbInfo = this.db.getSystemInfo();
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        platform: process.platform,
        nodeVersion: process.version,
        db: dbInfo,
      });
    });

    this.app.get('/api/stats', (_req, res) => {
      const overall = this.db.getOverallStats();
      const sessions = this.db.getSessions(30);
      res.json({ overall, sessions });
    });

    this.app.get('/api/trades', (req, res) => {
      const limit = Number(req.query.limit) || 100;
      const trades = this.db.getTrades(limit);
      res.json(trades);
    });

    this.app.get('/api/analytics', (_req, res) => {
      res.json(this.db.getAnalytics());
    });

    this.app.get('/api/candles', (req, res) => {
      const limit = Number(req.query.limit) || 200;
      const candles = this.db.getCandles(limit);
      res.json(candles);
    });

    this.app.get('/api/sessions', (_req, res) => {
      res.json(this.db.getSessions(30));
    });

    this.app.get('/api/settings', (_req, res) => {
      const keys = ['entryValue', 'minSignalScore', 'martingaleLevels', 'martingaleMultiplier', 'cooldownSeconds', 'maxDailyTrades', 'maxDailyLoss', 'maxDailyProfit', 'aiEnabled', 'aiModel', 'asset', 'expirationSeconds', 'candleTimeframeSeconds'];
      const settings: Record<string, string | null> = {};
      for (const k of keys) settings[k] = this.db.getSetting(k);
      res.json(settings);
    });

    this.app.post('/api/settings', (req, res) => {
      try {
        const updates = req.body as Record<string, string>;
        if (!updates || typeof updates !== 'object') {
          res.status(400).json({ ok: false, message: 'Body invalido' });
          return;
        }
        for (const [k, v] of Object.entries(updates)) {
          this.db.setSetting(k, String(v));
        }
        // Notifica o bot para recarregar settings se estiver rodando
        if (this.botProcess) {
          try { this.botProcess.kill('SIGUSR1'); } catch { /* nao disponivel no Windows */ }
        }
        log.info('Settings salvas: %O', updates);
        res.json({ ok: true });
      } catch (err) {
        log.error('Erro ao salvar settings: %s', (err as Error).message);
        res.status(500).json({ ok: false, message: (err as Error).message });
      }
    });

    this.app.post('/api/bot/start', (req, res) => {
      if (this.botRunning) {
        res.json({ ok: false, message: 'Bot já está rodando' });
        return;
      }
      const mode = (req.body?.mode as string) || 'trade';
      const indexJs = path.join(projectRoot, 'dist', 'index.js');
      const nodeExe = process.execPath;

      log.info('Iniciando bot: %s %s --mode=%s', nodeExe, indexJs, mode);
      this.botProcess = spawn(nodeExe, [indexJs, `--mode=${mode}`], {
        cwd: projectRoot,
        stdio: 'pipe',
        env: { ...process.env, HEADLESS: 'false' },
      });

      this.botProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          log.info('[BOT] %s', msg);
          this.emitEvent({ type: 'log', level: 'info', service: 'BOT', message: msg, ts: Date.now() });
        }
      });
      this.botProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          log.error('[BOT ERR] %s', msg);
          this.emitEvent({ type: 'log', level: 'error', service: 'BOT', message: msg, ts: Date.now() });
        }
      });
      this.botProcess.on('exit', (code) => {
        log.info('Bot encerrado (código %s)', code);
        this.botRunning = false;
        this.botProcess = null;
        this.io.emit('bot:stopped');
        this.emitEvent({ type: 'state', state: this.getState() });
      });

      this.botRunning = true;
      this.emitEvent({ type: 'state', state: this.getState() });
      res.json({ ok: true, message: `Bot iniciado no modo ${mode}` });
    });

    this.app.post('/api/bot/stop', (_req, res) => {
      if (this.botProcess) {
        this.botProcess.kill('SIGINT');
        this.botRunning = false;
        res.json({ ok: true, message: 'Bot parado' });
      } else {
        res.json({ ok: false, message: 'Bot não está rodando' });
      }
    });

    // Notifica o ApiServer que o bot foi iniciado externamente (via IPC/Electron)
    this.app.post('/api/bot/external-start', (_req, res) => {
      this.botRunning = true;
      this.emitEvent({ type: 'state', state: this.getState() });
      log.info('Bot iniciado externamente (IPC/Electron)');
      res.json({ ok: true });
    });

    // Setup: lanca Chromium visivel no VNC para login manual
    this.app.post('/api/setup/login', (_req, res) => {
      if (this.setupProcess) {
        res.json({ ok: false, message: 'Setup ja em andamento' });
        return;
      }
      const distDir = path.resolve(projectRoot, 'dist');
      const setupScript = path.join(distDir, 'server', 'setup-login.js');
      // Usa o mesmo entry point com flag especial
      const nodeExe = process.execPath;
      const indexJs = path.join(projectRoot, 'dist', 'index.js');
      this.setupProcess = spawn(nodeExe, [indexJs, '--mode=setup-login'], {
        cwd: projectRoot,
        stdio: 'pipe',
        env: {
          ...process.env,
          HEADLESS: 'false',
          MODE: 'setup-login',
          SETUP_MODE: 'true',
        },
      });
      this.setupProcess.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.info('[SETUP] %s', msg);
      });
      this.setupProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.error('[SETUP ERR] %s', msg);
      });
      this.setupProcess.on('exit', () => {
        this.setupProcess = null;
        log.info('Setup encerrado');
      });
      log.info('Setup login iniciado (HEADLESS=false)');
      res.json({ ok: true, message: 'Navegador aberto para login. Use o VNC para acessar.' });
    });

    this.app.post('/api/setup/stop', (_req, res) => {
      if (this.setupProcess) {
        this.setupProcess.kill('SIGINT');
        this.setupProcess = null;
        res.json({ ok: true });
      } else {
        res.json({ ok: false, message: 'Nenhum setup em andamento' });
      }
    });

    this.app.get('/api/setup/status', (_req, res) => {
      const alive = this.setupProcess !== null && this.setupProcess.exitCode === null && !this.setupProcess.killed;
      res.json({ running: alive });
    });

    this.app.get('/api/bot/status', (_req, res) => {
      res.json({ running: this.botRunning });
    });

    this.app.get('/api/state', (_req, res) => {
      res.json(this.getState());
    });

    // Endpoint para o bot enviar eventos em tempo real
    this.app.post('/api/events', (req, res) => {
      const event = req.body as BotEvent;
      this.emitEvent(event);
      let tradeId: number | undefined;

      // Persiste no banco se for trade ou candle e atualiza estado em memoria
      if (event.type === 'trade' && event.trade) {
        const t = event.trade as { sessionId: string; direction: string; entryValue: number; expiration: number; score: number; asset: string; entryPrice: number | null; martingaleLevel: number; patterns: string[]; reasons: string[]; aiApproved: boolean; aiConfidence: number | null; aiReasoning: string | null; marketState?: string | null };
        tradeId = this.db.insertTrade({
          sessionId: t.sessionId,
          direction: t.direction as Direction,
          entryValue: t.entryValue,
          expiration: t.expiration,
          score: t.score,
          asset: t.asset,
          entryPrice: t.entryPrice,
          martingaleLevel: t.martingaleLevel,
          patterns: t.patterns,
          reasons: t.reasons,
          aiApproved: t.aiApproved,
          aiConfidence: t.aiConfidence,
          aiReasoning: t.aiReasoning,
          marketState: t.marketState,
        });
        this.state.tradesToday++;
        const emittedTrade = {
          id: tradeId,
          session_id: t.sessionId,
          direction: t.direction,
          entry_value: t.entryValue,
          expiration: t.expiration,
          score: t.score,
          status: 'PENDING',
          payout: null,
          asset: t.asset,
          entry_price: t.entryPrice,
          exit_price: null,
          martingale_level: t.martingaleLevel,
          patterns: t.patterns.join(', '),
          reasons: t.reasons.join(' | '),
          ai_approved: t.aiApproved ? 1 : 0,
          ai_confidence: t.aiConfidence,
          ai_reasoning: t.aiReasoning,
          market_state: t.marketState ?? null,
          placed_at: Date.now(),
        };
        this.state.lastTrade = emittedTrade;
        this.emitEvent({ type: 'trade', trade: emittedTrade });
        this.emitEvent({ type: 'state', state: this.getState() });
      }
      if (event.type === 'result' && event.trade) {
        const t = event.trade as { id: number; sessionId?: string; status: string; payout: number | null; exitPrice: number | null };
        let targetId = t.id;
        // Fallback: se o bot nao souber o id, pega o trade PENDING mais recente da sessao
        if ((!targetId || targetId <= 0) && t.sessionId) {
          const pending = this.db.getTradesBySession(t.sessionId).find((r) => r.status === 'PENDING');
          if (pending) targetId = pending.id;
        }
        if (targetId && targetId > 0) {
          this.db.updateTradeResult(targetId, t.status, t.payout, t.exitPrice);
          if (t.status === 'LOSS') {
            this.state.lossesToday += Math.abs(t.payout ?? 0) || 0;
            this.state.consecutiveLosses++;
          } else if (t.status === 'WIN') {
            this.state.consecutiveLosses = 0;
          }
          if (this.state.lastTrade && (this.state.lastTrade as { id?: number }).id === targetId) {
            (this.state.lastTrade as { status: string }).status = t.status;
            (this.state.lastTrade as { payout: number | null }).payout = t.payout;
            (this.state.lastTrade as { exit_price: number | null }).exit_price = t.exitPrice ?? null;
          }
          const emittedResult = {
            id: targetId,
            session_id: t.sessionId,
            status: t.status,
            payout: t.payout,
            exit_price: t.exitPrice,
          };
          this.emitEvent({ type: 'result', trade: emittedResult });
          this.emitEvent({ type: 'state', state: this.getState() });
        }
      }
      if (event.type === 'candle' && event.candle) {
        this.db.insertCandle(event.candle, 'Z-CRY/IDX');
      }
      if (event.type === 'signal' && event.signal) {
        this.state.lastSignal = event.signal;
        this.emitEvent({ type: 'state', state: this.getState() });
      }
      if (event.type === 'balance' && event.balance != null) {
        this.state.balance = event.balance;
        this.emitEvent({ type: 'state', state: this.getState() });
      }
      if (event.type === 'diagnostic' && event.info) {
        this.lastDiagnostic = event.info;
      }
      res.json({ ok: true, tradeId });
    });

    // Verifica se x11vnc esta acessivel
    this.app.get('/api/vnc/health', (_req, res) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.on('connect', () => {
        sock.destroy();
        res.json({ ok: true, message: 'x11vnc respondendo na porta 5900' });
      });
      sock.on('error', () => {
        sock.destroy();
        res.json({ ok: false, message: 'x11vnc nao respondeu na porta 5900' });
      });
      sock.on('timeout', () => {
        sock.destroy();
        res.json({ ok: false, message: 'Timeout ao conectar em x11vnc:5900' });
      });
      sock.connect(5900, '127.0.0.1');
    });

    // Endpoint de diagnostico
    this.app.get('/api/diagnose', (_req, res) => {
      res.json({
        botRunning: this.botRunning,
        lastDiagnostic: this.lastDiagnostic,
        health: { uptime: process.uptime() },
      });
    });

    // Endpoint para logs
    this.app.get('/api/logs', (_req, res) => {
      res.json({ logs: [] });
    });

    // SPA fallback — serve index.html para rotas não-API
    this.app.use((_req, res) => {
      res.sendFile(path.join(frontendDir, 'index.html'));
    });
  }

  private setupVncProxy(): void {
    // WebSocket proxy: /api/vnc/ws -> localhost:5900 (x11vnc)
    const wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, sock, head) => {
      const url = req.url ?? '';
      if (url === '/api/vnc/ws') {
        wss.handleUpgrade(req, sock, head, (ws) => {
          log.info('VNC WebSocket conectado');
          const tcp = net.connect(5900, '127.0.0.1', () => {
            log.info('VNC TCP conectado a x11vnc:5900');
          });
          ws.on('message', (raw) => {
            const buf = typeof raw === 'string' ? Buffer.from(raw)
              : raw instanceof Buffer ? raw
              : raw instanceof ArrayBuffer ? Buffer.from(raw)
              : Buffer.concat(raw as Buffer[]);
            tcp.write(buf);
          });
          tcp.on('data', (data: Buffer) => {
            ws.send(data);
          });
          ws.on('close', () => {
            log.info('VNC WebSocket fechado');
            tcp.end();
          });
          tcp.on('close', () => {
            ws.close();
          });
          tcp.on('error', (err) => {
            log.warn('VNC TCP erro: %s', err.message);
            ws.close();
          });
          ws.on('error', (err) => {
            log.warn('VNC WS erro: %s', err.message);
            tcp.end();
          });
        });
      }
    });
    log.info('VNC proxy pronto em /api/vnc/ws');
  }

  private setupSocket(): void {
    this.io.on('connection', (socket) => {
      log.info('Frontend conectado (socket %s)', socket.id);
      socket.emit('state', this.getState());
    });
  }

  emitEvent(event: BotEvent): void {
    // Emite apenas o payload relevante para cada tipo de evento,
    // mantendo compatibilidade com os handlers do frontend.
    switch (event.type) {
      case 'log':
        this.io.emit('log', event);
        break;
      case 'candle':
        this.io.emit('candle', event.candle);
        break;
      case 'signal':
        this.io.emit('signal', event);
        break;
      case 'trade':
        this.io.emit('trade', event.trade);
        break;
      case 'result':
        this.io.emit('result', event.trade);
        break;
      case 'balance':
        this.io.emit('balance', event);
        break;
      case 'state':
        this.io.emit('state', event.state);
        break;
      case 'warmup':
        this.io.emit('warmup', event);
        break;
      case 'diagnostic':
        // not forwarded to frontend; stored in lastDiagnostic
        break;
    }
  }

  getState(): BotState {
    // Lê settings do banco (sobrescreve config padrão)
    const get = (k: string): string | null => this.db.getSetting(k);
    const num = (k: string, fallback: number): number => {
      const v = get(k);
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const bool = (k: string, fallback: boolean): boolean => {
      const v = get(k);
      if (v === null) return fallback;
      return v === 'true' || v === '1';
    };
    const str = (k: string, fallback: string): string => {
      const v = get(k);
      return v === null || v === '' ? fallback : v;
    };

    return {
      ...this.state,
      running: this.botRunning,
      mode: str('mode', config.mode),
      asset: str('asset', config.asset),
      candleTimeframe: num('candleTimeframeSeconds', config.candleTimeframeSeconds),
      expiration: num('expirationSeconds', config.expirationSeconds),
      entryValue: num('entryValue', config.entryValue),
      minSignalScore: num('minSignalScore', config.minSignalScore),
      martingaleLevels: num('martingaleLevels', config.martingaleLevels),
      martingaleMultiplier: num('martingaleMultiplier', config.martingaleMultiplier),
      cooldownSeconds: num('cooldownSeconds', config.cooldownSeconds),
      maxDailyTrades: num('maxDailyTrades', config.maxDailyTrades),
      maxDailyLoss: num('maxDailyLoss', config.maxDailyLoss),
      maxDailyProfit: num('maxDailyProfit', config.maxDailyProfit),
      aiEnabled: bool('aiEnabled', config.aiEnabled),
      aiModel: str('aiModel', config.aiModel),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        log.info('API rodando em http://localhost:%d', this.port);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.botProcess) {
      this.botProcess.kill('SIGINT');
    }
    this.io.close();
    this.server.close();
    this.db.close();
    log.info('API encerrada.');
  }
}
