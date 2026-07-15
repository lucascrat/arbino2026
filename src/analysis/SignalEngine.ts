import type { Candle, Direction, Signal } from '../types.js';
import { detectPatterns, trendBias, type PatternMatch } from './CandlePatterns.js';
import { findLevels, levelConfluence } from './SupportResistance.js';
import {
  rsiSignal, bollingerSignal, emaCrossover, momentum,
  atrSignal, adx, macd, stochastic,
  rsi, bollingerBands,
} from './Indicators.js';

export interface MarketSentiment {
  call: number;
  put: number;
  recentDeals?: { direction: Direction; bet: number }[];
}

export interface SignalContext {
  rsi: number;
  atr: number;
  atrNormalized: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  macdHist: number;
  stochasticK: number;
  bbPosition: number;
  srLevel: number | null;
  srDistance: number | null;
}

/**
 * Engine de confluencia multi-indicador.
 *
 * Combina 10 fontes de evidencia:
 * 1. Padroes de candle (pinbar, engolfo, estrela, etc)
 * 2. Tendencia (EMA9 vs EMA21)
 * 3. Suporte/Resistencia (pivos)
 * 4. RSI (sobrecompra/sobrevenda)
 * 5. Bollinger Bands (bounce/breakout)
 * 6. EMA Crossover (cruzamento de medias)
 * 7. Momentum
 * 8. MACD (cruzamento + histograma)
 * 9. Stochastic (sobrecompra/sobrevenda + cruzamento)
 * 10. Sentimento de mercado (contrarian)
 *
 * Usa ATR para dimensionar tolerancias e ADX para selecionar estrategia
 * (trend-following vs mean-reversion).
 *
 * Exige ALINHAMENTO de pelo menos 3 fontes (alem do padrao).
 */
export class SignalEngine {
  private readonly minAlignedSources: number;

  constructor(private readonly minScore: number, minAlignedSources = 2) {
    this.minAlignedSources = minAlignedSources;
  }

  evaluate(candles: Candle[], sentiment?: MarketSentiment | null): Signal | null {
    if (candles.length < 30) return null;

    // Coleta todos os indicadores
    const patterns = detectPatterns(candles);
    const trend = trendBias(candles);
    const levels = findLevels(candles);
    const level = levelConfluence(candles, levels);
    const rsi = rsiSignal(candles, 14);
    const bb = bollingerSignal(candles, 20, 2);
    const cross = emaCrossover(candles, 9, 21);
    const mom = momentum(candles, 10);
    const atrS = atrSignal(candles, 14);
    const adxVal = adx(candles, 14);
    const macdVal = macd(candles, 12, 26, 9);
    const stoch = stochastic(candles, 14, 3);

    // Padroes de candle sao necessarios (pelo menos 1)
    if (patterns.length === 0) return null;

    // Aplica contexto S/R nos padroes (pinbar no suporte = mais forte)
    const contextualPatterns = this.applyPatternContext(patterns, level, atrS.value);

    let callScore = 0;
    let putScore = 0;
    const reasons: string[] = [];
    const patternNames: string[] = [];
    let alignedSources = 0;

    // 1. Padroes de candle (com contexto S/R aplicado)
    for (const p of contextualPatterns) {
      patternNames.push(p.name);
      reasons.push(`padrao ${p.name} (${p.direction}, forca ${p.strength.toFixed(2)})${p.note ? ' - ' + p.note : ''}`);
      if (p.direction === 'CALL') callScore += p.strength;
      else putScore += p.strength;
    }

    const dominant: Direction = callScore >= putScore ? 'CALL' : 'PUT';

    // Determina estrategia baseada em ADX
    const isTrending = adxVal.trendStrength === 'strong';
    const isRanging = adxVal.trendStrength === 'weak';

    // 2. Tendencia (peso alto em mercado trending)
    const trendWeight = isTrending ? 1.2 : isRanging ? 0.5 : 0.8;
    if (trend.strength > 0.15) {
      reasons.push(`tendencia ${trend.direction} (forca ${trend.strength.toFixed(2)})`);
      if (trend.direction === dominant) {
        if (dominant === 'CALL') callScore += trend.strength * trendWeight;
        else putScore += trend.strength * trendWeight;
        alignedSources++;
      } else {
        const domPattern = strongestPattern(contextualPatterns);
        if (domPattern && domPattern.strength >= 0.8 && !isTrending) {
          if (dominant === 'CALL') callScore += trend.strength * 0.3;
          else putScore += trend.strength * 0.3;
          reasons.push('reversao forte contra tendencia - permitida com peso reduzido');
        } else {
          if (dominant === 'CALL') callScore *= 0.3;
          else putScore *= 0.3;
          reasons.push('reversao fraca contra tendencia - penalizado');
        }
      }
    }

    // 3. Suporte/Resistencia (peso maior em ranging)
    const srWeight = isRanging ? 0.7 : 0.5;
    if (level.direction) {
      reasons.push(`S/R ${level.direction}${level.note ? ' (' + level.note + ')' : ''}`);
      if (level.direction === dominant && level.direction === trend.direction) {
        if (dominant === 'CALL') callScore += level.strength * srWeight;
        else putScore += level.strength * srWeight;
        alignedSources++;
      } else if (level.direction !== trend.direction && trend.strength > 0.3) {
        reasons.push('S/R contra tendencia forte - ignorado');
      } else if (level.direction === dominant) {
        if (dominant === 'CALL') callScore += level.strength * 0.3;
        else putScore += level.strength * 0.3;
        alignedSources++;
      }
    }

    // 4. RSI (peso maior em ranging - mean reversion)
    const rsiWeight = isRanging ? 0.8 : 0.6;
    if (rsi.direction) {
      reasons.push(`RSI ${rsi.value.toFixed(0)} -> ${rsi.direction} (${rsi.note})`);
      if (rsi.direction === dominant) {
        if (dominant === 'CALL') callScore += rsi.strength * rsiWeight;
        else putScore += rsi.strength * rsiWeight;
        alignedSources++;
      } else {
        if (dominant === 'CALL') callScore *= 0.7;
        else putScore *= 0.7;
        reasons.push('RSI contra o sinal - penalizado');
      }
    }

    // 5. Bollinger Bands
    if (bb.direction) {
      reasons.push(`BB ${bb.direction} (${bb.note})`);
      if (bb.direction === dominant) {
        if (dominant === 'CALL') callScore += bb.strength * 0.6;
        else putScore += bb.strength * 0.6;
        alignedSources++;
      } else {
        if (dominant === 'CALL') callScore *= 0.7;
        else putScore *= 0.7;
        reasons.push('BB contra o sinal - penalizado');
      }
    }

    // 6. EMA Crossover (peso maior em trending)
    const emaWeight = isTrending ? 1.0 : 0.6;
    if (cross.direction) {
      reasons.push(`EMA cross ${cross.direction} (${cross.note})`);
      if (cross.direction === dominant) {
        if (cross.cross) {
          if (dominant === 'CALL') callScore += cross.strength * emaWeight;
          else putScore += cross.strength * emaWeight;
          alignedSources++;
        } else {
          if (dominant === 'CALL') callScore += cross.strength * 0.4;
          else putScore += cross.strength * 0.4;
        }
      } else {
        if (cross.cross) {
          if (dominant === 'CALL') callScore *= 0.5;
          else putScore *= 0.5;
          reasons.push('cruzamento EMA contra o sinal - penalizado fortemente');
        }
      }
    }

    // 7. Momentum
    if (mom.strength > 0.1) {
      reasons.push(`momentum ${mom.direction} (forca ${mom.strength.toFixed(2)})`);
      if (mom.direction === dominant) {
        if (dominant === 'CALL') callScore += mom.strength * 0.3;
        else putScore += mom.strength * 0.3;
        alignedSources++;
      }
    }

    // 8. MACD
    if (macdVal.direction) {
      reasons.push(`MACD ${macdVal.direction} (${macdVal.note})`);
      if (macdVal.direction === dominant) {
        const w = macdVal.cross ? 0.7 : 0.4;
        if (dominant === 'CALL') callScore += macdVal.strength * w;
        else putScore += macdVal.strength * w;
        if (macdVal.cross) alignedSources++;
      } else {
        if (macdVal.cross) {
          if (dominant === 'CALL') callScore *= 0.6;
          else putScore *= 0.6;
          reasons.push('MACD cross contra o sinal - penalizado');
        }
      }
    }

    // 9. Stochastic
    if (stoch.direction) {
      reasons.push(`Stoch ${stoch.direction} (${stoch.note})`);
      if (stoch.direction === dominant) {
        const w = stoch.cross ? 0.5 : 0.4;
        if (dominant === 'CALL') callScore += stoch.strength * w;
        else putScore += stoch.strength * w;
        if (stoch.cross) alignedSources++;
      } else if (stoch.cross) {
        reasons.push('Stoch cross contra o sinal');
      }
    }

    // 10. Sentimento (contrarian) + recentDeals
    if (sentiment) {
      const total = sentiment.call + sentiment.put || 100;
      const callPct = sentiment.call / total;
      const putPct = sentiment.put / total;
      reasons.push(`sentimento CALL ${Math.round(callPct * 100)}% / PUT ${Math.round(putPct * 100)}%`);

      if (callPct >= 0.8) {
        putScore += 0.15;
        reasons.push('multidao >80% CALL - vies contrarian PUT');
      } else if (putPct >= 0.8) {
        callScore += 0.15;
        reasons.push('multidao >80% PUT - vies contrarian CALL');
      } else if (callPct >= 0.6 && dominant === 'CALL') {
        callScore += 0.08;
      } else if (putPct >= 0.6 && dominant === 'PUT') {
        putScore += 0.08;
      }

      // Usa recentDeals: grandes apostas concentradas aumentam vies contrarian
      if (sentiment.recentDeals && sentiment.recentDeals.length >= 5) {
        const recent = sentiment.recentDeals.slice(-10);
        const callBets = recent.filter((d) => d.direction === 'CALL').reduce((s, d) => s + d.bet, 0);
        const putBets = recent.filter((d) => d.direction === 'PUT').reduce((s, d) => s + d.bet, 0);
        const totalBets = callBets + putBets || 1;
        const callBetPct = callBets / totalBets;
        if (callBetPct >= 0.75) {
          putScore += 0.1;
          reasons.push(`apostas grandes ${Math.round(callBetPct * 100)}% CALL - contrarian PUT`);
        } else if (callBetPct <= 0.25) {
          callScore += 0.1;
          reasons.push(`apostas grandes ${Math.round((1 - callBetPct) * 100)}% PUT - contrarian CALL`);
        }
      }
    }

    // Adiciona contexto de volatilidade e ADX nos motivos
    reasons.push(`ATR ${(atrS.normalized * 100).toFixed(3)}% (${atrS.regime})`);
    reasons.push(`ADX ${adxVal.value.toFixed(0)} (${adxVal.trendStrength}) ${isTrending ? '-> trend-following' : isRanging ? '-> mean-reversion' : '-> misto'}`);
    reasons.push(`fontes alinhadas: ${alignedSources}`);

    // Gate: exige pelo menos N fontes alinhadas (alem do padrao)
    if (alignedSources < this.minAlignedSources) return null;

    const netDir: Direction = callScore >= putScore ? 'CALL' : 'PUT';
    const win = Math.max(callScore, putScore);
    const lose = Math.min(callScore, putScore);

    const dominance = (win - lose) / (win + lose + 1e-9);
    const confidence = Math.min(1, win / 1.5);
    const score = Math.round(dominance * confidence * 100);

    if (score < this.minScore) return null;
    if (win < 0.8) return null;

    const dominantPattern = strongestPattern(contextualPatterns);
    if (!dominantPattern || dominantPattern.direction !== netDir) return null;
    if (dominantPattern.strength < 0.45) return null;

    return {
      direction: netDir,
      score,
      reasons,
      candleTime: candles[candles.length - 1].time,
      patterns: patternNames,
    };
  }

  /**
   * Aplica contexto de S/R aos padroes: padrao de reversao proximo a S/R ganha bonus.
   * Pinbar no suporte = 1.3x forca. Pinbar mid-range = 0.8x.
   */
  private applyPatternContext(
    patterns: PatternMatch[],
    level: { direction: Direction | null; strength: number; note?: string },
    _atrValue: number,
  ): PatternMatch[] {
    if (!level.direction) return patterns;

    return patterns.map((p) => {
      const isReversal = p.name.includes('Pinbar') || p.name.includes('Hammer') ||
        p.name.includes('Star') || p.name.includes('Engulfing') ||
        p.name.includes('Tweezer') || p.name.includes('Harami');

      // Se o padrao de reversao esta alinhado com S/R (ex: Pinbar CALL no suporte)
      if (isReversal && p.direction === level.direction) {
        return {
          ...p,
          strength: Math.min(1, p.strength * 1.3),
          note: (p.note ? p.note + ' | ' : '') + 'confluencia S/R (+30%)',
        };
      }

      // Se o padrao de continuacao vai contra S/R, penaliza
      if (!isReversal && p.direction !== level.direction && level.strength > 0.5) {
        return {
          ...p,
          strength: p.strength * 0.8,
          note: (p.note ? p.note + ' | ' : '') + 'contra S/R (-20%)',
        };
      }

      return p;
    });
  }

  /**
   * Extrai contexto numerico para enviar a IA.
   */
  getContext(candles: Candle[]): SignalContext {
    const bb = bollingerBands(candles, 20, 2);
    const r = rsi(candles, 14);
    const a = atrSignal(candles, 14);
    const adxVal = adx(candles, 14);
    const m = macd(candles, 12, 26, 9);
    const s = stochastic(candles, 14, 3);
    const levels = findLevels(candles);
    const lastClose = candles[candles.length - 1].close;

    let srLevel: number | null = null;
    let srDistance: number | null = null;
    if (levels.length > 0) {
      const closest = levels.slice(0, 6).reduce((best, l) => {
        const dist = Math.abs(lastClose - l.price);
        return dist < best.dist ? { level: l, dist } : best;
      }, { level: levels[0], dist: Infinity });
      srLevel = closest.level.price;
      srDistance = closest.dist / lastClose;
    }

    const bbPos = bb ? (lastClose - bb.lower) / (bb.upper - bb.lower || 1e-9) : 0.5;

    return {
      rsi: r,
      atr: a.value,
      atrNormalized: a.normalized,
      adx: adxVal.value,
      plusDI: adxVal.plusDI,
      minusDI: adxVal.minusDI,
      macdHist: m.histogram,
      stochasticK: s.k,
      bbPosition: bbPos,
      srLevel,
      srDistance,
    };
  }
}

function strongestPattern(patterns: PatternMatch[]): PatternMatch | null {
  return patterns.reduce((acc, p) => (acc && acc.strength >= p.strength ? acc : p), null as PatternMatch | null);
}
