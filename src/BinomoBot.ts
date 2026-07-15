import { config } from './config.js';
import { service } from './logger.js';
import type { RunMode, Signal, TradeResult } from './types.js';
import { CandleFeed } from './data/CandleFeed.js';
import { BrowserSession } from './data/BrowserSession.js';
import { SignalEngine, type MarketSentiment } from './analysis/SignalEngine.js';
import { SessionFilter } from './analysis/SessionFilter.js';
import { Trader } from './execution/Trader.js';
import { RiskManager } from './risk/RiskManager.js';
import { Backtester, runBacktest } from './backtest/Backtester.js';
import { AIAdvisor } from './ai/AIAdvisor.js';
import { BotApiClient, type DiagnosticInfo } from './ai/BotApiClient.js';
import { trendBias } from './analysis/CandlePatterns.js';
import path from 'node:path';

const log = service('BinomoBot');

export class BinomoBot {
  private feed = new CandleFeed(config.candleTimeframeSeconds);
  private session = new BrowserSession(this.feed);
  private engine = new SignalEngine(config.minSignalScore);
  private sessionFilter = new SessionFilter();
  private risk = new RiskManager();
  private ai = new AIAdvisor();
  private api = new BotApiClient();
  private trader?: Trader;
  private running = false;
  private lastSignalTime = 0;
  private csvPath = path.join(config.logsDir, 'candles.csv');

  private sendDiag(): void {
    const rawLog = this.feed.getRawLog();
    let pageInfo = { url: 'unknown', title: '' };
    try { pageInfo = this.session.getPageInfoSync(); } catch { /* session not started */ }
    const diag: DiagnosticInfo = {
      wsFramesReceived: rawLog.filter(f => f.dir === 'in').length,
      wsFramesSent: rawLog.filter(f => f.dir === 'out').length,
      candleCount: this.feed.getCandles().length,
      socketCount: this.feed.socketCount,
      lastPrice: this.feed.lastPrice,
      asset: config.asset,
      sessionReady: this.session.ready,
      uptime: process.uptime(),
      lastTickTime: this.feed.lastTickTime,
      lastFramePreview: rawLog.length > 0 ? rawLog.slice(-1)[0].payload.slice(0, 200) : '',
      pageUrl: pageInfo.url,
      pageTitle: pageInfo.title,
    };
    this.api.sendDiagnostic(diag);
  }

  async run(mode: RunMode = config.mode): Promise<void> {
    log.info('Iniciando bot no modo: %s | TF candle=%ds | exp=%ds | asset=%s', mode, config.candleTimeframeSeconds, config.expirationSeconds, config.asset);
    log.info('IA: %s | Score min: %d | Entrada: R$ %s | Gale: %d niveis (%sx)', config.aiEnabled ? 'ATIVA' : 'OFF', config.minSignalScore, config.entryValue.toFixed(2), config.martingaleLevels, config.martingaleMultiplier);

    if (mode === 'backtest') {
      await runBacktest();
      return;
    }

    // Diagnostico inicial
    this.sendDiag();

    // Timeout para toda a inicializacao da sessao (2min)
    await Promise.race([
      this.session.start(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT: session.start() excedeu 2 minutos')), 120000)
      ),
    ]).catch(async (err) => {
      log.error('Falha ao iniciar sessao: %s', err.message);
      try {
        const info = this.session.getPageInfoSync();
        log.info('URL da pagina: %s | titulo: %s', info.url, info.title);
        const html = await this.session.getPage().content().catch(() => '');
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
        log.info('Texto visivel da pagina: %s', bodyText);
      } catch { /* ignore */ }
    });

    // Diagnostico apos abrir sessao (mesmo se falhou)
    this.sendDiag();

    await this.session.selectAsset(config.asset);
    this.trader = new Trader(this.session.getPage());

    // Assina novos candles para enviar ao frontend
    this.feed.onCandle((c) => {
      this.api.sendCandle(c);
    });

    if (config.recordCandles) {
      this.feed.enableCsvRecording(this.csvPath);
    }

    if (mode === 'discovery') {
      await this.discoveryLoop();
    } else {
      await this.tradeLoop();
    }
  }

  private async refreshAnalytics(): Promise<void> {
    try {
      const res = await fetch('http://localhost:3456/api/analytics');
      const data = await res.json() as {
        galeStats: { avgLevel: number; totalGales: number; distribution: Record<string, number> };
        hourlyGales: { hour: number; count: number }[];
        hourlyPerformance: { hour: number; wins: number; losses: number; total: number; winRate: number }[];
        marketStateStats: { state: string; wins: number; losses: number; total: number; winRate: number }[];
      };

      const parts: string[] = [];

      // Gale stats
      if (data.galeStats.totalGales > 0) {
        parts.push(`Gales: media nivel ${data.galeStats.avgLevel}, total ${data.galeStats.totalGales}`);
      }

      // Melhores/piores horarios
      const valid = data.hourlyPerformance.filter((h) => h.total >= 2);
      if (valid.length > 0) {
        const best = [...valid].sort((a, b) => b.winRate - a.winRate).slice(0, 2);
        const worst = [...valid].sort((a, b) => a.winRate - b.winRate).slice(0, 2);
        parts.push(`Melhores horarios: ${best.map((h) => `${h.hour}h(${h.winRate}%)`).join(', ')}`);
        parts.push(`Piores horarios: ${worst.map((h) => `${h.hour}h(${h.winRate}%)`).join(', ')}`);
      }

      // Mercado
      if (data.marketStateStats.length > 0) {
        const top = data.marketStateStats.slice(0, 3);
        parts.push(`Mercado: ${top.map((m) => `${m.state}(${m.winRate}%)`).join(', ')}`);
      }

      if (parts.length > 0) {
        this.ai.setAnalytics(parts.join(' | '));
        log.info('Analytics carregados para IA: %s', parts.join(' | '));
      }
    } catch {
      log.debug('Analytics indisponiveis (API pode nao estar pronta)');
    }
  }

  private async discoveryLoop(): Promise<void> {
    log.info('=== MODO DISCOVERY ===');
    log.info('Capturando WebSockets por 45s. Agregando ticks em candles de %ds.', config.candleTimeframeSeconds);

    const rawDumpPath = path.join(config.logsDir, 'raw_frames.jsonl');
    this.feed.enableRawDump(rawDumpPath);

    const started = Date.now();
    const dur = 45_000;
    while (Date.now() - started < dur) {
      await sleep(5000);
      const candleCount = this.feed.getCandles().length;
      const lastCandles = this.feed.getCandles(3);
      log.info('Progresso: candles=%d sentimento=%s ultimas=%j', candleCount, this.feed.sentiment ? `CALL ${this.feed.sentiment.call}%/PUT ${this.feed.sentiment.put}%` : 'n/a', lastCandles.map((c) => ({ t: c.time, C: c.close })));
    }

    this.feed.flushCurrent();
    const raw = this.feed.getRawLog();
    const inFrames = raw.filter((r) => r.dir === 'in');
    const outFrames = raw.filter((r) => r.dir === 'out');
    log.info('=== RESUMO DISCOVERY ===');
    log.info('Frames WS: %d IN / %d OUT (total %d)', inFrames.length, outFrames.length, raw.length);
    log.info('Candles agregados: %d', this.feed.getCandles().length);
    log.info('Sentimento final: %j', this.feed.sentiment);
    log.info('Últimos 5 candles: %j', this.feed.getCandles(5));
    log.info('Frames brutos salvos em: %s', rawDumpPath);
    if (config.recordCandles) log.info('Candles gravados em: %s', this.csvPath);
    log.info('Eventos distintos recebidos:');
    const events = new Map<string, number>();
    for (const f of inFrames) {
      try {
        const j = JSON.parse(f.payload);
        const key = j.event ? `${j.event} (${j.topic ?? '-'})` : j.data ? 'tick (data.assets)' : 'other';
        events.set(key, (events.get(key) ?? 0) + 1);
      } catch {
        events.set('non-JSON', (events.get('non-JSON') ?? 0) + 1);
      }
    }
    for (const [ev, cnt] of events) log.info('  %s: %d', ev, cnt);

    log.info('=== INSPEÇÃO DOM (botões de trade) ===');
    const dom = await this.session.dumpTradeDom();
    log.info('DOM: %j', dom);

    this.feed.close();
    await this.session.close();
  }

  private getSentiment(): MarketSentiment | null {
    if (!this.feed.sentiment) return null;
    const recent = this.feed.recentDeals.slice(-10).map((d) => ({ direction: d.direction, bet: d.bet }));
    return {
      call: this.feed.sentiment.call,
      put: this.feed.sentiment.put,
      recentDeals: recent,
    };
  }

  /**
   * Carrega settings do banco SQLite (sobrescreve .env).
   * Permite que o frontend altere configurações sem editar o .env.
   */
  private async loadSettingsFromDb(): Promise<void> {
    try {
      const res = await fetch('http://localhost:3456/api/settings', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const settings = await res.json() as Record<string, string>;
      const cfg = config as Record<string, unknown>;
      const numKeys = ['entryValue', 'minSignalScore', 'expirationSeconds', 'candleTimeframeSeconds', 'martingaleLevels', 'martingaleMultiplier', 'cooldownSeconds', 'maxDailyTrades', 'maxDailyLoss', 'maxDailyProfit'];
      const boolKeys = ['aiEnabled'];
      const strKeys = ['asset', 'aiModel', 'aiEndpoint', 'aiApiKey'];
      for (const k of numKeys) {
        if (settings[k] != null) {
          const n = Number(settings[k]);
          if (Number.isFinite(n)) cfg[k] = n;
        }
      }
      for (const k of boolKeys) {
        if (settings[k] != null) cfg[k] = settings[k] === 'true' || settings[k] === '1';
      }
      for (const k of strKeys) {
        if (settings[k] != null && settings[k] !== '') cfg[k] = settings[k];
      }
      log.info('Settings carregadas do banco.');
    } catch {
      // Sem API server — usa .env
    }
  }

  private async tradeLoop(): Promise<void> {
    this.running = true;
    log.info('=== MODO TRADE (DEMO) ===');
    log.info('Asset: %s | TF candle: %ds | Expiração: %ds | Entrada: %s', config.asset, config.candleTimeframeSeconds, config.expirationSeconds, config.entryValue.toFixed(2));
    log.info('Score mínimo: %d | Max trades/dia: %d | Stop-loss: %s | Cooldown: %ds', config.minSignalScore, config.maxDailyTrades, config.maxDailyLoss.toFixed(2), config.cooldownSeconds);
    log.info('Filtro de sessão: %s', config.sessionFilter);
    if (config.recordCandles) log.info('Gravando candles em: %s', this.csvPath);
    log.warn('MODO AUTOMÁTICO ATIVO — trades serão executados sem confirmação.');
    log.info('Iniciando em 10s (Ctrl+C para abortar)...');
    await sleep(10000);

    this.sessionFilter.logStatus();
    log.info('Aguardando %d candles para iniciar análise...', 30);

    // Carrega analytics para a IA
    await this.refreshAnalytics();

      let warmupMsg = false;
    let lastProgressLog = 0;
    let warmupStart = Date.now();
    let sessionLoggedThisCycle = false;
    let lastSignalLog = 0;
    while (this.running) {
      await sleep(config.pollIntervalMs);

      // Filtro de horário: pausa fora de sessão
      const session = this.sessionFilter.isTradableNow();
      if (!session.allowed) {
        if (!sessionLoggedThisCycle) {
          log.info('Fora de sessão (%s abre em %smin). Pausado.', session.session, session.nextOpenInMin);
          sessionLoggedThisCycle = true;
        }
        continue;
      }
      if (sessionLoggedThisCycle) {
        log.info('Sessão reaberta (%s). Retomando.', session.session);
        sessionLoggedThisCycle = false;
      }

      const candleCount = this.feed.getCandles().length;

      // Diagnostico: se passou muito tempo sem candles, tenta recuperar
      if (candleCount === 0 && Date.now() - warmupStart > 60000) {
        log.warn('Nenhum candle recebido em 60s. Tentando re-selecionar ativo...');
        await this.session.selectAsset(config.asset).catch(() => {});
        warmupStart = Date.now();
      }

      if (!this.feed.has(30)) {
        if (!warmupMsg) {
          log.warn('Ainda sem candles suficientes (%d). Verifique se o feed está capturando.', candleCount);
          warmupMsg = true;
          lastProgressLog = Date.now();
          this.api.sendWarmup(0, 30);
        } else if (Date.now() - lastProgressLog > 30000) {
          log.info('Aguardando candles... (%d/30)', candleCount);
          lastProgressLog = Date.now();
          this.api.sendWarmup(candleCount, 30);
          if (candleCount === 0) {
            log.warn('Nenhum candle ainda. Verifique se o navegador esta logado no Binomo e na pagina de trading.');
          }
          this.sendDiag();
        } else if (candleCount > 0 && Date.now() - lastProgressLog > 5000) {
          this.api.sendWarmup(candleCount, 30);
        }
        // Envia diagnostico a cada ~5s no warmup
        if (candleCount < 30 && Date.now() - lastProgressLog > 5000) {
          this.sendDiag();
        }
        continue;
      }
      warmupMsg = false;

      const candles = this.feed.getCandles(80);
      const lastTime = candles[candles.length - 1].time;

      if (lastTime === this.lastSignalTime) continue;
      this.lastSignalTime = lastTime;

      const signal: Signal | null = this.engine.evaluate(candles, this.getSentiment());
      if (!signal) {
        if (Date.now() - lastSignalLog > 60000) {
          log.info('Analisando... nenhum padrao forte encontrado nesta candle. Aguardando proxima.');
          lastSignalLog = Date.now();
        }
        continue;
      }

      log.info('SINAL %s score=%d | motivos: %s', signal.direction, signal.score, signal.reasons.join(' | '));
      const decision = this.risk.canTrade(signal.direction, signal.score);
      if (!decision.allowed) {
        log.info('Trade bloqueado: %s', decision.reason);
        this.api.sendSignal(signal, null, false);
        continue;
      }

      const aiContext = {
        trend: trendBias(candles),
        sentiment: this.getSentiment(),
        patterns: signal.patterns,
        indicators: this.engine.getContext(candles),
      };
      const verdict = await this.ai.validate(signal, candles, aiContext);

      // Captura estado do mercado no momento do trade
      const ind = aiContext.indicators;
      const adxState = ind.adx >= 25 ? 'trending' : ind.adx < 20 ? 'ranging' : 'transition';
      const volState = ind.atrNormalized > 0.001 ? 'volatile' : 'calm';
      const trendDir = aiContext.trend.direction;
      const marketState = `${adxState}_${trendDir}_${volState}`;
      if (!verdict.approve) {
        log.info('IA BLOQUEOU: conf=%d risk=%s - %s', verdict.confidence, verdict.risk, verdict.reasoning);
        this.api.sendSignal(signal, verdict, false);
        continue;
      }
      if (verdict.confidence < config.aiMinConfidence) {
        log.info('IA: conf %d < min %d - bloqueado. %s', verdict.confidence, config.aiMinConfidence, verdict.reasoning);
        this.api.sendSignal(signal, verdict, false);
        continue;
      }
      log.info('IA aprovou: conf=%d risk=%s - %s', verdict.confidence, verdict.risk, verdict.reasoning);
      this.api.sendSignal(signal, verdict, true);

      const entryPrice = this.feed.lastPrice;
      log.info('Preço de entrada: %s', entryPrice !== null ? entryPrice.toFixed(8) : 'n/a');
      const result = await this.trader!.execute(signal, decision.entryValue);

      // Envia trade para o frontend e captura o id gerado pelo banco
      const tradeResp = await this.api.sendTrade({
        sessionId: this.api.sessionId,
        direction: signal.direction,
        entryValue: decision.entryValue,
        expiration: config.expirationSeconds,
        score: signal.score,
        asset: config.asset,
        entryPrice,
        martingaleLevel: decision.martingaleLevel,
        patterns: signal.patterns,
        reasons: signal.reasons,
        aiApproved: true,
        aiConfidence: verdict.confidence,
        aiReasoning: verdict.reasoning,
        marketState,
      });
      const tradeId = typeof tradeResp === 'object' && tradeResp != null && 'tradeId' in tradeResp ? Number((tradeResp as { tradeId: number }).tradeId) : undefined;

      await this.awaitResult(result, entryPrice, signal.direction, tradeId);
    }
  }

  /**
   * Detecta WIN/LOSS comparando preço de entrada vs preço na expiração.
   * Método principal: não depende de saldo (que pode não chegar via WS).
   * CALL: WIN se exitPrice > entryPrice. PUT: WIN se exitPrice < entryPrice.
   */
  private async awaitResult(result: TradeResult, entryPrice: number | null, direction: 'CALL' | 'PUT', tradeId?: number): Promise<void> {
    if (result.status === 'ERROR') {
      this.risk.registerResult(result);
      return;
    }
    const waitMs = (config.expirationSeconds + 5) * 1000;
    log.info('Aguardando resultado (%ss)...', (waitMs / 1000).toFixed(1));
    await sleep(waitMs);

    const exitPrice = this.feed.lastPrice;

    if (entryPrice !== null && exitPrice !== null) {
      const diff = exitPrice - entryPrice;
      const absDiff = Math.abs(diff);
      // Tolerancia para empate: se diff for muito pequeno (< 0.5 tick), considera TIE
      const tieThreshold = 5e-8;
      if (absDiff < tieThreshold) {
        log.info('Preco: entrada=%s saida=%s diff=%s -> TIE (empate)', entryPrice.toFixed(8), exitPrice.toFixed(8), diff.toFixed(8));
        result.status = 'TIE';
        result.payout = 0;
      } else {
        const isWin = direction === 'CALL' ? diff > 0 : diff < 0;
        log.info('Preco: entrada=%s saida=%s diff=%s -> %s', entryPrice.toFixed(8), exitPrice.toFixed(8), diff.toFixed(8), isWin ? 'WIN' : 'LOSS');
        result.status = isWin ? 'WIN' : 'LOSS';
        this.ai.learn(isWin ? 'win' : 'loss');
        if (isWin) {
          result.payout = result.entryValue * 0.83; // payout estimado 83%
        }
      }
    } else {
      log.warn('Preço indisponível (entrada=%s saida=%s).', entryPrice, exitPrice);
      result.status = 'PENDING';
    }

    // Tenta ler saldo também (para tracking de banca real)
    const balanceAfter = this.feed.balance?.amount ?? await this.trader!.readBalance();
    if (balanceAfter !== null) {
      log.info('Saldo atual: %s', (balanceAfter / 100).toFixed(2));
      this.api.sendBalance(balanceAfter / 100, this.feed.balance?.currency ?? 'BRL');
    }

    this.risk.registerResult(result);
    const s = this.risk.stats();
    log.info('Banca: trades=%d perda=%s perdasConsec=%d', s.tradesToday, s.lossToday.toFixed(2), s.consecutiveLosses);

    // Envia resultado para o frontend
    this.api.sendResult({
      id: tradeId ?? 0,
      sessionId: this.api.sessionId,
      status: result.status,
      payout: result.payout ?? null,
      exitPrice,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.feed.close();
    await this.session.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
