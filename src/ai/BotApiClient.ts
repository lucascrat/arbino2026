import { service } from '../logger.js';
import type { BotEvent, DiagnosticInfo } from '../server/ApiServer.js';

const log = service('BotApi');

/**
 * Cliente HTTP para o bot enviar eventos em tempo real ao servidor API.
 * O servidor API então repassa os eventos ao frontend via WebSocket.
 */
export type { DiagnosticInfo } from '../server/ApiServer.js';

export class BotApiClient {
  private baseUrl: string;
  public sessionId: string;
  private consecutiveFailures = 0;
  private maxFailures = 5;
  private disabledLogged = false;

  constructor(baseUrl = 'http://localhost:3456', sessionId?: string) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId ?? `S${Date.now()}`;
  }

  async sendEvent(event: BotEvent): Promise<unknown> {
    if (this.consecutiveFailures >= this.maxFailures) {
      if (!this.disabledLogged) {
        log.warn('API client desabilitado apos %d falhas consecutivas. (supressao de logs ativa)', this.consecutiveFailures);
        this.disabledLogged = true;
      }
      return;
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.consecutiveFailures = 0;
      return await res.json().catch(() => ({ ok: true }));
    } catch (err) {
      this.consecutiveFailures++;
      log.debug('Falha ao enviar evento (%d/%d): %s', this.consecutiveFailures, this.maxFailures, (err as Error).message);
      return;
    }
  }

  sendLog(level: string, svc: string, message: string): void {
    void this.sendEvent({ type: 'log', level, service: svc, message, ts: Date.now() });
  }

  sendCandle(candle: { time: number; open: number; high: number; low: number; close: number }): void {
    void this.sendEvent({ type: 'candle', candle });
  }

  sendSignal(signal: unknown, aiVerdict: unknown, executed: boolean): void {
    void this.sendEvent({ type: 'signal', signal, aiVerdict, executed });
  }

  sendTrade(trade: unknown): Promise<unknown> {
    return this.sendEvent({ type: 'trade', trade });
  }

  sendResult(trade: unknown): void {
    void this.sendEvent({ type: 'result', trade });
  }

  sendBalance(balance: number, currency: string): void {
    void this.sendEvent({ type: 'balance', balance, currency });
  }

  sendWarmup(candles: number, target: number): void {
    void this.sendEvent({ type: 'warmup', candles, target });
  }

  sendDiagnostic(info: DiagnosticInfo): void {
    void this.sendEvent({ type: 'diagnostic', info });
  }
}
