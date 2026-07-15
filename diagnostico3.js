import fs from 'node:fs';
import { SignalEngine } from './dist/analysis/SignalEngine.js';

const csv = fs.readFileSync('logs/candles.csv', 'utf-8');
const lines = csv.trim().split('\n');
const candles = lines.map((line) => {
  const [time, open, high, low, close] = line.split(',').map(Number);
  return { time, open, high, low, close };
});

console.log('Total candles:', candles.length);

// Teste com minAlignedSources=2 e minScore=80 (produção)
const engine = new SignalEngine(80);

let sinalCount = 0;
let rejPattern = 0;
let rejAligned = 0;
let rejScore = 0;
let rejWin = 0;
let rejPatternStr = 0;
let rejPatternMin = 0;

for (let i = 80; i <= candles.length; i++) {
  const w = candles.slice(i - 80, i);
  if (w.length < 80) continue;

  const signal = engine.evaluate(w);
  if (signal) {
    sinalCount++;
    continue;
  }
}

console.log(`\nSinais: ${sinalCount} / ${candles.length - 80} janelas`);
console.log(`Freq: 1 sinal a cada ${candles.length - 80 > 0 && sinalCount > 0 ? ((candles.length - 80) / sinalCount * 15 / 60).toFixed(1) : 'N/A'} min`);

// Teste com minAlignedSources=2 e minScore=70
const engine70 = new SignalEngine(70);
let sinalCount70 = 0;
for (let i = 80; i <= candles.length; i++) {
  const w = candles.slice(i - 80, i);
  if (w.length < 80) continue;
  const signal = engine70.evaluate(w);
  if (signal) sinalCount70++;
}
console.log(`\nCom minScore=70: ${sinalCount70} sinais`);
console.log(`Freq: 1 sinal a cada ${sinalCount70 > 0 ? ((candles.length - 80) / sinalCount70 * 15 / 60).toFixed(1) : 'N/A'} min`);
