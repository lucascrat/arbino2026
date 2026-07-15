import { ApiServer } from './ApiServer.js';
import { service } from '../logger.js';

const log = service('ServerMain');

async function main(): Promise<void> {
  const port = Number(process.env.API_PORT) || 3456;
  const api = new ApiServer(port);
  await api.start();

  process.on('SIGINT', async () => {
    await api.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await api.stop();
    process.exit(0);
  });
}

void main().catch((err) => {
  log.error('Erro fatal: %s', (err as Error).message);
  process.exit(1);
});
