import { chromium, type BrowserContext, type Page, type WebSocket } from 'playwright';
import { config } from '../config.js';
import { service } from '../logger.js';
import type { Candle } from '../types.js';
import { CandleFeed } from './CandleFeed.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = service('BrowserSession');

export class BrowserSession {
  private ctx!: BrowserContext;
  private page!: Page;
  private feed: CandleFeed;
  public readonly ready = false;

  constructor(feed: CandleFeed) {
    this.feed = feed;
  }

  async start(): Promise<void> {
    log.info('Abrindo Chromium (perfil persistente em %s)', config.userDataDir);
    this.ctx = await chromium.launchPersistentContext(config.userDataDir, {
      headless: config.headless,
      viewport: { width: 1366, height: 850 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      args: ['--disable-blink-features=AutomationControlled'],
    });

    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());

    this.attachWebsocketInterceptor();

    log.info('Navegando para %s', config.binomoUrl);
    await this.page.goto(config.binomoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Aguarda a página estabilizar (sem reload — reload pode perder a sessão WS)
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);

    await this.ensureLoggedIn();
    (this as { ready: boolean }).ready = true;
    log.info('Sessão pronta.');
  }

  private attachWebsocketInterceptor(): void {
    this.page.on('websocket', (socket: WebSocket) => {
      const url = socket.url();
      log.debug('WS aberto: %s', url);
      this.feed.registerSocket(socket);

      socket.on('framesent', (data) => {
        this.feed.handleOutgoing(url, data.payload);
      });
      socket.on('framereceived', (data) => {
        this.feed.handleIncoming(url, data.payload);
      });
      socket.on('close', () => log.debug('WS fechado: %s', url));
    });
  }

  private async ensureLoggedIn(): Promise<void> {
    if (config.email && config.password) {
      try {
        const loginVisible = await this.page
          .locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]')
          .first()
          .isVisible({ timeout: 4000 })
          .catch(() => false);

        if (loginVisible) {
          log.info('Formulário de login detectado. Autenticando...');
          await this.performLogin();
        } else {
          log.info('Sessão já autenticada (perfil persistente).');
        }
      } catch (err) {
        log.warn('Falha ao verificar login: %s', (err as Error).message);
      }
    } else {
      log.warn(
        'Sem credenciais no .env. Faça login manualmente no navegador aberto. O perfil será salvo.'
      );
    }
  }

  private async performLogin(): Promise<void> {
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="mail" i]';
    const passSel = 'input[type="password"], input[name="password"]';
    const btnSel =
      'button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Log in")';

    await this.page.locator(emailSel).first().fill(config.email);
    await this.page.locator(passSel).first().fill(config.password);
    await this.page.locator(btnSel).first().click();
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
    log.info('Login enviado. Aguardando interface de trading...');
  }

  async selectAsset(asset: string): Promise<void> {
    try {
      // Tenta multiplos seletores para abrir o seletor de ativos
      const selectors = [
        '[data-test="asset_selector"]',
        '[class*="asset"][class*="select"]',
        '[class*="asset-picker"]',
        '[class*="header__asset"]',
        'button:has-text("' + asset.split('/')[0] + '")',
      ];
      let opener = null;
      for (const sel of selectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          opener = el;
          break;
        }
      }
      if (!opener) {
        log.warn('Seletor de ativo não encontrado. O tick stream pode depender de seleção manual.');
        return;
      }
      await opener.click().catch(() => undefined);
      await sleep(500);
      // Tenta clicar no asset na lista
      const assetItem = this.page
        .locator(`[class*="asset"]:has-text("${asset}")`)
        .first();
      if (await assetItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await assetItem.click({ timeout: 3000 }).catch(() => undefined);
        log.info('Ativo selecionado: %s', asset);
      } else {
        log.warn('Asset "%s" não encontrado na lista. O tick stream pode não iniciar.', asset);
      }
    } catch (err) {
      log.warn('Erro ao selecionar ativo: %s', (err as Error).message);
    }
  }

  /**
   * Captura o estado bruto da página (útil no modo discovery).
   * Tenta ler dados do gráfico via JS, caso a plataforma exponha globals.
   */
  async dumpChartState(): Promise<unknown> {
    return this.page
      .evaluate(() => {
        const winAny = window as unknown as Record<string, unknown>;
        const keys = Object.keys(winAny).filter((k) =>
          /chart|candle|ohlc|quote|tick|symbol|trader|store/i.test(k)
        );
        const bag: Record<string, unknown> = {};
        for (const k of keys) {
          try {
            bag[k] = (winAny[k] as object | undefined)?.toString?.()?.slice(0, 500);
          } catch {
            bag[k] = '<inacessível>';
          }
        }
        return {
          globals: bag,
          title: document.title,
          url: location.href,
        };
      })
      .catch((err) => ({ error: (err as Error).message }));
  }

  /**
   * Inspeciona o DOM procurando elementos relacionados à execução de trade:
   * botões de CALL/PUT, campos de valor, seletor de expiração, etc.
   * Retorna uma estrutura JSON para análise no modo discovery.
   */
  async dumpTradeDom(): Promise<unknown> {
    return this.page
      .evaluate(() => {
        const describe = (el: Element): Record<string, unknown> => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const dataAttrs: Record<string, string> = {};
          for (const a of Array.from(el.attributes)) {
            if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value.slice(0, 100);
          }
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 200) : undefined,
            text: (el.textContent ?? '').trim().slice(0, 80),
            dataAttrs,
            visible: r.width > 0 && r.height > 0,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
        };

        const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="button" i]'))
          .map(describe)
          .filter((b) => b.visible);

        const inputs = Array.from(document.querySelectorAll('input'))
          .map(describe)
          .filter((b) => b.visible);

        const tradeTexts = Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const t = (el.textContent ?? '').trim().toLowerCase();
            return t.length < 30 && /^(subir|descer|comprar|vender|acima|abaixo|up|down|call|put)$/.test(t);
          })
          .map(describe)
          .filter((b) => b.visible);

        return {
          url: location.href,
          buttons: buttons.slice(0, 40),
          inputs: inputs.slice(0, 15),
          tradeTexts: tradeTexts.slice(0, 20),
        };
      })
      .catch((err) => ({ error: (err as Error).message }));
  }

  async getLastCandlesFromDom(): Promise<Candle[]> {
    return this.page
      .evaluate(() => {
        // Placeholder heurístico — adaptar conforme DOM real observado no discovery.
        const els = Array.from(document.querySelectorAll('[class*="candle"], [class*="bar"]'));
        return els.slice(-60).map((el, i) => ({
          time: Date.now() - (60 - i) * 1000,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          _text: (el.textContent ?? '').slice(0, 50),
        }));
      })
      .catch(() => []);
  }

  getPage(): Page {
    return this.page;
  }

  async close(): Promise<void> {
    try {
      await this.ctx?.close();
    } catch {
      /* noop */
    }
    log.info('Sessão encerrada.');
  }
}
