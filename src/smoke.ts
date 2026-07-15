import { SignalEngine } from './analysis/SignalEngine.js';
import { detectPatterns, trendBias } from './analysis/CandlePatterns.js';
import { findLevels, levelConfluence } from './analysis/SupportResistance.js';
import type { Candle } from './types.js';
import { service } from './logger.js';

const log = service('smoke');

function genTrend(n: number, drift: number, vol: number, start = 1.1): Candle[] {
  let price = start;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    const change = drift + (Math.random() - 0.5) * vol;
    const close = Math.max(0.01, open + change);
    const high = Math.max(open, close) + Math.random() * vol * 0.5;
    const low = Math.min(open, close) - Math.random() * vol * 0.5;
    out.push({ time: Date.now() - (n - i) * 1000, open, high, low, close });
    price = close;
  }
  return out;
}

function injectPinbarBear(candles: Candle[]): void {
  const last = candles[candles.length - 1];
  const open = last.close + 0.0008;
  const close = open - 0.0001; // corpo pequeno
  const high = open + 0.0020; // wick superior gigante
  const low = Math.min(open, close) - 0.0001;
  candles[candles.length - 1] = { ...last, open, close, high, low };
}

function run() {
  const engine = new SignalEngine(70);

  // Cenário 1: tendência de alta + pinbar bullish na retração -> espera CALL
  const up = genTrend(60, 0.00012, 0.0004);
  const res = engine.evaluate(up);
  log.info('Cenário tendência alta (sem candle forte): signal=%j', res);

  // Cenário 2: tendência de alta e martelo de alta (rejeição de baixa)
  const up2 = genTrend(60, 0.00012, 0.0004);
  const l = up2[up2.length - 1];
  up2[up2.length - 1] = {
    ...l,
    open: l.close - 0.0002,
    close: l.close + 0.0002, // corpo bullish pequeno
    high: l.close + 0.0003, // wick superior mínima
    low: l.close - 0.0018, // wick inferior grande (rejeição)
  };
  const res2 = engine.evaluate(up2);
  log.info('Cenário martelo de alta: signal=%j', res2);

  // Cenário 2b: martelo de alta SEM tendência -> deve ser nulo (sem alinhamento)
  const flat = genTrend(60, 0, 0.0004);
  const lf = flat[flat.length - 1];
  flat[flat.length - 1] = {
    ...lf,
    open: lf.close - 0.0002,
    close: lf.close + 0.0002,
    high: lf.close + 0.0003,
    low: lf.close - 0.0018,
  };
  const res2b = engine.evaluate(flat);
  log.info('Cenário martelo de alta SEM tendência: signal=%j', res2b);

  // Cenário 3: tendência de alta + pinbar bearish no topo -> sinal conflitante, deve ser nulo ou PUT fraco
  const up3 = genTrend(60, 0.00012, 0.0004);
  injectPinbarBear(up3);
  const res3 = engine.evaluate(up3);
  log.info('Cenário pinbar bear contra tendência: signal=%j', res3);

  // Cenário 4: Evening Star (3 candles) em tendência de alta -> PUT reversão
  const up4 = genTrend(60, 0.00012, 0.0004);
  const baseT = up4[up4.length - 1].close;
  up4[up4.length - 3] = { ...up4[up4.length - 3], open: baseT - 0.0012, close: baseT, high: baseT + 0.0001, low: baseT - 0.0013 };
  up4[up4.length - 2] = { ...up4[up4.length - 2], open: baseT + 0.0001, close: baseT + 0.0002, high: baseT + 0.0003, low: baseT - 0.0001 };
  up4[up4.length - 1] = { ...up4[up4.length - 1], open: baseT + 0.0002, close: baseT - 0.0011, high: baseT + 0.0003, low: baseT - 0.0012 };
  const res4 = engine.evaluate(up4);
  log.info('Cenário Evening Star: signal=%j', res4);

  // Cenário 5: Morning Star em tendência de baixa -> CALL reversão
  const down5 = genTrend(60, -0.00006, 0.0004); // tendência mais fraca
  const baseD = down5[down5.length - 1].close;
  down5[down5.length - 3] = { ...down5[down5.length - 3], open: baseD + 0.0015, close: baseD, high: baseD + 0.0016, low: baseD - 0.0001 };
  down5[down5.length - 2] = { ...down5[down5.length - 2], open: baseD - 0.0002, close: baseD - 0.0001, high: baseD + 0.0001, low: baseD - 0.0003 };
  down5[down5.length - 1] = { ...down5[down5.length - 1], open: baseD - 0.0002, close: baseD + 0.0014, high: baseD + 0.0015, low: baseD - 0.0003 };
  const res5 = engine.evaluate(down5);
  log.info('Cenário Morning Star: signal=%j', res5);

  // Cenário 6: Three White Soldiers em tendência de alta -> CALL
  const up6 = genTrend(60, 0.00012, 0.0004);
  const baseS = up6[up6.length - 1].close;
  up6[up6.length - 3] = { ...up6[up6.length - 3], open: baseS - 0.0006, close: baseS - 0.0002, high: baseS - 0.0001, low: baseS - 0.0007 };
  up6[up6.length - 2] = { ...up6[up6.length - 2], open: baseS - 0.0002, close: baseS + 0.0002, high: baseS + 0.0003, low: baseS - 0.0003 };
  up6[up6.length - 1] = { ...up6[up6.length - 1], open: baseS + 0.0002, close: baseS + 0.0006, high: baseS + 0.0007, low: baseS + 0.0001 };
  const res6 = engine.evaluate(up6);
  log.info('Cenário Three White Soldiers: signal=%j', res6);

  // Diagnóstico bruto
  const candles = up2;
  log.info('patterns=%j', detectPatterns(candles));
  log.info('trend=%j', trendBias(candles));
  const levels = findLevels(candles);
  log.info('levels(count=%d)=%j', levels.length, levels.slice(0, 4));
  log.info('levelConfluence=%j', levelConfluence(candles, levels));
}

run();
