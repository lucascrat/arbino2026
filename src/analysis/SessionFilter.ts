import { config } from '../config.js';
import { service } from '../logger.js';

const log = service('SessionFilter');

/**
 * Filtro de horário de trading.
 *
 * Opções binárias sintéticas (como Z-CRY/IDX) funcionam 24/7, mas a
 * liquidez e a "qualidade" do movimento variam. Para ativos forex
 * tradicionais, os melhores horários são durante sessões overlapping.
 *
 * Por padrão, permitimos trading apenas em horários considerados
 * mais favoráveis. Fora disso, o bot pausa (não entra trades).
 *
 * Horários em UTC (a Binomo usa UTC nos timestamps).
 */

interface SessionWindow {
  startHour: number; // 0-23 UTC
  endHour: number; // 0-23 UTC (pode passar da meia-noite)
  name: string;
}

// Sessões forex clássicas (UTC)
const FOREX_SESSIONS: SessionWindow[] = [
  { startHour: 7, endHour: 11, name: 'Londres' },       // 07:00-11:00 UTC
  { startHour: 12, endHour: 16, name: 'Nova York' },    // 12:00-16:00 UTC
  { startHour: 7, endHour: 16, name: 'Londres+NY overlap' },
];

// Sessão para sintéticos 24/7 (sempre permitido)
const ALWAYS_OPEN: SessionWindow[] = [{ startHour: 0, endHour: 24, name: '24/7' }];

export class SessionFilter {
  private windows: SessionWindow[];
  private readonly mode: 'forex' | 'synthetic' | 'custom' | 'always';
  private customStart: number;
  private customEnd: number;

  constructor() {
    this.mode = config.sessionFilter;
    this.customStart = config.sessionStartHour;
    this.customEnd = config.sessionEndHour;

    if (this.mode === 'forex') this.windows = FOREX_SESSIONS;
    else if (this.mode === 'synthetic' || this.mode === 'always') this.windows = ALWAYS_OPEN;
    else this.windows = [{ startHour: this.customStart, endHour: this.customEnd, name: 'custom' }];
  }

  /** Verifica se o horário atual (UTC) está dentro de uma sessão ativa. */
  isTradableNow(date = new Date()): { allowed: boolean; session?: string; nextOpenInMin?: number } {
    const hourUtc = date.getUTCHours();
    const minUtc = date.getUTCMinutes();
    const totalMin = hourUtc * 60 + minUtc;

    for (const w of this.windows) {
      if (this.inWindow(totalMin, w)) {
        return { allowed: true, session: w.name };
      }
    }

    // calcula minutos até próxima abertura
    let nextMin = Infinity;
    let nextName = '';
    for (const w of this.windows) {
      const startMin = w.startHour * 60;
      let diff = startMin - totalMin;
      if (diff < 0) diff += 24 * 60;
      if (diff < nextMin) {
        nextMin = diff;
        nextName = w.name;
      }
    }

    return { allowed: false, session: nextName, nextOpenInMin: nextMin === Infinity ? undefined : Math.round(nextMin) };
  }

  private inWindow(totalMin: number, w: SessionWindow): boolean {
    const start = w.startHour * 60;
    const end = w.endHour * 60;
    if (start <= end) return totalMin >= start && totalMin < end;
    // wrap-around (ex: 22-2)
    return totalMin >= start || totalMin < end;
  }

  /** Loga status atual uma vez por mudança de estado. */
  private lastStatus: string | null = null;
  logStatus(): void {
    const s = this.isTradableNow();
    const status = s.allowed ? `OPEN (${s.session})` : `CLOSED (próxima: ${s.session} em ${s.nextOpenInMin}min)`;
    if (status !== this.lastStatus) {
      if (s.allowed) log.info('Sessão de trading: %s', status);
      else log.warn('Fora de sessão de trading: %s', status);
      this.lastStatus = status;
    }
  }
}
