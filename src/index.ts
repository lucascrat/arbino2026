import { config } from './config.js';
import { service } from './logger.js';
import { BinomoBot } from './BinomoBot.js';
import { CandleFeed } from './data/CandleFeed.js';
import { BrowserSession } from './data/BrowserSession.js';

const log = service('main');

async function main(): Promise<void> {
  const argMode = process.argv
    .find((a) => a.startsWith('--mode='))
    ?.split('=')[1];

  const mode: string = argMode ?? config.mode;
  log.info('arbinomo — bot Binomo (somente DEMO). Modo: %s', mode);

  // Modo especial: setup manual de login
  if (String(mode) === 'setup-login') {
    log.info('=== MODO SETUP LOGIN ===');
    log.info('Abrindo navegador para login manual (use o VNC para interagir)');
    const feed = new CandleFeed(config.candleTimeframeSeconds);
    const session = new BrowserSession(feed);
    try {
      await session.start(true);
      log.info('Navegador aberto. URL: %s', session.getPageInfoSync().url);
      log.info('Faça login manualmente. Pressione Ctrl+C para encerrar.');
      // Mantém o processo vivo até receber SIGINT/SIGTERM
      await new Promise<void>((_, reject) => {
        process.on('SIGINT', () => reject(new Error('SIGINT')));
        process.on('SIGTERM', () => reject(new Error('SIGTERM')));
      });
    } catch (err) {
      log.info('Setup encerrado: %s', (err as Error).message);
    }
    await session.close();
    log.info('Perfil salvo em: %s', config.userDataDir);
    process.exit(0);
  }

  if (mode === 'trade' && !config.email) {
    log.warn('Sem BINOMO_EMAIL no .env. Você poderá fazer login manualmente no navegador aberto.');
  }

  const bot = new BinomoBot();

  const shutdown = async (sig: string) => {
    log.info('Recebido %s. Encerrando...', sig);
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await bot.run(mode as typeof config.mode);
  } catch (err) {
    log.error('Erro fatal: %s', (err as Error).stack ?? (err as Error).message);
    await bot.stop();
    process.exit(1);
  }
}

void main();
