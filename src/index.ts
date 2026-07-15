import { config } from './config.js';
import { service } from './logger.js';
import { BinomoBot } from './BinomoBot.js';

const log = service('main');

async function main(): Promise<void> {
  const argMode = process.argv
    .find((a) => a.startsWith('--mode='))
    ?.split('=')[1] as typeof config.mode | undefined;

  const mode = argMode ?? config.mode;
  log.info('arbinomo — bot Binomo (somente DEMO). Modo: %s', mode);

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
    await bot.run(mode);
  } catch (err) {
    log.error('Erro fatal: %s', (err as Error).stack ?? (err as Error).message);
    await bot.stop();
    process.exit(1);
  }
}

void main();
