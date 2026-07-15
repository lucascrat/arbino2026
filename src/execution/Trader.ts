import type { Page } from 'playwright';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Direction, Signal, TradeResult } from '../types.js';

const log = service('Trader');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Camada de execução: clica nos botões CALL/PUT da interface Binomo.
 *
 * Seletores descobertos via modo discovery (DOM real da Binomo):
 *   CALL:  #qa_trading_dealUpButton   (vui-button, .button_green, .analytics-call)
 *   PUT:   #qa_trading_dealDownButton (vui-button, .button_red,   .analytics-put)
 *   Valor: input.input-controls_input-lower  (1º input, y~101)
 *   Exp.:  input.input-controls_input-lower  (2º input, y~165)
 *
 * A Binomo usa web components (vui-button) envolvendo <button> reais.
 * Clicamos no ID estável do vui-button.
 */
export class Trader {
  constructor(private readonly page: Page) {}

  /** Lê o saldo atual da conta demo da interface (DOM). */
  async readBalance(): Promise<number | null> {
    // Procura por elementos que mostram o saldo na interface da Binomo.
    // A Binomo mostra o saldo em elementos com classes relacionadas a balance.
    const selectors = [
      '[data-test-id*="balance" i]',
      '[class*="account-balance" i]',
      '[class*="balance" i][class*="amount" i]',
      '[class*="balance" i]:not([class*="button" i])',
      '[class*="money" i]',
    ];

    for (const sel of selectors) {
      const text = await this.page
        .locator(sel)
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null);
      if (text) {
        const num = parseBalance(text);
        if (num !== null) {
          log.debug('Saldo DOM (%s): %s -> %s', sel, text.trim().slice(0, 30), num);
          return num;
        }
      }
    }
    return null;
  }

  async execute(signal: Signal, entryValue: number): Promise<TradeResult> {
    const id = `T${Date.now()}`;
    const result: TradeResult = {
      id,
      direction: signal.direction,
      entryValue,
      expiration: config.expirationSeconds,
      placedAt: Date.now(),
      status: 'PENDING',
      asset: config.asset,
    };

    try {
      // Espera overlay de dashboard sumir antes de interagir
      await this.waitForOverlayGone();

      await this.setAmount(entryValue);
      await this.setExpiration(config.expirationSeconds);
      const ok = await this.clickDirection(signal.direction);
      if (!ok) {
        result.status = 'ERROR';
        log.error('Botão %s não clicável. Trade abortado.', signal.direction);
        return result;
      }
      // Aguarda possivel modal de confirmacao
      await this.confirmTrade();
      log.info('Trade executado: %s valor=%s exp=%ds score=%d', signal.direction, entryValue.toFixed(2), config.expirationSeconds, signal.score);
    } catch (err) {
      result.status = 'ERROR';
      log.error('Erro na execução: %s', (err as Error).message);
    }
    return result;
  }

  private async waitForOverlayGone(): Promise<void> {
    const overlay = this.page.locator('.dashboard-overlay');
    const visible = await overlay.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (visible) {
      log.debug('Dashboard overlay visivel - aguardando sumir...');
      await overlay.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    }
  }

  /** Apos clicar CALL/PUT, algumas versoes da Binomo mostram modal de confirmacao */
  private async confirmTrade(): Promise<void> {
    const confirmSelectors = [
      'button:has-text("Confirm")',
      'button:has-text("Confirmar")',
      'button:has-text("Sim")',
      'button:has-text("OK")',
      '[class*="confirm" i] button',
      '[class*="confirm" i]',
      '[data-testid*="confirm" i]',
    ];
    for (const sel of confirmSelectors) {
      const btn = this.page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        log.info('Modal de confirmacao detectado. Confirmando...');
        await btn.click({ timeout: 3000 }).catch(() => undefined);
        return;
      }
    }
  }

  private async setAmount(value: number): Promise<void> {
    const selectors = [
      'input[class*="input-controls_input-lower"]',
      'input[class*="amount" i]',
      'input[class*="input-lower"]',
      'input[data-testid*="amount" i]',
    ];
    let input: import('playwright').Locator | null = null;
    for (const sel of selectors) {
      const el = this.page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        input = el;
        break;
      }
    }
    if (!input) {
      log.warn('Campo de valor nao encontrado. Tentando keyboard shortcut...');
      // Fallback: tenta tab ate o campo de valor
      for (let i = 0; i < 5; i++) {
        await this.page.keyboard.press('Tab').catch(() => undefined);
        await sleep(100);
      }
      await this.page.keyboard.type(String(value)).catch(() => undefined);
      return;
    }
    await input.click({ timeout: 3000 }).catch(() => undefined);
    await this.page.keyboard.press('Control+a').catch(() => undefined);
    await this.page.keyboard.press('Delete').catch(() => undefined);
    await input.fill(String(value), { timeout: 3000 }).catch(() => undefined);
    await this.page.keyboard.press('Enter').catch(() => undefined);
    log.info('Valor definido: R$ %s', value.toFixed(2));
  }

  private async setExpiration(seconds: number): Promise<void> {
    const selectors = [
      'input[class*="input-controls_input-lower"]',
      'input[class*="expiration" i]',
      'input[class*="input-lower"]',
      'input[data-testid*="expir" i]',
    ];
    let expInput: import('playwright').Locator | null = null;
    // Tenta o segundo input de amount se existir
    const inputs = this.page.locator('input[class*="input-controls_input-lower"]');
    if ((await inputs.count().catch(() => 0)) >= 2) {
      const second = inputs.nth(1);
      if (await second.isVisible({ timeout: 1000 }).catch(() => false)) {
        expInput = second;
      }
    }
    if (!expInput) {
      for (const sel of selectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          const all = this.page.locator(sel);
          const count = await all.count().catch(() => 0);
          // Se ha multiplos, pega o ultimo (geralmente expiracao)
          expInput = count > 1 ? all.nth(count - 1) : el;
          break;
        }
      }
    }
    if (!expInput) {
      log.warn('Campo de expiracao nao encontrado. Usando expiracao atual.');
      return;
    }
    await expInput.click({ timeout: 3000 }).catch(() => undefined);
    await this.page.keyboard.press('Control+a').catch(() => undefined);
    await this.page.keyboard.press('Delete').catch(() => undefined);
    await expInput.type(String(seconds), { timeout: 3000 }).catch(() => undefined);
    await this.page.keyboard.press('Enter').catch(() => undefined);
    log.info('Expiracao definida: %ds', seconds);
  }

  private async clickDirection(direction: Direction): Promise<boolean> {
    const buttons: { label: string; selector: string }[] = direction === 'CALL'
      ? [
          { label: 'CALL', selector: '#qa_trading_dealUpButton' },
          { label: 'CALL', selector: '[class*="dealUpButton" i]' },
          { label: 'CALL', selector: '[class*="upButton" i]' },
          { label: 'CALL', selector: 'button[class*="green"]' },
          { label: 'CALL', selector: '[data-testid*="call" i]' },
        ]
      : [
          { label: 'PUT', selector: '#qa_trading_dealDownButton' },
          { label: 'PUT', selector: '[class*="dealDownButton" i]' },
          { label: 'PUT', selector: '[class*="downButton" i]' },
          { label: 'PUT', selector: 'button[class*="red"]' },
          { label: 'PUT', selector: '[data-testid*="put" i]' },
        ];

    for (const btn of buttons) {
      const loc = this.page.locator(btn.selector);
      const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      const enabled = await loc.isEnabled({ timeout: 1000 }).catch(() => false);
      if (!enabled) {
        log.warn('Botao %s (%s) encontrado mas desabilitado.', btn.label, btn.selector);
        continue;
      }
      try {
        await loc.click({ timeout: 5000, force: true });
        log.info('Clique OK em %s via [%s]', btn.label, btn.selector);
        return true;
      } catch (err) {
        log.warn('Falha ao clicar %s via [%s]: %s', btn.label, btn.selector, (err as Error).message);
      }
    }
    log.error('Nenhum boto %s viavel encontrado na pagina.', direction);
    return false;
  }

  /**
   * Lê o resultado do último trade a partir do histórico da Binomo.
   * A plataforma mostra deals fechados numa lista com lucro/prejuízo.
   * Procura pelo último item com texto de resultado.
   */
  async readLastResult(): Promise<'WIN' | 'LOSS' | 'PENDING' | 'UNKNOWN'> {
    // Strategy 1: toast/notificação (imediato)
    const toast = await this.page
      .locator('[class*="toast" i], [class*="notification" i], [class*="snackbar" i]')
      .first()
      .textContent({ timeout: 2000 })
      .catch(() => null);
    if (toast) {
      const t = toast.toLowerCase();
      if (/(lucro|ganho|win|profit|sucesso|\+)/i.test(t)) return 'WIN';
      if (/(loss|perd|preju|perda|-)/i.test(t)) return 'LOSS';
    }

    // Strategy 2: histórico de deals (mais confiável, mas pode demorar a aparecer)
    const dealItem = await this.page
      .locator('[class*="deal" i][class*="item" i], [class*="history" i] [class*="item" i], [class*="trade-result" i]')
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);
    if (dealItem) {
      const d = dealItem.toLowerCase();
      if (/(lucro|ganho|win|profit|\+\$|\+\d)/i.test(d)) return 'WIN';
      if (/(loss|perd|preju|perda|-\$|-\d)/i.test(d)) return 'LOSS';
    }

    return 'UNKNOWN';
  }
}

/**
 * Converte texto de saldo da Binomo (ex: "R$ 54.115,70" ou "54115.70") em centavos.
 * Lida com formatos BR e US.
 */
function parseBalance(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;

  // Formato BR: "54.115,70" -> 5411570 centavos
  // Formato US: "54,115.70" -> 5411570 centavos
  // Simples: "54115.70" -> 5411570 centavos

  let result: number;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // Ambos presentes — assume que o último é o separador decimal
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // Formato BR: ponto=milhares, vírgula=decimal
      result = Number(cleaned.replace(/\./g, '').replace(',', '.'));
    } else {
      // Formato US: vírgula=milhares, ponto=decimal
      result = Number(cleaned.replace(/,/g, ''));
    }
  } else if (cleaned.includes(',')) {
    // Só vírgula — assume decimal BR
    result = Number(cleaned.replace(',', '.'));
  } else {
    // Só ponto ou nenhum separador
    result = Number(cleaned);
  }

  if (!Number.isFinite(result)) return null;
  // Converte para centavos
  return Math.round(result * 100);
}
