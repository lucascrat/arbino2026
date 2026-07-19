import { config } from '../config.js';
import { service } from '../logger.js';
import type { Direction } from '../types.js';

const log = service('AIStrategy');

export interface BotParams {
  expirationSeconds: number;
  sessionStartHour: number;
  sessionEndHour: number;
  minSignalScore: number;
  martingaleLevels: number;
  martingaleMultiplier: number;
  cooldownSeconds: number;
  entryValue: number;
}

export interface StrategyDecision {
  version: number;
  timestamp: number;
  paramsBefore: BotParams;
  paramsAfter: BotParams;
  reasoning: string;
  performanceBefore: StrategyPerf | null;
}

export interface StrategyPerf {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  galeRate: number;
  avgGaleLevel: number;
  netProfit: number;
}

export interface StrategySuggestion {
  changes: Partial<BotParams>;
  reasoning: string;
  confidence: number;
}

export class AIStrategyManager {
  private currentParams: BotParams;
  private version = 0;
  private tradeBuffer: {
    direction: Direction;
    win: boolean;
    martingaleLevel: number;
    entryValue: number;
    marketState: string;
    hour: number;
    score: number;
    patterns: string[];
    timestamp: number;
  }[] = [];
  private optimizationInterval = 25;
  private lastOptimizationTradeCount = 0;
  private consecutiveLosses = 0;
  private readonly ai: { suggestStrategy: (analytics: string, currentStrategy: string, recentBatch: string) => Promise<StrategySuggestion> };

  constructor(aiWrapper: { suggestStrategy: (analytics: string, currentStrategy: string, recentBatch: string) => Promise<StrategySuggestion> }) {
    this.ai = aiWrapper;
    this.currentParams = {
      expirationSeconds: config.expirationSeconds,
      sessionStartHour: config.sessionStartHour ?? 0,
      sessionEndHour: config.sessionEndHour ?? 23,
      minSignalScore: config.minSignalScore,
      martingaleLevels: config.martingaleLevels,
      martingaleMultiplier: config.martingaleMultiplier,
      cooldownSeconds: config.cooldownSeconds,
      entryValue: Math.max(5, config.entryValue),
    };
    log.info('StrategyManager iniciado: exp=%ds score=%d gales=%d', this.currentParams.expirationSeconds, this.currentParams.minSignalScore, this.currentParams.martingaleLevels);
  }

  getParams(): BotParams {
    return { ...this.currentParams };
  }

  getVersion(): number {
    return this.version;
  }

  getTradeCount(): number {
    return this.tradeBuffer.length;
  }

  getRecentTrades(n: number): typeof this.tradeBuffer {
    return this.tradeBuffer.slice(-n);
  }

  recordTrade(direction: Direction, win: boolean, martingaleLevel: number, entryValue: number, marketState: string, hour: number, score: number, patterns: string[]): void {
    this.tradeBuffer.push({ direction, win, martingaleLevel, entryValue, marketState, hour, score, patterns, timestamp: Date.now() });
    if (win) this.consecutiveLosses = 0;
    else this.consecutiveLosses++;
  }

  private computePerf(trades: typeof this.tradeBuffer): StrategyPerf {
    if (trades.length === 0) return { trades: 0, wins: 0, losses: 0, winRate: 0, galeRate: 0, avgGaleLevel: 0, netProfit: 0 };
    const wins = trades.filter(t => t.win).length;
    const losses = trades.filter(t => !t.win).length;
    const total = wins + losses;
    const galeTrades = trades.filter(t => t.martingaleLevel > 0);
    const netProfit = trades.reduce((acc, t) => acc + (t.win ? t.entryValue * 0.83 : -t.entryValue), 0);
    return {
      trades: total,
      wins,
      losses,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      galeRate: total > 0 ? (galeTrades.length / total) * 100 : 0,
      avgGaleLevel: galeTrades.length > 0 ? galeTrades.reduce((s, t) => s + t.martingaleLevel, 0) / galeTrades.length : 0,
      netProfit,
    };
  }

  shouldOptimize(): boolean {
    const tradeDiff = this.tradeBuffer.length - this.lastOptimizationTradeCount;
    return tradeDiff >= this.optimizationInterval && this.tradeBuffer.length >= this.optimizationInterval;
  }

  private buildStrategyString(params: BotParams): string {
    return `exp=${params.expirationSeconds}s session=${params.sessionStartHour}h-${params.sessionEndHour}h scoreMin=${params.minSignalScore} gales=${params.martingaleLevels}x${params.martingaleMultiplier.toFixed(1)} cooldown=${params.cooldownSeconds}s entry=R$${params.entryValue.toFixed(2)}`;
  }

  private buildRecentBatchString(): string {
    const batch = this.tradeBuffer.slice(-this.optimizationInterval);
    if (batch.length === 0) return '';
    const wins = batch.filter(t => t.win).length;
    const losses = batch.filter(t => !t.win).length;
    const lines = batch.map(t => `  ${t.direction} ${t.win ? 'WIN' : 'LOSS'} gale=${t.martingaleLevel} score=${t.score} [${t.patterns.slice(0, 2).join(',')}] estado=${t.marketState} hora=${t.hour}h valor=R$${t.entryValue.toFixed(2)}`);
    return `## Ultimos ${batch.length} trades (${wins}W/${losses}L)\n${lines.join('\n')}`;
  }

  async optimize(analyticsSummary: string): Promise<StrategyDecision | null> {
    if (!this.shouldOptimize()) return null;
    this.lastOptimizationTradeCount = this.tradeBuffer.length;

    const perf = this.computePerf(this.tradeBuffer);
    const currentStr = this.buildStrategyString(this.currentParams);
    const recentBatch = this.buildRecentBatchString();

    log.info('Iniciando otimizacao de estrategia (versao %d, winRate=%.1f%%)', this.version, perf.winRate);

    try {
      const suggestion = await this.ai.suggestStrategy(analyticsSummary, currentStr, recentBatch);
      if (!suggestion.changes || Object.keys(suggestion.changes).length === 0) {
        log.info('IA sugeriu manter parametros atuais');
        return null;
      }

      const oldParams = { ...this.currentParams };
      const newParams: BotParams = {
        ...this.currentParams,
        ...this.sanitizeChanges(suggestion.changes),
        entryValue: 5,
      };

      this.version++;
      this.currentParams = newParams;
      const decision: StrategyDecision = {
        version: this.version,
        timestamp: Date.now(),
        paramsBefore: oldParams,
        paramsAfter: newParams,
        reasoning: suggestion.reasoning,
        performanceBefore: perf,
      };

      log.info('ESTRATEGIA ATUALIZADA: %s -> %s', this.buildStrategyString(oldParams), this.buildStrategyString(newParams));
      log.info('Motivo: %s', suggestion.reasoning);

      return decision;
    } catch (err) {
      log.warn('Falha na otimizacao: %s', (err as Error).message);
      return null;
    }
  }

  private sanitizeChanges(changes: Partial<BotParams>): Partial<BotParams> {
    const out: Partial<BotParams> = {};
    if (changes.expirationSeconds != null) out.expirationSeconds = Math.max(15, Math.min(300, Math.round(changes.expirationSeconds)));
    if (changes.sessionStartHour != null) out.sessionStartHour = Math.max(0, Math.min(23, Math.round(changes.sessionStartHour)));
    if (changes.sessionEndHour != null) out.sessionEndHour = Math.max(0, Math.min(23, Math.round(changes.sessionEndHour)));
    if (changes.minSignalScore != null) out.minSignalScore = Math.max(50, Math.min(100, Math.round(changes.minSignalScore)));
    if (changes.martingaleLevels != null) out.martingaleLevels = Math.max(1, Math.min(10, Math.round(changes.martingaleLevels)));
    if (changes.martingaleMultiplier != null) out.martingaleMultiplier = Math.max(1.5, Math.min(4, Math.round(changes.martingaleMultiplier * 10) / 10));
    if (changes.cooldownSeconds != null) out.cooldownSeconds = Math.max(5, Math.min(300, Math.round(changes.cooldownSeconds)));
    return out;
  }

  formatPerfForPrompt(): string {
    const batch = this.tradeBuffer;
    if (batch.length === 0) return 'Sem trades registrados';
    const recent = batch.slice(-10);
    const byHour = new Map<number, { w: number; l: number }>();
    for (const t of batch) {
      const h = t.hour;
      const cur = byHour.get(h) || { w: 0, l: 0 };
      if (t.win) cur.w++; else cur.l++;
      byHour.set(h, cur);
    }
    const hours = [...byHour.entries()].map(([h, d]) => `${h}h:${d.w}W/${d.l}L`).join(' ');
    const recentStr = recent.map(t => `${t.direction} ${t.win ? 'W' : 'L'}${t.martingaleLevel > 0 ? ` G${t.martingaleLevel}` : ''}`).join(' ');
    const perf = this.computePerf(batch);
    return `[${perf.wins}W/${perf.losses}L winRate=${perf.winRate.toFixed(0)}% lucro=R$${perf.netProfit.toFixed(2)} gales=${perf.galeRate.toFixed(0)}%] Horas:${hours} Recentes:${recentStr}`;
  }

  needsUrgentReview(): boolean {
    if (this.consecutiveLosses >= 3) return true;
    const recent = this.tradeBuffer.slice(-5);
    const losses = recent.filter(t => !t.win).length;
    return losses >= 4;
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }
}
