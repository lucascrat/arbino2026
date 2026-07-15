// Electron launcher (CommonJS) — ponto de entrada do app desktop
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

let win = null;
let apiProcess = null;
let botProcess = null;
const API_PORT = 3456;

function findSystemNode() {
  // 1. Tenta via NODE env var (definido pelo npm)
  if (process.env.NODE) {
    const p = process.env.NODE.replace(/"/g, '');
    try { if (require('fs').existsSync(p)) return p; } catch {}
  }
  // 2. Tenta via PATH (where node no Windows)
  try {
    const out = execSync('where node', { encoding: 'utf8', timeout: 3000 });
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length > 0) return lines[0].trim();
  } catch {}
  // 3. Caminhos comuns no Windows
  const candidates = [
    path.join(process.env.APPDATA?.replace('Roaming', 'Local') || '', 'Programs', 'nodejs', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    try { if (require('fs').existsSync(c)) return c; } catch {}
  }
  // 4. Fallback: confia no PATH
  return 'node';
}

async function startApiServer() {
  const serverFile = path.join(__dirname, 'dist', 'server', 'main.js');
  const nodeExe = await findSystemNode();
  if (!nodeExe) {
    console.error('Node.js não encontrado no sistema. Verifique sua instalação.');
    return;
  }

  apiProcess = spawn(nodeExe, [serverFile], {
    cwd: __dirname,
    stdio: 'pipe',
    env: { ...process.env, API_PORT: String(API_PORT) },
  });

  apiProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[API] ${msg}`);
  });
  apiProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[API ERR] ${msg}`);
  });
  apiProcess.on('exit', (code) => {
    console.log(`[API] Processo saiu com código ${code}`);
  });

  // Aguarda o servidor subir com retry
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://localhost:${API_PORT}/api/health`, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        console.log('API server pronto!');
        return;
      }
    } catch (e) {
      // continua tentando
    }
  }
  console.error('API server não respondeu em 30s');
}

async function startBotAuto() {
  const nodeExe = await findSystemNode();
  const indexJs = path.join(__dirname, 'dist', 'index.js');
  botProcess = spawn(nodeExe, [indexJs, '--mode=trade'], {
    cwd: __dirname,
    stdio: 'pipe',
    env: { ...process.env },
  });

  botProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.log(`[BOT] ${msg}`);
      if (win) win.webContents.send('bot:log', msg);
    }
  });
  botProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[BOT ERROR] ${msg}`);
  });
  botProcess.on('close', (code) => {
    console.log(`[BOT] Processo encerrado (código ${code})`);
    botProcess = null;
    notifyApiBotStopped();
    if (win) win.webContents.send('bot:stopped');
  });

  console.log('[BOT] Auto-start: Bot iniciado em modo trade');

  // Notifica o ApiServer para atualizar o estado
  notifyApiBotRunning();

  // Notifica o frontend (se a janela já existir)
  if (win) win.webContents.send('bot:started');
}

function notifyApiBotRunning() {
  const postData = JSON.stringify({});
  const req = http.request(`http://localhost:${API_PORT}/api/bot/external-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
  });
  req.on('error', () => {});
  req.write(postData);
  req.end();
}

function notifyApiBotStopped() {
  const req = http.request(`http://localhost:${API_PORT}/api/bot/stop`, { method: 'POST' });
  req.on('error', () => {});
  req.end();
}

async function createWindow() {
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
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  });

  await win.loadURL(`http://localhost:${API_PORT}`);

  win.on('closed', () => {
    win = null;
  });
}

async function bootstrap() {
  console.log('Iniciando Arbinomo Desktop...');

  // Inicia API server
  await startApiServer();

  // Cria a janela do dashboard
  await createWindow();

  // Inicia o bot automaticamente em modo trade
  await startBotAuto();

  console.log('App pronto!');
}

// ===== IPC handlers =====
ipcMain.handle('bot:start', async (_event, mode) => {
  if (botProcess) return { ok: false, message: 'Bot já está rodando' };

  const nodeExe = await findSystemNode();
  botProcess = spawn(nodeExe, [
    path.join(__dirname, 'dist', 'index.js'),
    `--mode=${mode || 'trade'}`
  ], {
    cwd: __dirname,
    stdio: 'pipe',
    env: { ...process.env },
  });

  botProcess.stdout.on('data', (data) => {
    console.log(`[BOT] ${data.toString().trim()}`);
  });
  botProcess.stderr.on('data', (data) => {
    console.error(`[BOT ERROR] ${data.toString().trim()}`);
  });
  botProcess.on('close', (code) => {
    console.log(`[BOT] Processo encerrado (código ${code})`);
    botProcess = null;
    if (win) win.webContents.send('bot:stopped');
  });

  return { ok: true, message: `Bot iniciado no modo ${mode}` };
});

ipcMain.handle('bot:stop', async () => {
  if (botProcess) {
    botProcess.kill('SIGINT');
    botProcess = null;
    notifyApiBotStopped();
    if (win) win.webContents.send('bot:stopped');
    return { ok: true, message: 'Bot parado' };
  }
  return { ok: false, message: 'Bot não está rodando' };
});

ipcMain.handle('bot:status', () => ({
  running: botProcess !== null,
}));

// ===== App lifecycle =====
app.whenReady().then(() => {
  bootstrap().catch((err) => {
    console.error('Erro fatal:', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (botProcess) botProcess.kill('SIGINT');
  if (apiProcess) apiProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

process.on('SIGINT', () => {
  if (botProcess) botProcess.kill('SIGINT');
  if (apiProcess) apiProcess.kill();
  app.quit();
});
