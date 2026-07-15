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
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);

    log.info('URL apos navegacao: %s | titulo: %s', this.page.url(), await this.page.title());

    await this.ensureLoggedIn();

    // Se ainda estiver em /auth, tenta navegar diretamente para /trading
    if (this.page.url().includes('/auth')) {
      log.warn('Ainda na pagina de login. Tentando navegar diretamente para /trading...');
      await this.page.goto(config.binomoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      // Se ainda estiver no login com credenciais, tenta de novo
      if (this.page.url().includes('/auth') && config.email) {
        await this.ensureLoggedIn();
      }
    }

    // Aguarda elemento de trading (seletor de ativo ou gráfico)
    const tradingSelectors = [
      '[data-test="asset_selector"]',
      '[class*="chart"]',
      '[class*="trading"]',
      'canvas',
      '[class*="asset"]',
    ];
    for (const sel of tradingSelectors) {
      const found = await this.page.locator(sel).first().isVisible({ timeout: 5000 }).catch(() => false);
      if (found) {
        log.info('Elemento de trading encontrado: %s', sel);
        break;
      }
    }

    log.info('URL final: %s | titulo: %s', this.page.url(), await this.page.title());
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
    if (!config.email || !config.password) {
      log.warn('Sem credenciais BINOMO_EMAIL/BINOMO_PASSWORD no ambiente.');
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Verifica se ainda está na página de login
        const currentUrl = this.page.url();
        const needsLogin = currentUrl.includes('/auth') || currentUrl.includes('/login');

        if (!needsLogin) {
          // Verifica se há campos de email visíveis (fallback)
          const emailField = this.page.locator('input[type="email"], input[name="email"]').first();
          const hasLoginForm = await emailField.isVisible({ timeout: 2000 }).catch(() => false);
          if (!hasLoginForm) {
            log.info('Sessão já autenticada.');
            return;
          }
        }

        log.info('Tentativa %d/3: detectada página de login. Autenticando...', attempt);
        await this.performLogin();

        // Aguarda redirecionamento para /trading
        const redirected = await this.page
          .waitForURL('**/trading**', { timeout: 20000 })
          .then(() => true)
          .catch(() => false);

        if (redirected) {
          log.info('Login bem-sucedido! Redirecionado para trading.');
          await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
          return;
        }

        log.warn('Tentativa %d: login parece não ter funcionado (URL: %s)', attempt, this.page.url());
      } catch (err) {
        log.warn('Tentativa %d: erro no login: %s', attempt, (err as Error).message);
      }

      if (attempt < 3) {
        await sleep(2000);
      }
    }

    log.warn('Falha ao autenticar após 3 tentativas. Continuando mesmo assim...');
  }

  private async performLogin(): Promise<void> {
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[autocomplete="email"], input:not([type="hidden"])[name*="email"]';
    const passSel = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
    const btnSel =
      'button[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Acessar")';

    // Preenche email
    const emailInput = this.page.locator(emailSel).first();
    await emailInput.waitFor({ state: 'visible', timeout: 8000 }).catch(() => undefined);
    await emailInput.fill(config.email);
    log.info('Email preenchido');

    // Preenche senha
    const passInput = this.page.locator(passSel).first();
    await passInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    await passInput.fill(config.password);
    log.info('Senha preenchida');

    // Clica no botão de submit
    const btn = this.page.locator(btnSel).first();
    await btn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    await btn.click();
    log.info('Botão de login clicado. Aguardando redirecionamento...');
  }

  async selectAsset(asset: string): Promise<void> {
    try {
      log.info('Tentando selecionar ativo: %s', asset);
      // Tenta multiplos seletores para abrir o seletor de ativos
      const selectors = [
        '[data-test="asset_selector"]',
        '[class*="asset"][class*="select"]',
        '[class*="asset-picker"]',
        '[class*="header__asset"]',
        '[class*="header-asset"]',
        'button:has-text("' + asset.split('/')[0] + '")',
        '[class*="current-asset"]',
        '[class*="selected-asset"]',
      ];
      let opener = null;
      for (const sel of selectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          opener = el;
          log.info('Seletor de ativo encontrado: %s', sel);
          break;
        }
      }
      if (!opener) {
        log.warn('Nenhum seletor de ativo encontrado. O tick stream pode depender de selecao manual.');
        log.info('URL atual: %s', this.page.url());
        return;
      }
      await opener.click().catch(() => undefined);
      await sleep(800);
      // Tenta clicar no asset na lista — tenta o nome completo e depois a sigla
      const assetShort = asset.split('/')[0];
      const assetLocators = [
        `[class*="asset"]:has-text("${asset}")`,
        `text="${asset}"`,
        `text="${assetShort}"`,
        `[class*="list"]:has-text("${assetShort}") >> visible=true`,
      ];
      let clicked = false;
      for (const loc of assetLocators) {
        const item = this.page.locator(loc).first();
        if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
          await item.click({ timeout: 3000 }).catch(() => undefined);
          log.info('Ativo selecionado via: %s', loc);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        log.warn('Asset "%s" nao encontrado na lista. O tick stream pode nao iniciar.', asset);
      }
      await sleep(500);
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

  getPageInfoSync(): { url: string; title: string } {
    try {
      if (!this.page) return { url: 'no-page', title: '' };
      const url = this.page.url();
      return { url, title: '' };
    } catch {
      return { url: 'error', title: 'unknown' };
    }
  }

  async getPageTitle(): Promise<string> {
    try {
      return await this.page.title();
    } catch {
      return 'unknown';
    }
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
