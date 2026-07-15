import fs from 'node:fs';
import { detectPatterns, trendBias } from './dist/analysis/CandlePatterns.js';
import { findLevels, levelConfluence } from './dist/analysis/SupportResistance.js';
import { rsiSignal, bollingerSignal, emaCrossover, momentum, atrSignal, adx, macd, stochastic } from './dist/analysis/Indicators.js';

const csv = fs.readFileSync('logs/candles.csv', 'utf-8');
const lines = csv.trim().split('\n');
const candles = lines.map((line) => {
  const [time, open, high, low, close] = line.split(',').map(Number);
  return { time, open, high, low, close };
});

console.log('Total candles:', candles.length);

const window = candles.slice(-80);
console.log('\n--- ULTIMA JANELA (80 candles) ---');
console.log('Patterns:', detectPatterns(window).map((p) => `${p.name}(${p.direction},${p.strength.toFixed(2)})`));
console.log('Trend:', trendBias(window));
const levels = findLevels(window);
console.log('Levels:', levels.slice(0, 3).map((l) => `${l.type}@${l.price.toExponential(3)}(t${l.touches})`));
console.log('LevelConfluence:', levelConfluence(window, levels));
console.log('RSI:', rsiSignal(window, 14));
console.log('BB:', bollingerSignal(window, 20, 2));
console.log('EMA:', emaCrossover(window, 9, 21));
console.log('Momentum:', momentum(window, 10));
console.log('ATR:', atrSignal(window, 14));
console.log('ADX:', adx(window, 14));
console.log('MACD:', macd(window, 12, 26, 9));
console.log('Stoch:', stochastic(window, 14, 3));

// Conta ocorrencias nos ultimos 500 candles
console.log('\n--- ESTATISTICAS ULTIMOS 500 CANDLES ---');
let patternsCount = 0;
let atrDead = 0;
let atrLow = 0;
let adxStrong = 0;
let aligned3Plus = 0;

for (let i = 500; i <= candles.length; i++) {
  const w = candles.slice(i - 80, i);
  if (w.length < 80) continue;

  const atr = atrSignal(w, 14);
  if (atr.regime === 'dead') atrDead++;
  if (atr.regime === 'low') atrLow++;

  const adxv = adx(w, 14);
  if (adxv.trendStrength === 'strong') adxStrong++;

  const pats = detectPatterns(w);
  if (pats.length > 0) patternsCount++;

  // Simula contagem de fontes alinhadas
  const dominant = pats.reduce((acc, p) => {
    if (p.direction === 'CALL') acc.call += p.strength;
    else acc.put += p.strength;
    return acc;
  }, { call: 0, put: 0 });
  const domDir = dominant.call >= dominant.put ? 'CALL' : 'PUT';
  let aligned = 0;
  const trend = trendBias(w);
  if (trend.strength > 0.15 && trend.direction === domDir) aligned++;
  const lvl = levelConfluence(w, findLevels(w));
  if (lvl.direction === domDir) aligned++;
  const rsi = rsiSignal(w, 14);
  if (rsi.direction === domDir) aligned++;
  const bb = bollingerSignal(w, 20, 2);
  if (bb.direction === domDir) aligned++;
  const cross = emaCrossover(w, 9, 21);
  if (cross.direction === domDir && cross.cross) aligned++;
  const mom = momentum(w, 10);
  if (mom.direction === domDir && mom.strength > 0.1) aligned++;
  const macdv = macd(w, 12, 26, 9);
  if (macdv.direction === domDir && macdv.cross) aligned++;
  const stochv = stochastic(w, 14, 3);
  if (stochv.direction === domDir && stochv.cross) aligned++;

  if (aligned >= 3) aligned3Plus++;
}

console.log('Candles com ATR dead:', atrDead, '/', 500);
console.log('Candles com ATR low:', atrLow, '/', 500);
console.log('Candles com ADX strong:', adxStrong, '/', 500);
console.log('Candles com padrao:', patternsCount, '/', 500);
console.log('Candles com 3+ fontes alinhadas:', aligned3Plus, '/', 500);
