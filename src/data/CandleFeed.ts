import type { WebSocket } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Candle } from '../types.js';

const log = service('CandleFeed');

interface RawFrame {
  url: string;
  dir: 'in' | 'out';
  ts: number;
  payload: string;
  bytes: number;
}

interface Tick {
  time: number; // epoch ms
  price: number;
}

/**
 * Captura dados da Binomo interceptando WebSockets (protocolo Phoenix Channels).
 *
 * Formato real descoberto no discovery:
 *   Tick/quote:  {"data":[{"assets":[{"sent_at":"ISO","provider_time":"ISO","rate":641.86...}]}]}
 *   Range cfg:   {"event":"quotes_range","topic":"range_stream:ASSET","payload":{...}}
 *   Sentimento:  {"event":"majority_opinion","topic":"asset:ASSET","payload":{"call":N,"put":N}}
 *
 * A Binomo envia TICKS (cotações instantâneas), não candles.
 * Este feed agrega ticks em candles OHLC do timeframe configurado.
 */
export class CandleFeed {
  private sockets = new Set<WebSocket>();
  private candles: Candle[] = [];
  private lastCandle: Candle | null = null;
  private listeners = new Set<(c: Candle) => void>();
  private rawLog: RawFrame[] = [];
  private readonly maxRaw = 5000;

  private currentCandle: Candle | null = null;
  private currentBucketStart = 0;
  private readonly tfMs: number;

  private rawDumpPath: string | null = null;
  private rawDumpStream: fs.WriteStream | null = null;

  public sentiment: { call: number; put: number; asset: string } | null = null;
  public recentDeals: { direction: 'CALL' | 'PUT'; bet: number; ts: number }[] = [];
  public balance: { amount: number; currency: string; accountType: string } | null = null;
  /** Último preço recebido via tick. */
  public lastPrice: number | null = null;
  /** Timestamp do último tick recebido (ms). */
  public lastTickTime: number | null = null;
  private balanceWaiters = new Set<(balance: number) => void>();

  constructor(timeframeSeconds = 5) {
    this.tfMs = timeframeSeconds * 1000;
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  registerSocket(socket: WebSocket): void {
    this.sockets.add(socket);
  }

  /** Habilita gravação de frames brutos (sem truncar) em arquivo JSONL. */
  enableRawDump(filePath: string): void {
    this.rawDumpPath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.rawDumpStream = fs.createWriteStream(filePath, { flags: 'w' });
    log.info('Dump de frames brutos ativado: %s', filePath);
  }

  onCandle(cb: (c: Candle) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  handleOutgoing(url: string, data: string | Buffer): void {
    const payload = typeof data === 'string' ? data : data.toString('utf8');
    this.pushRaw(url, 'out', payload);
  }

  handleIncoming(url: string, data: string | Buffer): void {
    const payload = typeof data === 'string' ? data : data.toString('utf8');
    this.pushRaw(url, 'in', payload);

    this.processPhoenix(payload);
  }

  private processPhoenix(payload: string): void {
    if (!payload.startsWith('{') && !payload.startsWith('[')) return;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof json !== 'object' || json === null) return;

    // 1) Tick stream: {"data":[{"assets":[{sent_at, provider_time, rate}]}]}
    const ticks = extractTicks(json);
    if (ticks.length) {
      for (const t of ticks) this.ingestTick(t);
      return;
    }

    // 2) Sentimento: majority_opinion
    const obj = json as Record<string, unknown>;
    if (obj.event === 'majority_opinion' && obj.payload) {
      const p = obj.payload as { call?: number; put?: number; asset?: string };
      if (typeof p.call === 'number' && typeof p.put === 'number') {
        this.sentiment = { call: p.call, put: p.put, asset: p.asset ?? '' };
        log.debug('Sentimento: CALL %d%% / PUT %d%%', p.call, p.put);
      }
    }

    // 3) Social trading: trades reais de outros usuários
    if (obj.event === 'social_trading_deal' && obj.payload) {
      const p = obj.payload as { trend?: string; bet?: number; asset_ric?: string };
      if (p.trend && typeof p.bet === 'number') {
        const dir = p.trend === 'call' ? 'CALL' : 'PUT';
        this.recentDeals.push({ direction: dir, bet: p.bet, ts: Date.now() });
        if (this.recentDeals.length > 50) this.recentDeals.shift();
      }
    }

    // 4) Saldo da conta (balance_created / balance_changed)
    // A Binomo envia eventos de MÚLTIPLAS sub-contas demo (regular + torneio).
    // Filtramos por proximidade: só aceitamos saldos próximos ao último conhecido.
    if ((obj.event === 'balance_created' || obj.event === 'balance_changed') && obj.payload) {
      const p = obj.payload as { amount?: number; balance?: number; currency?: string; account_type?: string; balance_version?: number };
      const amt = typeof p.balance === 'number' ? p.balance : p.amount;
      if (typeof amt === 'number') {
        const accType = p.account_type ?? 'unknown';
        log.info('Evento saldo: type=%s amount=%s currency=%s', accType, (amt / 100).toFixed(2), p.currency);
        if (accType === 'demo') {
          const accept = this.shouldAcceptBalance(amt);
          if (accept) {
            this.balance = {
              amount: amt,
              currency: p.currency ?? 'BRL',
              accountType: 'demo',
            };
            log.info('Saldo demo aceito: %s %s', (amt / 100).toFixed(2), p.currency);
            this.balanceWaiters.forEach((cb) => cb(amt));
            this.balanceWaiters.clear();
          } else {
            log.debug('Saldo demo ignorado (conta diferente): %s %s', (amt / 100).toFixed(2), p.currency);
          }
        }
      }
    }
  }

  /**
   * Decide se um novo saldo deve ser aceito.
   * A Binomo envia balance_changed de múltiplas sub-contas demo (regular,
   * torneiro, etc.) que têm valores muito diferentes. Só aceitamos
   * saldos próximos ao último conhecido (within 30% range).
   * Exceção: se o último saldo for 0 (conta real vazia), aceita qualquer
   * valor demo não-zero para inicializar.
   */
  private shouldAcceptBalance(newAmount: number): boolean {
    if (!this.balance || this.balance.amount === 0) return true; // primeiro evento ou conta vazia — aceita
    const last = this.balance.amount;
    const ratio = newAmount / last;
    // aceita se está entre 50% e 150% do último saldo
    return ratio >= 0.5 && ratio <= 1.5;
  }

  private ingestTick(tick: Tick): void {
    this.lastTickTime = Date.now();
    // Filtro anti-contaminacao: se o preco divergir mais de 10% do ultimo, ignora
    // (protecao contra ticks de outro asset misturados no mesmo WS)
    if (this.lastPrice !== null && Math.abs(tick.price - this.lastPrice) / this.lastPrice > 0.10) {
      log.debug('Tick ignorado (preco divergente): %s vs ultimo %s', tick.price, this.lastPrice);
      return;
    }
    this.lastPrice = tick.price;
    const bucket = Math.floor(tick.time / this.tfMs) * this.tfMs;

    if (this.currentCandle && bucket === this.currentBucketStart) {
      // atualiza candle atual
      this.currentCandle.high = Math.max(this.currentCandle.high, tick.price);
      this.currentCandle.low = Math.min(this.currentCandle.low, tick.price);
      this.currentCandle.close = tick.price;
    } else {
      // fecha candle anterior
      if (this.currentCandle) this.commitCandle(this.currentCandle);
      // abre nova
      this.currentBucketStart = bucket;
      this.currentCandle = {
        time: bucket,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      };
    }
  }

  private commitCandle(c: Candle): void {
    if (this.lastCandle && c.time === this.lastCandle.time) {
      this.candles[this.candles.length - 1] = c;
    } else if (!this.lastCandle || c.time > this.lastCandle.time) {
      this.candles.push(c);
      this.lastCandle = c;
      this.writeCandleCsv(c);
      this.listeners.forEach((l) => l(c));
    }
    if (this.candles.length > 1000) this.candles = this.candles.slice(-1000);
  }

  /** Força o fechamento do candle em formação (útil ao parar). */
  flushCurrent(): void {
    if (this.currentCandle) {
      this.commitCandle(this.currentCandle);
      this.currentCandle = null;
    }
  }

  /** Ativa gravação contínua de candles em CSV (para backtest). */
  private csvStream: fs.WriteStream | null = null;
  enableCsvRecording(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const isNew = !fs.existsSync(filePath);
    this.csvStream = fs.createWriteStream(filePath, { flags: 'a' });
    if (isNew) {
      this.csvStream.write('time,open,high,low,close\n');
    }
    log.info('Gravação de candles em CSV ativada: %s', filePath);
  }

  private writeCandleCsv(c: Candle): void {
    if (this.csvStream) {
      this.csvStream.write(`${c.time},${c.open},${c.high},${c.low},${c.close}\n`);
    }
  }

  /** Espera o próximo evento de mudança de saldo (com timeout). */
  waitForBalanceChange(timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.balanceWaiters.delete(cb);
        resolve(null);
      }, timeoutMs);

      const cb = (balance: number) => {
        clearTimeout(timer);
        resolve(balance);
      };
      this.balanceWaiters.add(cb);
    });
  }

  private pushRaw(url: string, dir: 'in' | 'out', payload: string): void {
    this.rawLog.push({ url, dir, ts: Date.now(), payload, bytes: payload.length });
    if (this.rawLog.length > this.maxRaw) this.rawLog.shift();

    if (this.rawDumpStream) {
      this.rawDumpStream.write(JSON.stringify({ ts: Date.now(), dir, url, payload }) + '\n');
    }

    if (log.level === 'debug') {
      log.debug('[ws] %s %s %dB %s', dir.toUpperCase(), shortUrl(url), payload.length, preview(payload));
    }
  }

  getRawLog(): RawFrame[] {
    return [...this.rawLog];
  }

  getDiagnostics(): { socketCount: number; frameCount: number; candleCount: number; lastPrice: number | null; sentiment: unknown; balance: unknown } {
    return {
      socketCount: this.sockets.size,
      frameCount: this.rawLog.length,
      candleCount: this.candles.length,
      lastPrice: this.lastPrice,
      sentiment: this.sentiment,
      balance: this.balance,
    };
  }

  getCandles(count = 200): Candle[] {
    return this.candles.slice(-count);
  }

  has(minCount = 50): boolean {
    return this.candles.length >= minCount;
  }

  close(): void {
    this.flushCurrent();
    this.rawDumpStream?.end();
    this.csvStream?.end();
  }
}

/**
 * Busca recursivamente por pares chave:valor que contenham 'rate' numerico
 * ou 'sent_at' ISO em objetos aninhados (fallback para formatos desconhecidos).
 */
function deepFindTicks(node: unknown, depth = 0): Tick[] {
  if (depth > 6 || typeof node !== 'object' || node === null) return [];
  const out: Tick[] = [];
  const obj = node as Record<string, unknown>;
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'object' && item !== null) {
          const tick = item as Record<string, unknown>;
          const rate = Number(tick.rate);
          const timeStr = typeof tick.sent_at === 'string' ? tick.sent_at : tick.provider_time;
          if (Number.isFinite(rate) && typeof timeStr === 'string') {
            out.push({ time: parseIsoMs(timeStr), price: rate });
          } else {
            out.push(...deepFindTicks(item, depth + 1));
          }
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      out.push(...deepFindTicks(val, depth + 1));
    }
  }
  return out;
}

function shortUrl(u: string): string {
  try {
    return new URL(u).pathname || u;
  } catch {
    return u.slice(0, 40);
  }
}

function preview(s: string): string {
  const t = s.replace(/\s+/g, ' ').slice(0, 160);
  return t.length === s.length ? t : t + '…';
}

/**
 * Extrai ticks de um frame Phoenix da Binomo.
 * Formato: {"data":[{"assets":[{"sent_at":"ISO","rate":NUMBER}, ...]}]}
 * Pode haver múltiplos assets no array — filtramos pelo asset ativo se conhecido.
 */
function extractTicks(node: unknown): Tick[] {
  if (typeof node !== 'object' || node === null) return [];
  const obj = node as Record<string, unknown>;

  // formato tick conhecido: tem "data" -> array -> "assets"
  if (Array.isArray(obj.data)) {
    const out: Tick[] = [];
    for (const entry of obj.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const assets = (entry as Record<string, unknown>).assets;
      if (!Array.isArray(assets)) continue;
      for (const a of assets) {
        if (typeof a !== 'object' || a === null) continue;
        const tick = a as Record<string, unknown>;
        const rate = Number(tick.rate);
        const timeStr = typeof tick.sent_at === 'string' ? tick.sent_at : tick.provider_time;
        if (Number.isFinite(rate) && typeof timeStr === 'string') {
          out.push({ time: parseIsoMs(timeStr), price: rate });
        }
      }
    }
    if (out.length) return out;
  }

  // fallback: busca profunda por qualquer rate + sent_at em objetos aninhados
  return deepFindTicks(node);
}

function parseIsoMs(iso: string): number {
  // "2026-07-05T16:51:15.530120Z" -> epoch ms
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}
