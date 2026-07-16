import { config } from '../config.js';
import { service } from '../logger.js';
import type { Direction, TradeResult } from '../types.js';

const log = service('RiskManager');

export interface RiskDecision {
  allowed: boolean;
  reason: string;
  entryValue: number;
  martingaleLevel: number;
  martingaleAccumulated: number;
}

export interface TradeContext {
  trend: { direction: Direction; strength: number };
  adx: number;
  patterns: string[];
  marketState: string;
}

/**
 * Gestao de banca: limites diarios, stop-loss, cooldown progressivo e martingale.
 */
export class RiskManager {
  private tradesToday = 0;
  private lossToday = 0;
  private profitToday = 0;
  private consecutiveLosses = 0;
  private lastTradeAt = 0;
  private dayKey = this.todayKey();
  private martingaleAccumulated = 0;

  canTrade(direction: Direction, signalScore = 80, tradeCtx?: TradeContext): RiskDecision {
    this.rolloverIfNeeded();

    if (this.tradesToday >= config.maxDailyTrades) {
      return { allowed: false, reason: 'limite diario de trades atingido', entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0 };
    }
    if (this.lossToday >= config.maxDailyLoss) {
      return { allowed: false, reason: 'stop-loss diario atingido - pare por hoje', entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0 };
    }

    const profitTarget = config.maxDailyProfit;
    if (profitTarget > 0 && this.profitToday >= profitTarget) {
      return { allowed: false, reason: `take-profit diario atingido (R$ ${this.profitToday.toFixed(2)} / ${profitTarget.toFixed(2)})`, entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0 };
    }

    // Filtro de tendencia: nao opera contra tendencia forte
    if (tradeCtx && tradeCtx.trend.strength > 0.25 && tradeCtx.adx >= 25) {
      if (direction !== tradeCtx.trend.direction) {
        return {
          allowed: false,
          reason: `CONTRA TENDENCIA bloqueado: sinal ${direction} vs tendencia ${tradeCtx.trend.direction} (forca ${tradeCtx.trend.strength.toFixed(2)}, ADX ${tradeCtx.adx})`,
          entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0,
        };
      }
    }

    const dynamicCooldown = this.getDynamicCooldown();
    const elapsed = (Date.now() - this.lastTradeAt) / 1000;
    if (this.lastTradeAt > 0 && elapsed < dynamicCooldown) {
      return {
        allowed: false,
        reason: `cooldown: aguarde ${(dynamicCooldown - elapsed).toFixed(0)}s (${this.consecutiveLosses} perdas consec)`,
        entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0,
      };
    }

    const mgLevel = Math.min(this.consecutiveLosses, config.martingaleLevels);

    let entry = config.entryValue;
    if (mgLevel > 0) {
      entry = Math.round(config.entryValue * Math.pow(config.martingaleMultiplier, mgLevel));
      this.martingaleAccumulated += entry;
      log.warn('GALE nivel %d: entrada R$ %s | acumulado: R$ %s', mgLevel, entry.toFixed(2), this.martingaleAccumulated.toFixed(2));
    } else {
      this.martingaleAccumulated = entry;
    }

    if (this.consecutiveLosses > config.martingaleLevels) {
      log.error('Gale maximo (%d) excedido. Resetando. Perda acumulada: R$ %s', config.martingaleLevels, this.martingaleAccumulated.toFixed(2));
      this.consecutiveLosses = 0;
      this.martingaleAccumulated = 0;
      return {
        allowed: false,
        reason: `Gale maximo excedido (${config.martingaleLevels} niveis). Reset.`,
        entryValue: 0, martingaleLevel: 0, martingaleAccumulated: 0,
      };
    }

    return {
      allowed: true,
      reason: mgLevel > 0 ? `Gale ${mgLevel} (entrada R$ ${entry.toFixed(2)})` : `OK (R$ ${entry.toFixed(2)})`,
      entryValue: entry,
      martingaleLevel: mgLevel,
      martingaleAccumulated: this.martingaleAccumulated,
    };
  }

  /**
   * Cooldown progressivo: apos cada perda consecutiva, dobra o cooldown.
   * 0 perdas: 15s, 1: 30s, 2: 60s, 3: 120s, etc (cap 300s).
   */
  private getDynamicCooldown(): number {
    if (this.consecutiveLosses === 0) return config.cooldownSeconds;
    const dynamic = config.cooldownSeconds * Math.pow(2, this.consecutiveLosses);
    return Math.min(dynamic, 300);
  }

  registerResult(result: TradeResult): void {
    this.tradesToday++;
    this.lastTradeAt = Date.now();
    if (result.status === 'WIN') {
      if (this.consecutiveLosses > 0) {
        log.info('WIN no Gale %d! Recuperacao: R$ %s (entrada R$ %s)', this.consecutiveLosses, (result.payout ?? 0).toFixed(2), result.entryValue.toFixed(2));
      }
      this.consecutiveLosses = 0;
      this.martingaleAccumulated = 0;
      this.profitToday += result.payout ?? 0;
      this.lossToday -= Math.min(this.lossToday, result.entryValue);
    } else if (result.status === 'LOSS') {
      this.consecutiveLosses++;
      this.lossToday += result.entryValue;
      const remaining = config.martingaleLevels - this.consecutiveLosses;
      if (remaining > 0) {
        const nextEntry = config.entryValue * Math.pow(config.martingaleMultiplier, this.consecutiveLosses);
        log.warn('LOSS - proxima entrada: Gale %d = R$ %s (tentativas restantes: %d, cooldown %ds)', this.consecutiveLosses, nextEntry.toFixed(2), remaining, this.getDynamicCooldown());
      } else {
        log.error('LOSS - Gale maximo atingido! Perda total da sequencia: R$ %s', this.martingaleAccumulated.toFixed(2));
      }
    } else if (result.status === 'TIE') {
      // Empate: nao conta como perda nem vitoria, reset cooldown
      log.info('TIE - empate. Sem alteracao na banca.');
    }
    log.info(
      'Resultado: %s | trades hoje: %d | perda hoje: R$ %s | lucro hoje: R$ %s | perdas consec: %d',
      result.status,
      this.tradesToday,
      this.lossToday.toFixed(2),
      this.profitToday.toFixed(2),
      this.consecutiveLosses
    );
  }

  stats(): { tradesToday: number; lossToday: number; consecutiveLosses: number; martingaleAccumulated: number; profitToday: number } {
    return { tradesToday: this.tradesToday, lossToday: this.lossToday, consecutiveLosses: this.consecutiveLosses, martingaleAccumulated: this.martingaleAccumulated, profitToday: this.profitToday };
  }

  private rolloverIfNeeded(): void {
    const today = this.todayKey();
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.tradesToday = 0;
      this.lossToday = 0;
      this.profitToday = 0;
      this.consecutiveLosses = 0;
      this.martingaleAccumulated = 0;
      log.info('Novo dia - contadores resetados.');
    }
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
