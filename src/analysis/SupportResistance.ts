import type { Candle } from '../types.js';

export interface Level {
  price: number;
  touches: number;
  type: 'support' | 'resistance';
}

/**
 * Encontra suportes e resistencias por agrupamento de pivôs fractais.
 * Usa 2 candles de cada lado (fractal classico) para reduzir ruido.
 */
export function findLevels(candles: Candle[], tolerance = 0.0004): Level[] {
  const pivots: { price: number; type: 'support' | 'resistance' }[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    // Fractal high: high atual > 2 highs anteriores e 2 posteriores
    const isHigh = c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
                   c.high > candles[i + 1].high && c.high > candles[i + 2].high;
    // Fractal low: low atual < 2 lows anteriores e 2 posteriores
    const isLow = c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
                  c.low < candles[i + 1].low && c.low < candles[i + 2].low;
    if (isHigh) pivots.push({ price: c.high, type: 'resistance' });
    if (isLow) pivots.push({ price: c.low, type: 'support' });
  }

  const levels: Level[] = [];
  for (const p of pivots) {
    const existing = levels.find(
      (l) => l.type === p.type && Math.abs(l.price - p.price) / p.price <= tolerance
    );
    if (existing) {
      existing.price = (existing.price * existing.touches + p.price) / (existing.touches + 1);
      existing.touches++;
    } else {
      levels.push({ price: p.price, touches: 1, type: p.type });
    }
  }
  return levels.sort((a, b) => b.touches - a.touches);
}

/**
 * Verifica se a ultima candle fechou perto de um nivel (rejeicao).
 * Retorna confluencia: direcao contraria ao nivel rompido/testado.
 */
export function levelConfluence(candles: Candle[], levels: Level[]): {
  direction: 'CALL' | 'PUT' | null;
  strength: number;
  note?: string;
} {
  const last = candles[candles.length - 1];
  if (!last) return { direction: null, strength: 0 };
  const tol = (last.close * 0.0006);

  for (const lvl of levels.slice(0, 8)) {
    const dist = Math.abs(last.close - lvl.price);
    if (dist <= tol) {
      const rejectedUp = lvl.type === 'resistance' && last.close < lvl.price;
      const rejectedDown = lvl.type === 'support' && last.close > lvl.price;
      // Forca com cap em 1.0 (0.4 base + 0.08 por toque, max ~1.0)
      const strength = Math.min(1, 0.4 + lvl.touches * 0.08);
      if (rejectedUp) {
        return { direction: 'PUT', strength, note: `rejeicao resistencia (${lvl.price.toExponential(4)})` };
      }
      if (rejectedDown) {
        return { direction: 'CALL', strength, note: `rejeicao suporte (${lvl.price.toExponential(4)})` };
      }
    }
  }
  return { direction: null, strength: 0 };
}

/**
 * Encontra o nivel S/R mais proximo do preco atual.
 */
export function nearestLevel(candles: Candle[], levels: Level[]): Level | null {
  const last = candles[candles.length - 1];
  if (!last || levels.length === 0) return null;
  let best: Level | null = null;
  let bestDist = Infinity;
  for (const lvl of levels.slice(0, 10)) {
    const dist = Math.abs(last.close - lvl.price);
    if (dist < bestDist) {
      bestDist = dist;
      best = lvl;
    }
  }
  return best;
}
