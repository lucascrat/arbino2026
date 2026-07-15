import type { Candle, Direction } from '../types.js';
import { emaValue } from './Indicators.js';

export interface PatternMatch {
  name: string;
  direction: Direction;
  strength: number; // 0..1
  note?: string;
}

const body = (c: Candle): number => Math.abs(c.close - c.open);
const range = (c: Candle): number => c.high - c.low || 1e-9;
const upperWick = (c: Candle): number => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle): number => Math.min(c.open, c.close) - c.low;
const isBull = (c: Candle): boolean => c.close > c.open;
const isBear = (c: Candle): boolean => c.close < c.open;

/**
 * Detecta padrões de price action na última candle fechada.
 * `candles` deve estar em ordem cronológica (mais antiga -> mais nova).
 * Analisamos apenas a última candle como "fechada".
 */
export function detectPatterns(candles: Candle[]): PatternMatch[] {
  const n = candles.length;
  if (n < 3) return [];
  const c = candles[n - 1];
  const prev = candles[n - 2];
  const r = range(c);
  const matches: PatternMatch[] = [];

  // ---- Pinbar / Hammer (martelo) ----
  const lw = lowerWick(c);
  const uw = upperWick(c);
  const b = body(c);
  if (lw >= b * 2 && uw <= b * 0.6 && b / r <= 0.35) {
    matches.push({
      name: 'PinbarBullish',
      direction: 'CALL',
      strength: 0.7,
      note: `wick inferior ${lw.toFixed(5)} >> corpo ${b.toFixed(5)}`,
    });
  }
  if (uw >= b * 2 && lw <= b * 0.6 && b / r <= 0.35) {
    matches.push({
      name: 'PinbarBearish',
      direction: 'PUT',
      strength: 0.7,
      note: `wick superior ${uw.toFixed(5)} >> corpo ${b.toFixed(5)}`,
    });
  }

  // ---- Engolfo de alta / baixa ----
  if (isBear(prev) && isBull(c) && c.close >= prev.open && c.open <= prev.close) {
    const engulfStrength = Math.min(1, body(c) / (body(prev) || 1e-9) / 2);
    matches.push({
      name: 'BullishEngulfing',
      direction: 'CALL',
      strength: 0.6 + engulfStrength * 0.3,
    });
  }
  if (isBull(prev) && isBear(c) && c.open >= prev.close && c.close <= prev.open) {
    const engulfStrength = Math.min(1, body(c) / (body(prev) || 1e-9) / 2);
    matches.push({
      name: 'BearishEngulfing',
      direction: 'PUT',
      strength: 0.6 + engulfStrength * 0.3,
    });
  }

  // ---- Doji ----
  if (b / r <= 0.1) {
    matches.push({ name: 'Doji', direction: isBull(prev) ? 'PUT' : 'CALL', strength: 0.35, note: 'indecisão' });
  }

  // ---- Marubozu (corpo dominante, sem wick relevante) ----
  if (b / r >= 0.92) {
    matches.push({
      name: isBull(c) ? 'MarubozuBullish' : 'MarubozuBearish',
      direction: isBull(c) ? 'CALL' : 'PUT',
      strength: 0.55,
      note: 'continuação forte',
    });
  }

  // ---- Estrela cadente / martelo invertido no topo ----
  if (uw >= b * 2 && lw <= b && isBull(prev) && c.high >= prev.high) {
    matches.push({ name: 'ShootingStar', direction: 'PUT', strength: 0.6 });
  }
  if (lw >= b * 2 && uw <= b && isBear(prev) && c.low <= prev.low) {
    matches.push({ name: 'Hammer', direction: 'CALL', strength: 0.6 });
  }

  // ---- Padrões de 3 candles (requer n>=4) ----
  if (n >= 4) {
    const prev2 = candles[n - 3];

    // Morning Star (estrela da manhã) — reversão de baixa para alta
    // 1: bear forte, 2: pequena (gap down, indecisão), 3: bull forte que recupera
    if (isBear(prev2) && body(prev2) / range(prev2) > 0.5 &&
        body(prev) / range(prev) < 0.3 &&
        isBull(c) && body(c) / range(c) > 0.5 &&
        c.close > (prev2.open + prev2.close) / 2) {
      matches.push({ name: 'MorningStar', direction: 'CALL', strength: 0.8, note: 'reversão de baixa' });
    }

    // Evening Star (estrela da noite) — reversão de alta para baixa
    if (isBull(prev2) && body(prev2) / range(prev2) > 0.5 &&
        body(prev) / range(prev) < 0.3 &&
        isBear(c) && body(c) / range(c) > 0.5 &&
        c.close < (prev2.open + prev2.close) / 2) {
      matches.push({ name: 'EveningStar', direction: 'PUT', strength: 0.8, note: 'reversão de alta' });
    }

    // Three White Soldiers — 3 candles bullish consecutivas, cada uma fechando mais alta
    if (isBull(prev2) && isBull(prev) && isBull(c) &&
        c.close > prev.close && prev.close > prev2.close &&
        c.open > prev.open && prev.open > prev2.open &&
        body(c) / range(c) > 0.5 && body(prev) / range(prev) > 0.5) {
      matches.push({ name: 'ThreeWhiteSoldiers', direction: 'CALL', strength: 0.7, note: 'continuação forte' });
    }

    // Three Black Crows — 3 candles bearish consecutivas, cada uma fechando mais baixa
    if (isBear(prev2) && isBear(prev) && isBear(c) &&
        c.close < prev.close && prev.close < prev2.close &&
        c.open < prev.open && prev.open < prev2.open &&
        body(c) / range(c) > 0.5 && body(prev) / range(prev) > 0.5) {
      matches.push({ name: 'ThreeBlackCrows', direction: 'PUT', strength: 0.7, note: 'continuação forte' });
    }

    // Tweezer Top (pinça de topo) — 2 candles com topos iguais, reversão de alta
    const tolTop = Math.max(c.high, prev.high) * 0.0003;
    if (isBull(prev) && isBear(c) &&
        Math.abs(c.high - prev.high) <= tolTop &&
        body(prev) / range(prev) > 0.5 && body(c) / range(c) > 0.5) {
      matches.push({ name: 'TweezerTop', direction: 'PUT', strength: 0.65, note: 'rejeição de topo' });
    }

    // Tweezer Bottom (pinça de fundo) — 2 candles com fundos iguais, reversão de baixa
    const tolBot = Math.max(c.low, prev.low) * 0.0003;
    if (isBear(prev) && isBull(c) &&
        Math.abs(c.low - prev.low) <= tolBot &&
        body(prev) / range(prev) > 0.5 && body(c) / range(c) > 0.5) {
      matches.push({ name: 'TweezerBottom', direction: 'CALL', strength: 0.65, note: 'rejeição de fundo' });
    }

    // Harami de alta — candle bearish grande seguido de bull pequeno dentro do corpo
    if (isBear(prev2) && body(prev2) / range(prev2) > 0.5 &&
        isBull(c) && body(c) < body(prev2) * 0.6 &&
        c.open >= prev2.close && c.close <= prev2.open) {
      matches.push({ name: 'BullishHarami', direction: 'CALL', strength: 0.55, note: 'reversão de baixa' });
    }

    // Harami de baixa — candle bullish grande seguido de bear pequeno dentro do corpo
    if (isBull(prev2) && body(prev2) / range(prev2) > 0.5 &&
        isBear(c) && body(c) < body(prev2) * 0.6 &&
        c.open <= prev2.close && c.close >= prev2.open) {
      matches.push({ name: 'BearishHarami', direction: 'PUT', strength: 0.55, note: 'reversão de alta' });
    }
  }

  return matches;
}

/** Tendencia curta via slope da EMA(9) vs EMA(21). */
export function trendBias(candles: Candle[]): { direction: Direction; strength: number } {
  const n = candles.length;
  if (n < 25) return { direction: 'CALL', strength: 0 };
  const ema9 = emaValue(candles, 9);
  const ema21 = emaValue(candles, 21);
  const last = candles[n - 1].close;
  const diff = (ema9 - ema21) / last;
  const strength = Math.min(1, Math.abs(diff) / 0.0008);
  return { direction: diff >= 0 ? 'CALL' : 'PUT', strength };
}
