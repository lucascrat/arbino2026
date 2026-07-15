import fs from 'node:fs';
import { SignalEngine } from './dist/analysis/SignalEngine.js';

const csv = fs.readFileSync('logs/candles.csv', 'utf-8');
const lines = csv.trim().split('\n');
const candles = lines.map((line) => {
  const [time, open, high, low, close] = line.split(',').map(Number);
  return { time, open, high, low, close };
});

console.log('Total candles:', candles.length);

const engine = new SignalEngine();

let signalCount = 0;
let withPattern = 0;
let passedATR = 0;
let passedWin = 0;
let passedScore = 0;
let rejectedATR = 0;
let rejectedPattern = 0;
let rejectedWin = 0;
let rejectedScore = 0;

for (let i = 80; i <= candles.length; i++) {
  const w = candles.slice(i - 80, i);
  if (w.length < 80) continue;

  const signal = engine.evaluate(w);
  if (signal) {
    signalCount++;
  }
}

console.log(`\nSinais gerados: ${signalCount} em ${candles.length - 80} janelas`);
console.log(`Frequencia: 1 sinal a cada ${((candles.length - 80) / signalCount / 4).toFixed(0)} segundos (media)`);
