import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? (n as number) : fallback;
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export interface AppConfig {
  email: string;
  password: string;
  mode: 'discovery' | 'trade' | 'backtest';
  userDataDir: string;
  expirationSeconds: number;
  candleTimeframeSeconds: number;
  entryValue: number;
  asset: string;
  maxDailyTrades: number;
  maxDailyLoss: number;
  maxDailyProfit: number;
  martingaleLevels: number;
  martingaleMultiplier: number;
  cooldownSeconds: number;
  minSignalScore: number;
  sessionFilter: 'forex' | 'synthetic' | 'custom' | 'always';
  sessionStartHour: number;
  sessionEndHour: number;
  pollIntervalMs: number;
  recordCandles: boolean;
  headless: boolean;
  binomoUrl: string;
  logsDir: string;
  payoutPercent: number;
  adminPassword: string;
  houseNearMissAtr: number;
  crowdContrarianMinSamples: number;
  crowdContrarianEdgePts: number;
  houseMinAtrNormalized: number;
  aiEnabled: boolean;
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  aiMinConfidence: number;
  aiTimeoutMs: number;
}

export const config: AppConfig = {
  email: envStr('BINOMO_EMAIL', ''),
  password: envStr('BINOMO_PASSWORD', ''),
  mode: envStr('MODE', 'discovery') as 'discovery' | 'trade' | 'backtest',
  userDataDir: path.resolve(root, envStr('USER_DATA_DIR', '.binomo-profile')),
  expirationSeconds: envNum('EXPIRATION_SECONDS', 60),
  candleTimeframeSeconds: envNum('CANDLE_TIMEFRAME_SECONDS', 15),
  entryValue: envNum('ENTRY_VALUE', 5),
  asset: envStr('ASSET', 'Z-CRY/IDX'),
  maxDailyTrades: envNum('MAX_DAILY_TRADES', 20),
  maxDailyLoss: envNum('MAX_DAILY_LOSS', 100),
  maxDailyProfit: envNum('MAX_DAILY_PROFIT', 0),
  martingaleLevels: envNum('MARTINGALE_LEVELS', 0),
  martingaleMultiplier: envNum('MARTINGALE_MULTIPLIER', 2.0),
  cooldownSeconds: envNum('COOLDOWN_SECONDS', 15),
  minSignalScore: envNum('MIN_SIGNAL_SCORE', 80),
  sessionFilter: envStr('SESSION_FILTER', 'synthetic') as 'forex' | 'synthetic' | 'custom' | 'always',
  sessionStartHour: envNum('SESSION_START_HOUR', 7),
  sessionEndHour: envNum('SESSION_END_HOUR', 16),
  pollIntervalMs: envNum('POLL_INTERVAL_MS', 1000),
  recordCandles: envBool('RECORD_CANDLES', true),
  headless: envBool('HEADLESS', false),
  binomoUrl: 'https://binomo.com/trading',
  logsDir: path.resolve(root, envStr('DATA_DIR', 'logs')),
  payoutPercent: envNum('PAYOUT_PERCENT', 0.83),
  adminPassword: envStr('ADMIN_PASSWORD', ''),
  houseNearMissAtr: envNum('HOUSE_NEAR_MISS_ATR', 0.15),
  crowdContrarianMinSamples: envNum('CROWD_CONTRARIAN_MIN_SAMPLES', 30),
  crowdContrarianEdgePts: envNum('CROWD_CONTRARIAN_EDGE_PTS', 10),
  houseMinAtrNormalized: envNum('HOUSE_MIN_ATR_NORMALIZED', 0),
  aiEnabled: envBool('AI_ENABLED', false),
  aiEndpoint: envStr('AI_ENDPOINT', 'https://api.groq.com/openai/v1'),
  aiApiKey: envStr('AI_API_KEY', ''),
  aiModel: envStr('AI_MODEL', 'llama-3.3-70b-versatile'),
  aiMinConfidence: envNum('AI_MIN_CONFIDENCE', 30),
  aiTimeoutMs: envNum('AI_TIMEOUT_MS', 10000),
};

/** Sobrescreve campos do config em runtime (usado pela IA de estrategia e por settings do banco). */
export function updateConfig(partial: Partial<AppConfig>): void {
  Object.assign(config, partial);
}
