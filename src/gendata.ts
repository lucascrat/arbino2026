import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { service } from './logger.js';

const log = service('GenData');

/**
 * Gera candles sintéticos realistas para validar o backtester.
 * Cria tendências, reversões e ruído para simular condições de mercado.
 */
function genSynthetic(n: number, tfMs: number): { time: number; open: number; high: number; low: number; close: number }[] {
  const candles: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let price = 100;
  const start = Date.now() - n * tfMs;
  let drift = 0;
  let regime = 0; // 0=flat, 1=up, -1=down
  let regimeLeft = 0;

  for (let i = 0; i < n; i++) {
    if (regimeLeft <= 0) {
      regime = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
      regimeLeft = 20 + Math.floor(Math.random() * 40);
      drift = regime * (Math.random() * 0.04 + 0.01);
    }
    regimeLeft--;

    const open = price;
    const vol = 0.05 + Math.random() * 0.1;
    const change = drift + (Math.random() - 0.5) * vol;
    const close = Math.max(1, open + change);
    const high = Math.max(open, close) + Math.random() * vol * 0.6;
    const low = Math.min(open, close) - Math.random() * vol * 0.6;
    candles.push({ time: start + i * tfMs, open, high, low, close });
    price = close;
  }
  return candles;
}

function main(): void {
  const tfMs = config.candleTimeframeSeconds * 1000;
  const n = 2000; // 2000 candles
  const candles = genSynthetic(n, tfMs);
  const file = path.join(config.logsDir, 'candles.csv');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['time,open,high,low,close'];
  for (const c of candles) lines.push(`${c.time},${c.open},${c.high},${c.low},${c.close}`);
  fs.writeFileSync(file, lines.join('\n'));
  log.info('Gerados %d candles sintéticos em %s (TF=%ds)', n, file, config.candleTimeframeSeconds);
}

main();
