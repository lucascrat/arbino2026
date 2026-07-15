import type { Candle, Direction } from '../types.js';

// ===== EMA (Exponential Moving Average) =====
/**
 * Calcula EMA sobre um array de candles usando SMA como seed (correto).
 * @param candles array completo de candles (ordem cronologica)
 * @param period periodo da EMA
 * @returns valor da EMA no ultimo candle
 */
export function emaValue(candles: Candle[], period: number): number {
  if (candles.length < period) return candles.length > 0 ? candles[candles.length - 1].close : 0;
  const closes = candles.map((c) => c.close);
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

/**
 * Calcula serie completa de EMA para cada candle.
 */
export function emaSeries(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  if (candles.length < period) {
    return candles.map(() => 0);
  }
  const closes = candles.map((c) => c.close);
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      out.push(0);
    } else if (i === period - 1) {
      out.push(e);
    } else {
      e = closes[i] * k + e * (1 - k);
      out.push(e);
    }
  }
  return out;
}

// ===== RSI (Wilder's RMA) =====
/**
 * RSI usando Wilder's smoothing (RMA) — padrao da industria.
 */
export function rsi(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  const closes = candles.map((c) => c.close);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Sinal de RSI: detecta sobrecompra/sobrevenda.
 */
export function rsiSignal(candles: Candle[], period = 14): {
  value: number;
  direction: Direction | null;
  strength: number;
  note: string;
} {
  const value = rsi(candles, period);
  if (candles.length < period + 1) {
    return { value, direction: null, strength: 0, note: 'dados insuficientes' };
  }

  if (value >= 75) {
    return { value, direction: 'PUT', strength: 0.7, note: `RSI ${value.toFixed(0)} sobrecomprado` };
  }
  if (value <= 25) {
    return { value, direction: 'CALL', strength: 0.7, note: `RSI ${value.toFixed(0)} sobrevendido` };
  }
  if (value >= 65 && value < 75) {
    return { value, direction: 'PUT', strength: 0.4, note: `RSI ${value.toFixed(0)} vendo sobrecompra` };
  }
  if (value <= 35 && value > 25) {
    return { value, direction: 'CALL', strength: 0.4, note: `RSI ${value.toFixed(0)} vendo sobrevenda` };
  }
  return { value, direction: null, strength: 0, note: `RSI ${value.toFixed(0)} neutro` };
}

// ===== Bollinger Bands =====
export function bollingerBands(candles: Candle[], period = 20, multiplier = 2): {
  upper: number;
  middle: number;
  lower: number;
  width: number;
} | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map((c) => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (period - 1);
  const std = Math.sqrt(variance);
  return {
    upper: mean + multiplier * std,
    middle: mean,
    lower: mean - multiplier * std,
    width: (4 * std) / mean,
  };
}

export function bollingerSignal(candles: Candle[], period = 20, multiplier = 2): {
  direction: Direction | null;
  strength: number;
  note: string;
} {
  const bb = bollingerBands(candles, period, multiplier);
  if (!bb) return { direction: null, strength: 0, note: 'dados insuficientes' };

  const last = candles[candles.length - 1];
  const close = last.close;
  const range = bb.upper - bb.lower || 1e-9;
  const pos = (close - bb.lower) / range;

  if (close >= bb.upper) {
    const body = Math.abs(last.close - last.open);
    const range2 = last.high - last.low || 1e-9;
    if (body / range2 > 0.6 && last.close > last.open) {
      return { direction: 'CALL', strength: 0.6, note: `BB breakout superior (forca)` };
    }
    return { direction: 'PUT', strength: 0.65, note: `BB banda superior rejeitada (${close.toExponential(3)})` };
  }
  if (close <= bb.lower) {
    const body = Math.abs(last.close - last.open);
    const range2 = last.high - last.low || 1e-9;
    if (body / range2 > 0.6 && last.close < last.open) {
      return { direction: 'PUT', strength: 0.6, note: `BB breakout inferior (forca)` };
    }
    return { direction: 'CALL', strength: 0.65, note: `BB banda inferior rejeitada (${close.toExponential(3)})` };
  }

  return { direction: null, strength: 0, note: `BB neutro (pos=${pos.toFixed(2)})` };
}

// ===== EMA Crossover =====
export function emaCrossover(candles: Candle[], fast = 9, slow = 21): {
  direction: Direction | null;
  strength: number;
  note: string;
  cross: boolean;
} {
  if (candles.length < slow + 2) {
    return { direction: null, strength: 0, note: 'dados insuficientes', cross: false };
  }

  const fastNow = emaValue(candles, fast);
  const slowNow = emaValue(candles, slow);
  const prevCandles = candles.slice(0, -1);
  const fastPrev = emaValue(prevCandles, fast);
  const slowPrev = emaValue(prevCandles, slow);

  const wasBelow = fastPrev <= slowPrev;
  const wasAbove = fastPrev >= slowPrev;
  const isAbove = fastNow > slowNow;
  const isBelow = fastNow < slowNow;

  if (wasBelow && isAbove) {
    const diff = Math.abs(fastNow - slowNow) / slowNow;
    return {
      direction: 'CALL',
      strength: Math.min(1, 0.6 + diff * 1000),
      note: `Golden cross EMA${fast}/${slow}`,
      cross: true,
    };
  }
  if (wasAbove && isBelow) {
    const diff = Math.abs(fastNow - slowNow) / slowNow;
    return {
      direction: 'PUT',
      strength: Math.min(1, 0.6 + diff * 1000),
      note: `Death cross EMA${fast}/${slow}`,
      cross: true,
    };
  }

  if (isAbove) {
    const diff = (fastNow - slowNow) / slowNow;
    const strength = Math.min(0.5, Math.abs(diff) * 500);
    return { direction: 'CALL', strength, note: `EMA${fast} > EMA${slow} (sem cruzamento)`, cross: false };
  }
  if (isBelow) {
    const diff = (slowNow - fastNow) / slowNow;
    const strength = Math.min(0.5, Math.abs(diff) * 500);
    return { direction: 'PUT', strength, note: `EMA${fast} < EMA${slow} (sem cruzamento)`, cross: false };
  }

  return { direction: null, strength: 0, note: 'EMAs coladas', cross: false };
}

// ===== Momentum =====
export function momentum(candles: Candle[], period = 10): {
  value: number;
  direction: Direction | null;
  strength: number;
} {
  if (candles.length < period + 1) {
    return { value: 0, direction: null, strength: 0 };
  }
  const current = candles[candles.length - 1].close;
  const past = candles[candles.length - 1 - period].close;
  const mom = (current - past) / past;
  const strength = Math.min(1, Math.abs(mom) * 1000);
  return {
    value: mom,
    direction: mom > 0 ? 'CALL' : 'PUT',
    strength,
  };
}

// ===== ATR (Average True Range) =====
/**
 * ATR usando Wilder's RMA. Mede volatilidade.
 * Usado para: dimensionar S/R dinamicamente, filtrar mercados mortos,
 * e como base para regime de volatilidade.
 */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trs.push(tr);
  }
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
  }
  return atrVal;
}

/**
 * Sinal de volatilidade baseado em ATR.
 * Retorna ATR normalizado pelo preco (percentual).
 */
export function atrSignal(candles: Candle[], period = 14): {
  value: number;
  normalized: number;
  regime: 'dead' | 'low' | 'normal' | 'high';
  note: string;
} {
  const value = atr(candles, period);
  const lastClose = candles[candles.length - 1]?.close ?? 1;
  const normalized = value / lastClose;

  // Regime baseado em percentil do historico de ATR (adapta-se a qualquer ativo)
  const atrHistory: number[] = [];
  const step = Math.max(1, Math.floor((candles.length - period * 2) / 200));
  for (let i = period * 2; i < candles.length; i += step) {
    atrHistory.push(atr(candles.slice(0, i), period));
  }
  const sorted = atrHistory.length > 0 ? [...atrHistory].sort((a, b) => a - b) : [value];
  const median = sorted[Math.floor(sorted.length / 2)] || value;
  const ratio = value / median;

  let regime: 'dead' | 'low' | 'normal' | 'high';
  if (ratio < 0.1) regime = 'dead';
  else if (ratio < 0.6) regime = 'low';
  else if (ratio < 1.5) regime = 'normal';
  else regime = 'high';

  return {
    value,
    normalized,
    regime,
    note: `ATR ${(normalized * 100).toFixed(6)}% (${regime}, ratio=${ratio.toFixed(2)})`,
  };
}

// ===== ADX (Average Directional Index) =====
/**
 * ADX mede a FORCA da tendencia (nao a direcao).
 * ADX > 25: tendencia forte (usar trend-following: EMA cross)
 * ADX < 20: mercado lateralizado (usar mean-reversion: RSI, BB)
 * ADX 20-25: transicao
 */
export function adx(candles: Candle[], period = 14): {
  value: number;
  plusDI: number;
  minusDI: number;
  trendStrength: 'weak' | 'transition' | 'strong';
  direction: Direction | null;
  note: string;
} {
  if (candles.length < period * 2 + 1) {
    return { value: 0, plusDI: 0, minusDI: 0, trendStrength: 'weak', direction: null, note: 'dados insuficientes' };
  }

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }

  // Wilder's smoothing
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
    plusDM = (plusDM * (period - 1) + plusDMs[i]) / period;
    minusDM = (minusDM * (period - 1) + minusDMs[i]) / period;
  }

  if (atrVal === 0) {
    return { value: 0, plusDI: 0, minusDI: 0, trendStrength: 'weak', direction: null, note: 'ATR zero' };
  }

  const plusDI = (plusDM / atrVal) * 100;
  const minusDI = (minusDM / atrVal) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;

  // ADX = Wilder's smoothed DX
  let adxVal = dx;
  if (trs.length > period * 2) {
    const dxs: number[] = [];
    let a = atrVal;
    let pDM = plusDM;
    let mDM = minusDM;
    for (let i = period; i < trs.length; i++) {
      a = (a * (period - 1) + trs[i]) / period;
      pDM = (pDM * (period - 1) + plusDMs[i]) / period;
      mDM = (mDM * (period - 1) + minusDMs[i]) / period;
      if (a > 0) {
        const pDI = (pDM / a) * 100;
        const mDI = (mDM / a) * 100;
        dxs.push(Math.abs(pDI - mDI) / (pDI + mDI || 1) * 100);
      }
    }
    if (dxs.length >= period) {
      adxVal = dxs.slice(0, period).reduce((x, y) => x + y, 0) / period;
      for (let i = period; i < dxs.length; i++) {
        adxVal = (adxVal * (period - 1) + dxs[i]) / period;
      }
    }
  }

  let trendStrength: 'weak' | 'transition' | 'strong';
  if (adxVal < 20) trendStrength = 'weak';
  else if (adxVal < 25) trendStrength = 'transition';
  else trendStrength = 'strong';

  const direction: Direction | null = plusDI > minusDI ? 'CALL' : minusDI > plusDI ? 'PUT' : null;

  return {
    value: adxVal,
    plusDI,
    minusDI,
    trendStrength,
    direction,
    note: `ADX ${adxVal.toFixed(0)} (${trendStrength}) +DI${plusDI.toFixed(0)} -DI${minusDI.toFixed(0)}`,
  };
}

// ===== MACD (Moving Average Convergence Divergence) =====
/**
 * MACD = EMA(12) - EMA(26), Signal = EMA(9) do MACD, Histogram = MACD - Signal
 * Cruzamento MACD > Signal = CALL (bullish), MACD < Signal = PUT (bearish)
 * Histograma crescente = momentum a favor
 */
export function macd(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9): {
  macd: number;
  signal: number;
  histogram: number;
  direction: Direction | null;
  strength: number;
  note: string;
  cross: boolean;
} {
  if (candles.length < slow + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0, direction: null, strength: 0, note: 'dados insuficientes', cross: false };
  }

  const closes = candles.map((c) => c.close);
  const emaFast = emaSeries(candles, fast);
  const emaSlow = emaSeries(candles, slow);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < slow - 1) {
      macdLine.push(0);
    } else {
      macdLine.push(emaFast[i] - emaSlow[i]);
    }
  }

  // Signal = EMA(9) do MACD
  const validMacd = macdLine.slice(slow - 1);
  const k = 2 / (signalPeriod + 1);
  let sig = validMacd.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < validMacd.length; i++) {
    sig = validMacd[i] * k + sig * (1 - k);
  }

  const macdNow = macdLine[macdLine.length - 1];
  const hist = macdNow - sig;

  // Cruzamento: verificar candle anterior
  const prevValidMacd = validMacd.length >= 2 ? validMacd[validMacd.length - 2] : macdNow;
  const prevSig = validMacd.length >= signalPeriod + 1
    ? (() => {
      let s = validMacd.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
      for (let i = signalPeriod; i < validMacd.length - 1; i++) {
        s = validMacd[i] * k + s * (1 - k);
      }
      return s;
    })()
    : sig;

  const wasBelow = prevValidMacd <= prevSig;
  const wasAbove = prevValidMacd >= prevSig;
  const isAbove = macdNow > sig;
  const isBelow = macdNow < sig;

  let cross = false;
  let direction: Direction | null = null;
  let strength = 0;
  let note = '';

  if (wasBelow && isAbove) {
    cross = true;
    direction = 'CALL';
    strength = Math.min(1, Math.abs(hist) / (Math.abs(macdNow) || 1) * 2);
    note = `MACD bullish cross`;
  } else if (wasAbove && isBelow) {
    cross = true;
    direction = 'PUT';
    strength = Math.min(1, Math.abs(hist) / (Math.abs(macdNow) || 1) * 2);
    note = `MACD bearish cross`;
  } else if (isAbove) {
    direction = 'CALL';
    strength = Math.min(0.5, Math.abs(hist) / (Math.abs(macdNow) || 1));
    note = `MACD > Signal (bullish)`;
  } else if (isBelow) {
    direction = 'PUT';
    strength = Math.min(0.5, Math.abs(hist) / (Math.abs(macdNow) || 1));
    note = `MACD < Signal (bearish)`;
  } else {
    note = 'MACD neutro';
  }

  return { macd: macdNow, signal: sig, histogram: hist, direction, strength, note, cross };
}

// ===== Stochastic Oscillator =====
/**
 * Stochastic: %K = (close - lowest_low) / (highest_high - lowest_low) * 100
 * %D = SMA(3) do %K
 * %K > 80: sobrecomprado (PUT), %K < 20: sobrevendido (CALL)
 * Cruzamento %K/%D: sinal de reversao
 */
export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): {
  k: number;
  d: number;
  direction: Direction | null;
  strength: number;
  note: string;
  cross: boolean;
} {
  if (candles.length < kPeriod + dPeriod) {
    return { k: 50, d: 50, direction: null, strength: 0, note: 'dados insuficientes', cross: false };
  }

  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice.map((c) => c.high));
    const lowest = Math.min(...slice.map((c) => c.low));
    const close = candles[i].close;
    const range = highest - lowest || 1e-9;
    kValues.push(((close - lowest) / range) * 100);
  }

  const kNow = kValues[kValues.length - 1];
  const dNow = kValues.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  const kPrev = kValues[kValues.length - 2] ?? kNow;
  const dPrev = kValues.slice(-(dPeriod + 1), -1).reduce((a, b) => a + b, 0) / dPeriod;

  const wasBelow = kPrev <= dPrev;
  const wasAbove = kPrev >= dPrev;
  const isAbove = kNow > dNow;
  const isBelow = kNow < dNow;

  let cross = false;
  let direction: Direction | null = null;
  let strength = 0;
  let note = '';

  if (kNow >= 80) {
    direction = 'PUT';
    strength = 0.6;
    note = `Stoch ${kNow.toFixed(0)} sobrecomprado`;
  } else if (kNow <= 20) {
    direction = 'CALL';
    strength = 0.6;
    note = `Stoch ${kNow.toFixed(0)} sobrevendido`;
  } else if (wasBelow && isAbove && kNow < 50) {
    cross = true;
    direction = 'CALL';
    strength = 0.5;
    note = `Stoch bullish cross (zona baixa)`;
  } else if (wasAbove && isBelow && kNow > 50) {
    cross = true;
    direction = 'PUT';
    strength = 0.5;
    note = `Stoch bearish cross (zona alta)`;
  } else {
    note = `Stoch ${kNow.toFixed(0)} neutro`;
  }

  return { k: kNow, d: dNow, direction, strength, note, cross };
}
