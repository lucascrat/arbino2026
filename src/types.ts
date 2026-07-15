export type Direction = 'CALL' | 'PUT';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Signal {
  direction: Direction;
  score: number;
  reasons: string[];
  candleTime: number;
  patterns: string[];
}

export interface TradeResult {
  id: string;
  direction: Direction;
  entryValue: number;
  expiration: number;
  placedAt: number;
  status: 'WIN' | 'LOSS' | 'TIE' | 'PENDING' | 'ERROR';
  payout?: number;
  asset: string;
}

export type RunMode = 'discovery' | 'trade' | 'backtest';
