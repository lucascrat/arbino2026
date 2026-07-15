// Preload script para comunicação segura Electron ↔ Frontend
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onBotStarted: (callback) => ipcRenderer.on('bot:started', () => callback()),
  onBotStopped: (callback) => ipcRenderer.on('bot:stopped', () => callback()),
  onBotLog: (callback) => ipcRenderer.on('bot:log', (_event, msg) => callback(msg)),
  startBot: (mode) => ipcRenderer.invoke('bot:start', mode),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
});
