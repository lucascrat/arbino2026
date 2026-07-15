import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../server/ApiServer.js';
import { BinomoBot } from '../BinomoBot.js';
import { AppDatabase } from '../db/Database.js';
import { config } from '../config.js';
import { service } from '../logger.js';

const log = service('Electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let api: ApiServer | null = null;
let bot: BinomoBot | null = null;
let botRunning = false;

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Arbinomo — Bot de Trading',
    backgroundColor: '#0a0e17',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Carrega o dashboard do servidor Express
  await win.loadURL(`http://localhost:${api!.port}`);
  // win.webContents.openDevTools();
}

async function bootstrap(): Promise<void> {
  log.info('Iniciando Arbinomo Desktop...');

  // Inicia API + banco
  const db = new AppDatabase();
  api = new ApiServer(3456, db);
  await api.start();

  // Cria a janela
  await createWindow();

  // IPC handlers para o frontend controlar o bot
  ipcMain.handle('bot:start', async (_evt, mode: string) => {
    if (botRunning) return { ok: false, message: 'Bot já está rodando' };
    botRunning = true;
    bot = new BinomoBot();
    // Roda em background (não bloqueia a UI)
    bot.run(mode as 'trade' | 'discovery').catch((err: unknown) => {
      log.error('Bot erro: %s', (err as Error).message);
      botRunning = false;
    });
    return { ok: true, message: `Bot iniciado no modo ${mode}` };
  });

  ipcMain.handle('bot:stop', async () => {
    if (bot) {
      await bot.stop();
      bot = null;
    }
    botRunning = false;
    return { ok: true, message: 'Bot parado' };
  });

  ipcMain.handle('bot:status', () => ({ running: botRunning }));

  ipcMain.handle('stats:get', () => api!.db.getOverallStats());
  ipcMain.handle('trades:get', () => api!.db.getTrades(100));
  ipcMain.handle('sessions:get', () => api!.db.getSessions(30));
  ipcMain.handle('candles:get', () => api!.db.getCandles(200));

  log.info('App pronto. Dashboard em http://localhost:%d', api.port);
}

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    log.error('Erro fatal: %s', (err as Error).message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (bot) bot.stop();
    if (api) api.stop();
    app.quit();
  }
});

process.on('SIGINT', () => {
  if (bot) bot.stop();
  if (api) api.stop();
  app.quit();
});
