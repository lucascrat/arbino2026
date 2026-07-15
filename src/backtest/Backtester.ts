import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Candle, Direction } from '../types.js';
import { SignalEngine, type MarketSentiment } from '../analysis/SignalEngine.js';

const log = service('Backtest');

interface BacktestTrade {
  entryTime: number;
  direction: Direction;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  score: number;
  result: 'WIN' | 'LOSS';
  payout: number;
  patterns: string[];
}

interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdown: number;
  equity: number[];
  avgScore: number;
}

/**
 * Backtester off-line: lê candles de um CSV gravado e simula a estratégia
 * do SignalEngine como se estivesse rodando ao vivo. Simula expiração
 * comparando preço de entrada vs preço N segundos depois.
 */
export class Backtester {
  constructor(
    private readonly engine: SignalEngine,
    private readonly expirationSeconds: number,
    private readonly payoutRate = 0.83
  ) {}

  /** Lê candles de CSV (formato: time,open,high,low,close). */
  static loadCsv(filePath: string): Candle[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const candles: Candle[] = [];
    let startIdx = 0;
    if (lines[0]?.startsWith('time,')) startIdx = 1;

    for (let i = startIdx; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 5) continue;
      const t = Number(parts[0]);
      const o = Number(parts[1]);
      const h = Number(parts[2]);
      const l = Number(parts[3]);
      const c = Number(parts[4]);
      if ([t, o, h, l, c].every(Number.isFinite)) {
        candles.push({ time: t, open: o, high: h, low: l, close: c });
      }
    }
    return candles.sort((a, b) => a.time - b.time);
  }

  /** Roda o backtest sobre um array de candles. */
  run(candles: Candle[], sentiment?: MarketSentiment | null): BacktestStats {
    const tfMs = candles.length >= 2 ? candles[1].time - candles[0].time : 5000;
    const expCandles = Math.max(1, Math.round(this.expirationSeconds * 1000 / tfMs));
    const trades: BacktestTrade[] = [];
    let lastSignalTime = 0;
    let cooldownUntil = 0;

    log.info('Backtest: %d candles | TF=%dms | expiração=%d candles (%ds)', candles.length, tfMs, expCandles, this.expirationSeconds);

    for (let i = 30; i < candles.length - expCandles; i++) {
      const window = candles.slice(0, i + 1);
      const lastTime = candles[i].time;

      if (lastTime === lastSignalTime) continue;
      if (lastTime < cooldownUntil) continue;

      const signal = this.engine.evaluate(window, sentiment ?? undefined);
      if (!signal) continue;

      lastSignalTime = lastTime;
      cooldownUntil = lastTime + config.cooldownSeconds * 1000;

      const entryPrice = candles[i].close;
      const exitCandle = candles[i + expCandles];
      const exitPrice = exitCandle.close;
      const won = signal.direction === 'CALL' ? exitPrice > entryPrice : exitPrice < entryPrice;

      const trade: BacktestTrade = {
        entryTime: lastTime,
        direction: signal.direction,
        entryPrice,
        exitTime: exitCandle.time,
        exitPrice,
        score: signal.score,
        result: won ? 'WIN' : 'LOSS',
        payout: won ? config.entryValue * this.payoutRate : -config.entryValue,
        patterns: signal.patterns,
      };
      trades.push(trade);

      if (trades.length % 50 === 0) {
        log.info('Progresso: %d trades simulados (i=%d/%d)', trades.length, i, candles.length);
      }
    }

    return this.computeStats(trades);
  }

  private computeStats(trades: BacktestTrade[]): BacktestStats {
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let maxConsecW = 0;
    let maxConsecL = 0;
    let curW = 0;
    let curL = 0;
    let maxDd = 0;
    let peak = 0;
    let equity = 0;
    const equityCurve: number[] = [];
    let scoreSum = 0;

    for (const t of trades) {
      scoreSum += t.score;
      if (t.result === 'WIN') {
        wins++;
        grossProfit += t.payout;
        curW++;
        curL = 0;
        maxConsecW = Math.max(maxConsecW, curW);
      } else {
        losses++;
        grossLoss += Math.abs(t.payout);
        curL++;
        curW = 0;
        maxConsecL = Math.max(maxConsecL, curL);
      }
      equity += t.payout;
      peak = Math.max(peak, equity);
      maxDd = Math.min(maxDd, equity - peak);
      equityCurve.push(equity);
    }

    const total = trades.length;
    return {
      totalTrades: total,
      wins,
      losses,
      winRate: total ? (wins / total) * 100 : 0,
      netProfit: equity,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxConsecutiveWins: maxConsecW,
      maxConsecutiveLosses: maxConsecL,
      maxDrawdown: maxDd,
      equity: equityCurve,
      avgScore: total ? scoreSum / total : 0,
    };
  }

  /** Imprime relatório detalhado do backtest. */
  printReport(stats: BacktestStats): void {
    log.info('═══════════════════ RELATÓRIO BACKTEST ═══════════════════');
    log.info('Trades totais:     %d', stats.totalTrades);
    log.info('Wins:              %d  |  Losses: %d', stats.wins, stats.losses);
    log.info('Win rate:          %s%%', stats.winRate.toFixed(2));
    log.info('Lucro líquido:     %s (entrada=%s, payout=%s%%)', stats.netProfit.toFixed(2), config.entryValue.toFixed(2), (this.payoutRate * 100).toFixed(0));
    log.info('Lucro bruto:       %s  |  Perda bruta: %s', stats.grossProfit.toFixed(2), stats.grossLoss.toFixed(2));
    log.info('Profit factor:     %s', Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞');
    log.info('Máx consec WINS:   %d  |  Máx consec LOSSES: %d', stats.maxConsecutiveWins, stats.maxConsecutiveLosses);
    log.info('Drawdown máximo:   %s', stats.maxDrawdown.toFixed(2));
    log.info('Score médio:       %s', stats.avgScore.toFixed(1));
    log.info('═══════════════════════════════════════════════════════════');
    log.info('Análise: %s', this.interpret(stats));
  }

  private interpret(s: BacktestStats): string {
    if (s.totalTrades < 20) return 'Poucos trades para conclusão (mínimo 20).';
    const parts: string[] = [];
    if (s.winRate >= 60) parts.push('WIN RATE BOM (>=60%)');
    else if (s.winRate >= 55) parts.push('WIN RATE ACEITÁVEL (55-60%)');
    else parts.push('WIN RATE BAIXO (<55%) — estratégia precisa de ajuste');
    if (Number.isFinite(s.profitFactor) && s.profitFactor >= 1.3) parts.push('PROFIT FACTOR SAUDÁVEL (>=1.3)');
    else parts.push('PROFIT FACTOR BAIXO (<1.3)');
    if (s.maxConsecutiveLosses >= 5) parts.push('DRAWDOWN RISCO ALTO (>=5 losses consec)');
    return parts.join(' | ');
  }
}

/** Entry point para modo backtest (lê CSV e roda). */
export async function runBacktest(csvPath?: string): Promise<void> {
  const file = csvPath ?? path.join(config.logsDir, 'candles.csv');
  if (!fs.existsSync(file)) {
    log.error('Arquivo de candles não encontrado: %s', file);
    log.error('Rode primeiro o modo trade/discovery para gravar candles.');
    return;
  }
  log.info('Carregando candles de: %s', file);
  const candles = Backtester.loadCsv(file);
  if (candles.length < 50) {
    log.error('Apenas %d candles carregados. Mínimo 50 para backtest.', candles.length);
    return;
  }

  const engine = new SignalEngine(config.minSignalScore);
  const bt = new Backtester(engine, config.expirationSeconds);
  const stats = bt.run(candles);
  bt.printReport(stats);

  // Salva relatório em arquivo
  const reportPath = path.join(config.logsDir, `backtest_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ stats: { ...stats, equity: undefined }, config: { tf: config.candleTimeframeSeconds, exp: config.expirationSeconds, entry: config.entryValue, minScore: config.minSignalScore }, date: new Date().toISOString() }, null, 2));
  log.info('Relatório salvo em: %s', reportPath);
}
