import { config, updateConfig, type AppConfig } from './config.js';
import { service } from './logger.js';
import type { RunMode, Signal, TradeResult } from './types.js';
import { CandleFeed } from './data/CandleFeed.js';
import { BrowserSession } from './data/BrowserSession.js';
import { SignalEngine, type MarketSentiment, type CrowdStats } from './analysis/SignalEngine.js';
import type { HouseAnalytics } from './db/Database.js';
import { SessionFilter } from './analysis/SessionFilter.js';
import { Trader } from './execution/Trader.js';
import { RiskManager } from './risk/RiskManager.js';
import { Backtester, runBacktest } from './backtest/Backtester.js';
import { AIAdvisor } from './ai/AIAdvisor.js';
import { BotApiClient, type DiagnosticInfo } from './ai/BotApiClient.js';
import { AIStrategyManager } from './ai/AIStrategyManager.js';
import type { BotParams } from './ai/AIStrategyManager.js';
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
  private strategyManager!: AIStrategyManager;
  private trader?: Trader;
  private running = false;
  private lastSignalTime = 0;
  private csvPath = path.join(config.logsDir, 'candles.csv');
  private lastAnalyticsTime = 0;
  private analyticsIntervalMs = 60000;
  private pendingPostTrade: {
    direction: 'CALL' | 'PUT';
    win: boolean;
    martingaleLevel: number;
    entryValue: number;
    marketState: string;
    hour: number;
    score: number;
    patterns: string[];
    crowdAlignment?: string | null;
    nearMiss?: boolean;
    lateReversal?: boolean;
    resultMargin?: number | null;
  }[] = [];
  private lastPostTradeAnalysis = 0;
  private lastLoggedStrategyVersion = -1;
  // Contexto do ultimo trade para registro pos-trade
  private lastTradeContext: {
    patterns: string[];
    marketState: string;
    score: number;
    direction: 'CALL' | 'PUT';
    entryValue: number;
    atr: number;
    atrNormalized: number;
    crowdAlignment: string | null;
  } | null = null;
  // Padroes da banca: estatisticas de multidao em cache (alimentam o contrarian adaptativo)
  private lastCrowdStats: CrowdStats | null = null;
  private lastHouseNearMissRate = 0;

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

  /** Aplica parametros da estrategia da IA no config e subsystems */
  private applyStrategyParams(params?: BotParams): void {
    const p = params ?? this.strategyManager.getParams();
    if (p.expirationSeconds !== config.expirationSeconds) {
      updateConfig({ expirationSeconds: p.expirationSeconds });
      log.info('IA alterou expiracao para %ds', p.expirationSeconds);
    }
    if (p.minSignalScore !== config.minSignalScore) {
      updateConfig({ minSignalScore: p.minSignalScore });
      this.engine = new SignalEngine(p.minSignalScore);
      // Reaplica as estatisticas de multidao — engine novo perderia o modo adaptativo
      this.engine.setCrowdStats(this.lastCrowdStats, {
        minSamples: config.crowdContrarianMinSamples,
        edgePts: config.crowdContrarianEdgePts,
      });
      log.info('IA alterou score minimo para %d', p.minSignalScore);
    }
    if (p.martingaleLevels !== config.martingaleLevels || p.martingaleMultiplier !== config.martingaleMultiplier) {
      updateConfig({ martingaleLevels: p.martingaleLevels, martingaleMultiplier: p.martingaleMultiplier });
      this.risk = new RiskManager();
      log.info('IA alterou gales: %d niveis x%s', p.martingaleLevels, p.martingaleMultiplier);
    }
    if (p.cooldownSeconds !== config.cooldownSeconds) {
      updateConfig({ cooldownSeconds: p.cooldownSeconds });
      this.risk = new RiskManager();
      log.info('IA alterou cooldown para %ds', p.cooldownSeconds);
    }
    if (p.sessionStartHour !== config.sessionStartHour || p.sessionEndHour !== config.sessionEndHour) {
      updateConfig({ sessionStartHour: p.sessionStartHour, sessionEndHour: p.sessionEndHour });
      this.sessionFilter = new SessionFilter();
      log.info('IA alterou sessao para %dh-%dh', p.sessionStartHour, p.sessionEndHour);
    }
    updateConfig({ entryValue: p.entryValue });
  }

  /** Executa ciclo de otimizacao de estrategia via IA */
  private async runStrategyOptimization(): Promise<void> {
    if (!this.ai.stats().enabled) return;
    try {
      const analyticsRes = await fetch('http://localhost:3456/api/analytics', { signal: AbortSignal.timeout(5000) });
      const analyticsData = await analyticsRes.json();
      const parts: string[] = [];

      if (analyticsData.galeStats?.totalGales > 0) {
        const gs = analyticsData.galeStats;
        let dist = '';
        for (const [k, v] of Object.entries(gs.distribution)) dist += `${k.replace('nivel_', 'G')}=${v}, `;
        parts.push(`GALES: total=${gs.totalGales} media=${gs.avgLevel} ${dist}`);
      }
      if (analyticsData.hourlyPerformance?.length > 0) {
        const valid = analyticsData.hourlyPerformance.filter((h: { total: number }) => h.total >= 2);
        if (valid.length > 0) {
          const best = [...valid].sort((a: { winRate: number }, b: { winRate: number }) => b.winRate - a.winRate).slice(0, 3);
          const worst = [...valid].sort((a: { winRate: number }, b: { winRate: number }) => a.winRate - b.winRate).slice(0, 3);
          parts.push(`MELHORES: ${best.map((h: { hour: number; winRate: number; wins: number; total: number }) => `${h.hour}h=${h.winRate}%(${h.wins}W/${h.total})`).join(', ')}`);
          parts.push(`PIORES: ${worst.map((h: { hour: number; winRate: number; wins: number; total: number }) => `${h.hour}h=${h.winRate}%(${h.wins}W/${h.total})`).join(', ')}`);
        }
      }
      if (analyticsData.marketStateStats?.length > 0) {
        parts.push(`MERCADOS: ${analyticsData.marketStateStats.slice(0, 5).map((m: { state: string; winRate: number; total: number }) => `${m.state}=${m.winRate}%(${m.total}t)`).join(', ')}`);
      }

      const analyticsStr = parts.join('\n');
      const decision = await this.strategyManager.optimize(analyticsStr);

      if (decision) {
        this.applyStrategyParams(decision.paramsAfter);
        if (this.lastLoggedStrategyVersion !== decision.version) {
          this.lastLoggedStrategyVersion = decision.version;
          log.info('=== NOVA ESTRATEGIA v%d pela IA ===', decision.version);
          log.info('Motivo: %s', decision.reasoning);
          this.api.sendLog('info', 'IA', `alterou estrategia v${decision.version}: ${decision.reasoning}`);
          try {
            await fetch('http://localhost:3456/api/state/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ strategyVersion: decision.version, strategyReasoning: decision.reasoning }),
              signal: AbortSignal.timeout(2000),
            });
          } catch { /* nao critico */ }
        }
      }

      // Verificacao urgente de seguranca (3+ perdas consecutivas)
      if (this.strategyManager.needsUrgentReview()) {
        const consecLosses = this.strategyManager.getConsecutiveLosses();
        log.warn('%d PERDAS CONSECUTIVAS - IA fara analise de emergencia', consecLosses);
        this.api.sendLog('warn', 'IA', `ALERTA: ${consecLosses} perdas consecutivas`);
      }
    } catch (err) {
      log.debug('Otimizacao de estrategia indisponivel: %s', (err as Error).message);
    }
  }

  /** Envia lote de trades para analise pos-trade pela IA */
  private async runPostTradeAnalysis(): Promise<void> {
    if (!this.ai.stats().enabled || this.pendingPostTrade.length < 3) return;
    const batch = this.pendingPostTrade.splice(0);
    try {
      const analysis = await this.ai.analyzeTrades(batch);
      if (analysis && analysis.insights.length > 0) {
        log.info('=== APRENDIZADO POS-TRADE ===');
        for (const insight of analysis.insights) log.info('  Insight: %s', insight);
        if (analysis.avoidPatterns.length > 0) log.info('  Evitar: %s', analysis.avoidPatterns.join(', '));
        if (analysis.preferPatterns.length > 0) log.info('  Preferir: %s', analysis.preferPatterns.join(', '));
        this.api.sendLog('info', 'IA', `aprendizado: ${analysis.summary}`);
      }
    } catch (err) {
      log.warn('Falha na analise pos-trade: %s', (err as Error).message);
      this.pendingPostTrade.unshift(...batch);
    }
  }

  async run(mode: RunMode = config.mode): Promise<void> {
    // Carrega settings do banco ANTES de logar as configs
    await this.loadSettingsFromDb();
    this.strategyManager = new AIStrategyManager({
      suggestStrategy: (analytics, current, batch) => this.ai.suggestStrategy(analytics, current, batch),
    });
    this.applyStrategyParams();
    
    log.info('Iniciando bot no modo: %s | TF candle=%ds | exp=%ds | asset=%s', mode, config.candleTimeframeSeconds, config.expirationSeconds, config.asset);
    log.info('IA: %s | Score min: %d | Entrada: R$ %s | Gale: %d niveis (%sx)', config.aiEnabled ? 'ATIVA' : 'OFF', config.minSignalScore, config.entryValue.toFixed(2), config.martingaleLevels, config.martingaleMultiplier);

    if (mode === 'backtest') {
      await runBacktest();
      return;
    }

    // Diagnostico inicial
    this.sendDiag();

    const hasCredentials = !!(config.email && config.password);
    const manualLogin = !hasCredentials;

    if (manualLogin) {
      log.info('Sem credenciais BINOMO_EMAIL/BINOMO_PASSWORD. Modo manual: aguardando login via VNC...');
      await this.session.start(true);
      this.sendDiag();

      log.info('Aguardando login manual (URL: %s)', this.session.getPageInfoSync().url);
      this.api.sendWarmup(0, 30);

      const loggedIn = await this.session.waitForManualLogin(300000);
      if (!loggedIn) {
        log.warn('Login manual nao detectado apos 5min. Continuando mesmo assim...');
      } else {
        log.info('Login manual OK! Prosseguindo...');
      }
    } else {
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
    }

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
        hourlyGaleLevels: { hour: number; g1: number; g2: number; g3: number; g4: number; g5plus: number; totalGales: number; recovered: number; totalLoss: number }[];
        hourlyPerformance: { hour: number; wins: number; losses: number; total: number; winRate: number }[];
        marketStateStats: { state: string; wins: number; losses: number; total: number; winRate: number }[];
        house?: HouseAnalytics;
      };

      const parts: string[] = [];

      // === RESUMO GERAL DE GALES ===
      if (data.galeStats.totalGales > 0) {
        const gs = data.galeStats;
        let distStr = '';
        for (const [k, v] of Object.entries(gs.distribution)) {
          distStr += `${k.replace('nivel_', 'G')}=${v}, `;
        }
        parts.push(`GALES: total=${gs.totalGales} | media nivel=${gs.avgLevel} | ${distStr}`);
      }

      // === GALES POR HORA COM DETALHAMENTO DE NIVEL ===
      if (data.hourlyGaleLevels && data.hourlyGaleLevels.length > 0) {
        const hgl = data.hourlyGaleLevels;
        const topGaleHours = [...hgl]
          .sort((a, b) => b.totalGales - a.totalGales)
          .slice(0, 6);
        const galeByHour = topGaleHours.map((h) => {
          const levels: string[] = [];
          if (h.g1 > 0) levels.push(`G1:${h.g1}`);
          if (h.g2 > 0) levels.push(`G2:${h.g2}`);
          if (h.g3 > 0) levels.push(`G3:${h.g3}`);
          if (h.g4 > 0) levels.push(`G4:${h.g4}`);
          if (h.g5plus > 0) levels.push(`G5+:${h.g5plus}`);
          const recRate = h.totalGales > 0 ? ((h.recovered / h.totalGales) * 100).toFixed(0) : '0';
          return `${h.hour}h [${levels.join(' ')}] rec=${recRate}%`;
        }).join(' | ');
        parts.push(`GALE POR HORA: ${galeByHour}`);
      }

      // === PERFORMANCE POR HORA (WIN RATE) ===
      const valid = data.hourlyPerformance.filter((h) => h.total >= 2);
      if (valid.length > 0) {
        const best = [...valid].sort((a, b) => b.winRate - a.winRate).slice(0, 3);
        const worst = [...valid].sort((a, b) => a.winRate - b.winRate).slice(0, 3);
        parts.push(`MELHORES HORAS: ${best.map((h) => `${h.hour}h=${h.winRate}%(${h.wins}W/${h.total})`).join(', ')}`);
        if (worst.length > 0) {
          parts.push(`PIORES HORAS: ${worst.map((h) => `${h.hour}h=${h.winRate}%(${h.wins}W/${h.total})`).join(', ')}`);
        }
      }

      // === ESTADO DO MERCADO ===
      if (data.marketStateStats.length > 0) {
        const top = data.marketStateStats.slice(0, 5);
        parts.push(`MERCADOS: ${top.map((m) => `${m.state}=${m.winRate}%(${m.total}t)`).join(', ')}`);
      }

      // === PADROES DA BANCA (multidao, quase-ganhos, viradas finais) ===
      if (data.house) {
        const h = data.house;
        const withRow = h.crowdStats.find((c) => c.alignment === 'with_crowd');
        const againstRow = h.crowdStats.find((c) => c.alignment === 'against_crowd');
        const houseParts: string[] = [];
        if (withRow || againstRow) {
          houseParts.push(`contra multidao=${againstRow ? `${againstRow.winRate}%(${againstRow.total}t)` : 'n/a'} | a favor=${withRow ? `${withRow.winRate}%(${withRow.total}t)` : 'n/a'}`);
        }
        if (h.nearMiss.totalLossesTracked > 0) {
          houseParts.push(`quase-ganhou=${h.nearMiss.rate}% das perdas (${h.nearMiss.nearMissLosses}/${h.nearMiss.totalLossesTracked})`);
        }
        if (h.lateReversals.totalTracked > 0) {
          houseParts.push(`virada final=${h.lateReversals.rate}% (${h.lateReversals.count}/${h.lateReversals.totalTracked})`);
        }
        if (h.marginAsymmetry.avgWinMargin != null && h.marginAsymmetry.avgLossMargin != null) {
          houseParts.push(`margem media W/L=${(h.marginAsymmetry.avgWinMargin * 100).toFixed(5)}%/${(h.marginAsymmetry.avgLossMargin * 100).toFixed(5)}%`);
        }
        if (houseParts.length > 0) {
          parts.push(`PADROES DA BANCA: ${houseParts.join(' | ')}`);
        }
        if (h.nearMiss.totalLossesTracked >= 10 && h.nearMiss.rate > 40) {
          parts.push('ALERTA BANCA: mais de 40% das perdas foram por margem minima - evite entradas com volatilidade morta (movimento esperado pequeno)');
        }
        this.lastHouseNearMissRate = h.nearMiss.totalLossesTracked >= 10 ? h.nearMiss.rate : 0;

        // Alimenta o contrarian adaptativo do SignalEngine
        if (withRow && againstRow) {
          this.lastCrowdStats = {
            withCrowdWinRate: withRow.winRate,
            againstCrowdWinRate: againstRow.winRate,
            withCrowdSamples: withRow.total,
            againstCrowdSamples: againstRow.total,
          };
        } else {
          this.lastCrowdStats = null;
        }
        this.engine.setCrowdStats(this.lastCrowdStats, {
          minSamples: config.crowdContrarianMinSamples,
          edgePts: config.crowdContrarianEdgePts,
        });
      }

      if (parts.length > 0) {
        this.ai.setAnalytics(parts.join('\n'));
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
      const numKeys = ['entryValue', 'minSignalScore', 'expirationSeconds', 'candleTimeframeSeconds', 'martingaleLevels', 'martingaleMultiplier', 'cooldownSeconds', 'maxDailyTrades', 'maxDailyLoss', 'maxDailyProfit', 'sessionStartHour', 'sessionEndHour'] as const;
      const boolKeys = ['aiEnabled'] as const;
      const strKeys = ['asset', 'aiModel', 'aiEndpoint', 'aiApiKey'] as const;
      const partial: Partial<AppConfig> = {};
      for (const k of numKeys) {
        if (settings[k] != null) {
          const n = Number(settings[k]);
          if (Number.isFinite(n)) (partial as Record<string, number>)[k] = n;
        }
      }
      for (const k of boolKeys) {
        if (settings[k] != null) (partial as Record<string, boolean>)[k] = settings[k] === 'true' || settings[k] === '1';
      }
      for (const k of strKeys) {
        if (settings[k] != null && settings[k] !== '') (partial as Record<string, string>)[k] = settings[k];
      }
      updateConfig(partial);
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
    // Primeira otimizacao de estrategia
    if (this.ai.stats().enabled) {
      await this.runStrategyOptimization();
    }

    let warmupMsg = false;
    let lastProgressLog = 0;
    let warmupStart = Date.now();
    let sessionLoggedThisCycle = false;
    let lastSignalLog = 0;
    let lastStrategyCycle = 0;
    let lastPostTradeCycle = 0;
    let lastRecoveryAttempt = 0;
    let recoveryAttempts = 0;
    let lastKnownCandleCount = 0;
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

      // Ciclos periodicos da IA autonomia
      if (Date.now() - this.lastAnalyticsTime > this.analyticsIntervalMs) {
        this.lastAnalyticsTime = Date.now();
        await this.refreshAnalytics();
      }
      if (this.ai.stats().enabled && this.strategyManager.shouldOptimize() && Date.now() - lastStrategyCycle > 120000) {
        lastStrategyCycle = Date.now();
        await this.runStrategyOptimization();
      }
      if (this.ai.stats().enabled && this.pendingPostTrade.length >= 3 && Date.now() - lastPostTradeCycle > 300000) {
        lastPostTradeCycle = Date.now();
        await this.runPostTradeAnalysis();
      }

      const candleCount = this.feed.getCandles().length;

      // Reseta o contador de recuperacao sempre que o feed avanca (novo candle produzido)
      if (candleCount > lastKnownCandleCount) {
        lastKnownCandleCount = candleCount;
        recoveryAttempts = 0;
      }

      // Diagnostico: feed sem ticks novos ha muito tempo. IMPORTANTE: usa lastTickTime
      // (nao candleCount===0), pois o feed pode travar depois de ja ter produzido
      // alguns candles (ex: fica em "3/30" para sempre) — nesse caso candleCount nunca
      // volta a 0 e a recuperacao antiga nunca disparava.
      const msSinceLastTick = this.feed.lastTickTime !== null ? Date.now() - this.feed.lastTickTime : Date.now() - warmupStart;
      if (msSinceLastTick > 60000 && Date.now() - lastRecoveryAttempt > 60000) {
        lastRecoveryAttempt = Date.now();
        recoveryAttempts++;
        log.warn('Feed sem ticks novos ha %ss (candles=%d). Tentativa de recuperacao #%d...', (msSinceLastTick / 1000).toFixed(0), candleCount, recoveryAttempts);
        if (recoveryAttempts >= 3) {
          log.warn('Recuperacao leve falhou %d vezes seguidas. Recarregando a pagina...', recoveryAttempts);
          await this.session.getPage().reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
            .then(() => sleep(3000))
            .catch((err) => log.warn('Falha ao recarregar pagina: %s', (err as Error).message));
          recoveryAttempts = 0;
        }
        await this.session.selectAsset(config.asset).catch(() => {});
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
      // Constrói contexto de tendência ANTES de chamar RiskManager
      const trendCtx = trendBias(candles);
      const indCtx = this.engine.getContext(candles);
      // Estado de mercado unificado (usado no risk, no banco e no pos-trade)
      const adxState = indCtx.adx >= 25 ? 'trending' : indCtx.adx < 20 ? 'ranging' : 'transition';
      const volState = indCtx.atrNormalized > 0.001 ? 'volatile' : 'calm';
      const marketState = `${adxState}_${trendCtx.direction}_${volState}`;

      // Guarda opcional de padrao da banca: com alta taxa de "quase-ganhou",
      // evita entradas em volatilidade morta (resultado decidido por um fio)
      if (config.houseMinAtrNormalized > 0
        && this.lastHouseNearMissRate > 40
        && indCtx.atrNormalized < config.houseMinAtrNormalized) {
        log.info('Bloqueado por padrao da banca: volatilidade morta (ATR %s < %s) com %d%% de quase-ganhos', indCtx.atrNormalized.toExponential(2), config.houseMinAtrNormalized.toExponential(2), this.lastHouseNearMissRate);
        this.api.sendSignal(signal, null, false);
        continue;
      }

      const tradeDecision = this.risk.canTrade(signal.direction, signal.score, {
        trend: trendCtx,
        adx: indCtx.adx,
        patterns: signal.patterns,
        marketState,
      });
      if (!tradeDecision.allowed) {
        log.info('Trade bloqueado: %s', tradeDecision.reason);
        this.api.sendSignal(signal, null, false);
        continue;
      }

      const aiContext = {
        trend: trendCtx,
        sentiment: this.getSentiment(),
        patterns: signal.patterns,
        indicators: indCtx,
      };
      const verdict = await this.ai.validate(signal, candles, aiContext);
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

      // Snapshot da multidao no momento da entrada (padroes da banca).
      // So vale se o sentimento for fresco (<120s) — leituras velhas viram null.
      let sentimentCall: number | null = null;
      let sentimentPut: number | null = null;
      let crowdAlignment: string | null = null;
      let bigBetsWithPct: number | null = null;
      const sent = this.feed.sentiment;
      if (sent && this.feed.sentimentTs !== null && Date.now() - this.feed.sentimentTs < 120000) {
        const totalSent = sent.call + sent.put;
        if (totalSent > 0) {
          sentimentCall = sent.call;
          sentimentPut = sent.put;
          const callPct = sent.call / totalSent;
          const majority = callPct >= 0.6 ? 'CALL' : callPct <= 0.4 ? 'PUT' : null;
          crowdAlignment = majority === null ? 'neutral' : majority === signal.direction ? 'with_crowd' : 'against_crowd';
        }
      }
      const deals = this.feed.recentDeals.slice(-10);
      if (deals.length >= 5) {
        const totalBets = deals.reduce((s, d) => s + d.bet, 0);
        if (totalBets > 0) {
          const withBets = deals.filter((d) => d.direction === signal.direction).reduce((s, d) => s + d.bet, 0);
          bigBetsWithPct = withBets / totalBets;
        }
      }

      // Salva contexto do trade para analise pos-trade
      this.lastTradeContext = {
        patterns: signal.patterns,
        marketState,
        score: signal.score,
        direction: signal.direction,
        entryValue: tradeDecision.entryValue,
        atr: indCtx.atr,
        atrNormalized: indCtx.atrNormalized,
        crowdAlignment,
      };

      const result = await this.trader!.execute(signal, tradeDecision.entryValue);

      // Envia trade para o frontend e captura o id gerado pelo banco
      const tradeResp = await this.api.sendTrade({
        sessionId: this.api.sessionId,
        direction: signal.direction,
        entryValue: tradeDecision.entryValue,
        expiration: config.expirationSeconds,
        score: signal.score,
        asset: config.asset,
        entryPrice,
        martingaleLevel: tradeDecision.martingaleLevel,
        patterns: signal.patterns,
        reasons: signal.reasons,
        aiApproved: true,
        aiConfidence: verdict.confidence,
        aiReasoning: verdict.reasoning,
        marketState,
        sentimentCall,
        sentimentPut,
        crowdAlignment,
        bigBetsWithPct,
        indicators: {
          rsi: indCtx.rsi,
          adx: indCtx.adx,
          atrNormalized: indCtx.atrNormalized,
          macdHist: indCtx.macdHist,
          stochK: indCtx.stochasticK,
          bbPosition: indCtx.bbPosition,
        },
      });
      const tradeId = typeof tradeResp === 'object' && tradeResp != null && 'tradeId' in tradeResp ? Number((tradeResp as { tradeId: number }).tradeId) : undefined;

      await this.awaitResult(result, entryPrice, signal.direction, tradeId);
    }
  }

  /**
   * Detecta WIN/LOSS comparando preço de entrada vs preço na expiração.
   * Método principal: não depende de saldo (que pode não chegar via WS).
   * CALL: WIN se exitPrice > entryPrice. PUT: WIN se exitPrice < entryPrice.
   *
   * LIMITAÇÃO CONHECIDA: isto é uma APROXIMAÇÃO via último tick recebido pelo WebSocket,
   * não o resultado oficial retornado pela Binomo. Pode divergir em casos raros de
   * spread/timing sub-segundo. Mantido assim por decisão consciente (ver plano de correções).
   */
  private async awaitResult(result: TradeResult, entryPrice: number | null, direction: 'CALL' | 'PUT', tradeId?: number): Promise<void> {
    if (result.status === 'ERROR') {
      this.risk.registerResult(result);
      return;
    }
    const waitMs = (config.expirationSeconds + 5) * 1000;
    log.info('Aguardando resultado (%ss)...', (waitMs / 1000).toFixed(1));
    // Sleep dividido: amostra o preco ~2s antes da expiracao (deteccao de virada final).
    // A espera total permanece exp+5s.
    const t2Ms = Math.max(0, (config.expirationSeconds - 2) * 1000);
    await sleep(t2Ms);
    const priceT2 = this.feed.lastPrice;
    await sleep(waitMs - t2Ms);

    const exitPrice = this.feed.lastPrice;
    const tieThreshold = 5e-8;

    if (entryPrice !== null && exitPrice !== null) {
      const diff = exitPrice - entryPrice;
      const absDiff = Math.abs(diff);
      // Tolerancia para empate: se diff for muito pequeno (< 0.5 tick), considera TIE
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
          result.payout = result.entryValue * config.payoutPercent;
        }
      }
    } else {
      log.warn('Preço indisponível (entrada=%s saida=%s).', entryPrice, exitPrice);
      result.status = 'PENDING';
    }

    // === Padroes da banca: margem do resultado, quase-ganhou e virada final ===
    let resultMargin: number | null = null;
    let nearMiss: 0 | 1 | null = null;
    let lateReversal: 0 | 1 | null = null;
    if (entryPrice !== null && exitPrice !== null && (result.status === 'WIN' || result.status === 'LOSS')) {
      const absDiff = Math.abs(exitPrice - entryPrice);
      resultMargin = absDiff / entryPrice;
      const atrEntry = this.lastTradeContext?.atr ?? 0;
      if (atrEntry > 0) {
        nearMiss = result.status === 'LOSS' && absDiff < config.houseNearMissAtr * atrEntry ? 1 : 0;
      }
      if (priceT2 !== null && Math.abs(priceT2 - entryPrice) >= tieThreshold) {
        const winningAtT2 = direction === 'CALL' ? priceT2 > entryPrice : priceT2 < entryPrice;
        lateReversal = winningAtT2 !== (result.status === 'WIN') ? 1 : 0;
      }
      if (nearMiss === 1 || lateReversal === 1) {
        log.warn('Padrao banca: margem=%s quaseGanhou=%s viradaFinal=%s', resultMargin.toExponential(3), nearMiss === 1 ? 'SIM' : 'nao', lateReversal === 1 ? 'SIM' : 'nao');
      }
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

    // Registra no strategy manager (aprendizado autonomo)
    const isWin = result.status === 'WIN';
    const ctx = this.lastTradeContext;
    this.strategyManager.recordTrade(
      direction,
      isWin,
      result.status === 'LOSS' ? (this.risk.stats().consecutiveLosses) : 0,
      result.entryValue,
      ctx?.marketState ?? 'unknown',
      new Date().getUTCHours(),
      ctx?.score ?? 0,
      ctx?.patterns ?? []
    );
    // Enfileira para analise pos-trade em lote
    if (ctx) {
      this.pendingPostTrade.push({
        direction,
        win: isWin,
        martingaleLevel: result.status === 'LOSS' ? (this.risk.stats().consecutiveLosses) : 0,
        entryValue: result.entryValue,
        marketState: ctx.marketState,
        hour: new Date().getUTCHours(),
        score: ctx.score,
        patterns: ctx.patterns,
        crowdAlignment: ctx.crowdAlignment,
        nearMiss: nearMiss === 1,
        lateReversal: lateReversal === 1,
        resultMargin,
      });
    }

    // Envia resultado para o frontend
    this.api.sendResult({
      id: tradeId ?? 0,
      sessionId: this.api.sessionId,
      status: result.status,
      payout: result.payout ?? null,
      exitPrice,
      entryValue: result.entryValue,
      resultMargin,
      priceT2,
      lateReversal,
      nearMiss,
    });

    // Log periodico de performance da estrategia atual
    if (this.strategyManager.getTradeCount() % 10 === 0 && this.strategyManager.getTradeCount() > 0) {
      log.info('[IA ESTRATEGIA v%d] %s', this.strategyManager.getVersion(), this.strategyManager.formatPerfForPrompt());
    }
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
