// Arbinomo Frontend — Dashboard
const socket = io();
let candleChart = null;
let botRunning = false;

// Escuta eventos do Electron (auto-start do bot)
if (window.electronAPI) {
  window.electronAPI.onBotStarted(() => {
    botRunning = true;
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
    updateStatusBadge(true);
    addLog('info', 'Bot iniciado automaticamente');
  });
  window.electronAPI.onBotStopped(() => {
    botRunning = false;
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    updateStatusBadge(false);
    addLog('info', 'Bot parado');
  });
  window.electronAPI.onBotLog((msg) => {
    addLog('info', msg, 'BOT');
  });
}

// ===== Socket Events =====
socket.on('connect', () => {
  console.log('Conectado ao backend');
  addLog('info', 'Dashboard conectado ao backend');
  const el = document.getElementById('sysSocket');
  if (el) { el.className = 'sys-item sys-socket connected'; el.innerHTML = '🔌 Conectado'; }
});

socket.on('disconnect', () => {
  const el = document.getElementById('sysSocket');
  if (el) { el.className = 'sys-item sys-socket disconnected'; el.innerHTML = '🔌 Desconectado'; }
});

socket.on('log', (data) => {
  addLog(data.level, data.message, data.service);
});

socket.on('candle', (candle) => {
  updateChart(candle);
});

socket.on('state', (state) => {
  updateState(state);
});

socket.on('signal', (data) => {
  showSignal(data);
});

socket.on('trade', (trade) => {
  addTradeRow(trade);
  refreshStats();
  refreshTradeCount();
});

socket.on('result', (trade) => {
  updateTradeResult(trade);
  refreshStats();
  refreshTradeCount();
});

socket.on('balance', (data) => {
  document.getElementById('balanceValue').textContent = `R$ ${data.balance.toFixed(2)}`;
});

socket.on('warmup', (data) => {
  const bar = document.getElementById('warmupBar');
  const fill = document.getElementById('warmupFill');
  const count = document.getElementById('warmupCount');
  if (!bar || !fill || !count) return;
  if (data.candles >= data.target) {
    bar.style.display = 'none';
    document.getElementById('statusText').textContent = 'Rodando';
    return;
  }
  bar.style.display = 'flex';
  document.getElementById('statusText').textContent = 'Analisando...';
  const pct = Math.min(100, Math.round((data.candles / data.target) * 100));
  fill.style.width = pct + '%';
  count.textContent = `${data.candles}/${data.target} candles`;
});

// ===== Bot Control =====
async function startBot() {
  // Se estiver no Electron, usa IPC
  if (window.electronAPI?.startBot) {
    const res = await window.electronAPI.startBot('trade');
    if (res.ok) {
      botRunning = true;
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').disabled = false;
      updateStatusBadge(true);
      addLog('info', 'Bot iniciado via Electron');
    } else {
      addLog('warn', res.message);
    }
    return;
  }
  try {
    const res = await fetch('/api/bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'trade' }),
    });
    const data = await res.json();
    if (data.ok) {
      botRunning = true;
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').disabled = false;
      updateStatusBadge(true);
    }
  } catch (err) {
    addLog('error', 'Erro ao iniciar bot: ' + err.message);
  }
}

async function stopBot() {
  // Se estiver no Electron, usa IPC
  if (window.electronAPI?.stopBot) {
    const res = await window.electronAPI.stopBot();
    if (res.ok) {
      botRunning = false;
      document.getElementById('btnStart').disabled = false;
      document.getElementById('btnStop').disabled = true;
      updateStatusBadge(false);
      addLog('info', 'Bot parado via Electron');
    } else {
      addLog('warn', res.message);
    }
    return;
  }
  try {
    const res = await fetch('/api/bot/stop', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      botRunning = false;
      document.getElementById('btnStart').disabled = false;
      document.getElementById('btnStop').disabled = true;
      updateStatusBadge(false);
    }
  } catch (err) {
    addLog('error', 'Erro ao parar bot: ' + err.message);
  }
}

function updateStatusBadge(running) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  const bar = document.getElementById('warmupBar');
  if (running) {
    badge.classList.add('running');
    text.textContent = 'Rodando';
  } else {
    badge.classList.remove('running');
    text.textContent = 'Parado';
    if (bar) bar.style.display = 'none';
  }
}

function updateState(state) {
  document.getElementById('statTradesToday').textContent = state.tradesToday || 0;
  document.getElementById('statLossesToday').textContent = `Perdas: R$ ${(state.lossesToday || 0).toFixed(2)}`;
  document.getElementById('statConsecLosses').textContent = state.consecutiveLosses || 0;
  document.getElementById('statGaleInfo').textContent = `Gale: ${state.martingaleLevels} níveis`;
  document.getElementById('chartAsset').textContent = state.asset;
  document.getElementById('chartTf').textContent = `TF: ${state.candleTimeframe}s`;
  const aiEl = document.getElementById('statAiStatus');
  aiEl.textContent = state.aiEnabled ? 'Ativa' : 'Off';
  aiEl.style.color = state.aiEnabled ? 'var(--purple)' : 'var(--text-muted)';
  document.getElementById('statAiModel').textContent = state.aiModel || '—';
  if (state.balance) {
    document.getElementById('balanceValue').textContent = `R$ ${state.balance.toFixed(2)}`;
  }
  // Atualiza botões
  if (state.running !== undefined) {
    botRunning = state.running;
    document.getElementById('btnStart').disabled = botRunning;
    document.getElementById('btnStop').disabled = !botRunning;
    updateStatusBadge(botRunning);
  }
  // Preencher config
  if (state.asset) document.getElementById('cfgAsset').value = state.asset;
  if (state.entryValue) document.getElementById('cfgEntry').value = state.entryValue;
  if (state.minSignalScore) document.getElementById('cfgScore').value = state.minSignalScore;
  if (state.expiration) document.getElementById('cfgExp').value = state.expiration;
  if (state.candleTimeframe) document.getElementById('cfgTf').value = state.candleTimeframe;
  if (state.martingaleLevels !== undefined) document.getElementById('cfgGale').value = state.martingaleLevels;
  if (state.martingaleMultiplier) document.getElementById('cfgGaleMult').value = state.martingaleMultiplier;
  if (state.cooldownSeconds) document.getElementById('cfgCooldown').value = state.cooldownSeconds;
  if (state.maxDailyProfit !== undefined) document.getElementById('cfgProfit').value = state.maxDailyProfit;
  if (state.maxDailyTrades !== undefined) document.getElementById('cfgMaxTrades').value = state.maxDailyTrades;
  if (state.maxDailyLoss !== undefined) document.getElementById('cfgStopLoss').value = state.maxDailyLoss;
}

async function toggleAi() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    const current = settings.aiEnabled === 'true';
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiEnabled: (!current).toString() }),
    });
    addLog('info', `IA ${!current ? 'ativada' : 'desativada'} (próximo restart do bot)`);
    fetchState();
  } catch (err) {
    addLog('error', 'Erro ao toggle IA: ' + err.message);
  }
}

// ===== Stats =====
async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    const s = data.overall;
    document.getElementById('statWinRate').textContent = s.winRate.toFixed(1) + '%';
    document.getElementById('statWinLoss').textContent = `${s.wins}W / ${s.losses}L`;
    document.getElementById('statProfit').textContent = `R$ ${s.netProfit.toFixed(2)}`;
    document.getElementById('statProfit').style.color = s.netProfit >= 0 ? 'var(--green)' : 'var(--red)';
    document.getElementById('statTotalTrades').textContent = `${s.totalTrades} trades`;
  } catch (err) {
    console.error('Erro ao buscar stats:', err);
  }
}

// ===== Trades Table =====
async function loadTrades() {
  try {
    const res = await fetch('/api/trades?limit=100');
    const trades = await res.json();
    const body = document.getElementById('tradeBody');
    body.innerHTML = '';
    if (trades.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8">Nenhum trade ainda</td></tr>';
    } else {
      trades.forEach((t) => addTradeRow(t, false));
    }
    refreshTradeCount();
  } catch (err) {
    console.error('Erro ao carregar trades:', err);
  }
}

function refreshTradeCount() {
  const body = document.getElementById('tradeBody');
  const count = body.querySelectorAll('tr:not(.empty-row)').length;
  document.getElementById('tradeCount').textContent = `${count} trades`;
}

function addTradeRow(trade, prepend = true) {
  const body = document.getElementById('tradeBody');
  if (body.querySelector('.empty-row')) body.innerHTML = '';

  const tr = document.createElement('tr');
  const time = new Date(trade.placed_at).toLocaleTimeString('pt-BR');
  const dir = trade.direction === 'CALL'
    ? '<span class="dir-call">CALL ▲</span>'
    : '<span class="dir-put">PUT ▼</span>';
  const gale = trade.martingale_level > 0
    ? `<span class="gale-badge gale-${trade.martingale_level}">G${trade.martingale_level}</span>`
    : '<span class="gale-badge gale-0">—</span>';
  const ai = trade.ai_approved === 1 ? '✅' : trade.ai_approved === 0 ? '❌' : '—';
  let result = '';
  if (trade.status === 'WIN') result = '<span class="result-win">WIN</span>';
  else if (trade.status === 'LOSS') result = '<span class="result-loss">LOSS</span>';
  else if (trade.status === 'PENDING') result = '<span class="result-pending">⏳</span>';
  else result = trade.status;

  const payout = trade.payout != null
    ? `<span style="color:${trade.payout >= 0 ? 'var(--green)' : 'var(--red)'}">R$ ${trade.payout.toFixed(2)}</span>`
    : '—';

  tr.innerHTML = `
    <td>${time}</td>
    <td>${dir}</td>
    <td>R$ ${trade.entry_value.toFixed(2)}</td>
    <td>${trade.score}</td>
    <td>${gale}</td>
    <td>${ai}</td>
    <td>${result}</td>
    <td>${payout}</td>
  `;
  if (prepend) body.prepend(tr);
  else body.appendChild(tr);
  refreshTradeCount();
}

function updateTradeResult(trade) {
  // Atualiza a primeira linha (trade mais recente)
  const body = document.getElementById('tradeBody');
  const firstRow = body.querySelector('tr');
  if (firstRow) {
    const cells = firstRow.querySelectorAll('td');
    if (cells.length >= 8) {
      let result = '';
      if (trade.status === 'WIN') result = '<span class="result-win">WIN</span>';
      else if (trade.status === 'LOSS') result = '<span class="result-loss">LOSS</span>';
      else result = trade.status;
      cells[6].innerHTML = result;
      if (trade.payout != null) {
        cells[7].innerHTML = `<span style="color:${trade.payout >= 0 ? 'var(--green)' : 'var(--red)'}">R$ ${trade.payout.toFixed(2)}</span>`;
      }
    }
  }
}

// ===== Signal Display =====
function showSignal(data) {
  const content = document.getElementById('signalContent');
  const s = data.signal;
  const ai = data.aiVerdict;
  if (!s) {
    content.innerHTML = '<p class="muted">Aguardando sinal...</p>';
    return;
  }
  const dirClass = s.direction === 'CALL' ? 'call' : 'put';
  const dirIcon = s.direction === 'CALL' ? '▲ CALL' : '▼ PUT';
  const patterns = (s.patterns || []).map(p => `<span class="signal-pattern">${p}</span>`).join('');
  let aiHtml = '';
  if (ai) {
    const aiClass = ai.approve ? 'approved' : 'blocked';
    const aiIcon = ai.approve ? '✅' : '❌';
    aiHtml = `<div class="signal-ai ${aiClass}">${aiIcon} IA: conf=${ai.confidence}% risk=${ai.risk} — ${ai.reasoning}</div>`;
  }
  const executed = data.executed ? '<span style="color:var(--green)">Executado</span>' : '<span style="color:var(--red)">Bloqueado</span>';
  content.innerHTML = `
    <div class="signal-direction ${dirClass}">${dirIcon}</div>
    <div class="signal-score">Score: <b>${s.score}/100</b> — ${executed}</div>
    <div class="signal-patterns">${patterns}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${(s.reasons || []).join(' | ')}</div>
    ${aiHtml}
  `;
}

// ===== Logs =====
function addLog(level, message, svc) {
  const container = document.getElementById('logContainer');
  if (container.querySelector('.log-empty')) container.innerHTML = '';
  const time = new Date().toLocaleTimeString('pt-BR');
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  const serviceTag = svc ? `[${svc}] ` : '';
  line.innerHTML = `<span class="log-time">${time}</span> ${serviceTag}${message}`;
  container.appendChild(line);
  // Limita a 200 linhas
  while (container.children.length > 200) container.removeChild(container.firstChild);
  container.scrollTop = container.scrollHeight;
}

function openDiagnostic() {
  const modal = document.getElementById('diagModal');
  const body = document.getElementById('diagBody');
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">Carregando diagnóstico...</p>';
  fetch('/api/diagnose').then(r => r.json()).then(data => {
    const d = data.lastDiagnostic;
    const health = data.health;
    let html = '<div class="diag-row"><span class="diag-label">Bot rodando</span><span class="diag-value ' + (data.botRunning ? 'ok' : 'err') + '">' + (data.botRunning ? 'Sim' : 'Não') + '</span></div>';
    html += '<div class="diag-row"><span class="diag-label">Server uptime</span><span class="diag-value">' + formatUptime(health.uptime) + '</span></div>';
    if (d) {
      const wsOk = d.wsFramesReceived > 0;
      const tickOk = d.lastTickTime !== null && (Date.now() - d.lastTickTime < 30000);
      const candleOk = d.candleCount > 0;
      html += '<div class="diag-row"><span class="diag-label">WS frames recebidos</span><span class="diag-value ' + (wsOk ? 'ok' : 'err') + '">' + d.wsFramesReceived + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">WS frames enviados</span><span class="diag-value">' + d.wsFramesSent + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Con sockets ativas</span><span class="diag-value ' + (d.socketCount > 0 ? 'ok' : 'err') + '">' + d.socketCount + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Candles gerados</span><span class="diag-value ' + (candleOk ? 'ok' : 'err') + '">' + d.candleCount + '<span style="font-weight:400;color:var(--text-muted);font-size:11px"> / 30 necessário</span></span></div>';
      html += '<div class="diag-row"><span class="diag-label">Último preço</span><span class="diag-value ' + (d.lastPrice !== null ? 'ok' : 'err') + '">' + (d.lastPrice !== null ? d.lastPrice.toFixed(6) : 'Nenhum') + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Último tick há</span><span class="diag-value ' + (tickOk ? 'ok' : 'err') + '">' + (d.lastTickTime ? formatUptime((Date.now() - d.lastTickTime) / 1000) + ' atrás' : 'Nunca') + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Asset</span><span class="diag-value">' + d.asset + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Sessão pronta</span><span class="diag-value ' + (d.sessionReady ? 'ok' : 'err') + '">' + (d.sessionReady ? 'Sim' : 'Não') + '</span></div>';
      html += '<div class="diag-row"><span class="diag-label">Bot uptime</span><span class="diag-value">' + formatUptime(d.uptime) + '</span></div>';
      if (d.pageUrl) {
        html += '<div class="diag-row"><span class="diag-label">URL da página</span><span class="diag-value" style="font-size:10px;word-break:break-all">' + escapeHtml(d.pageUrl) + '</span></div>';
      }
      if (d.pageTitle) {
        html += '<div class="diag-row"><span class="diag-label">Título da página</span><span class="diag-value">' + escapeHtml(d.pageTitle) + '</span></div>';
      }
      if (d.lastFramePreview) {
        html += '<div class="diag-row" style="flex-direction:column;align-items:stretch"><span class="diag-label">Último frame WS:</span><div class="diag-frame">' + escapeHtml(d.lastFramePreview) + '</div></div>';
      }
    } else {
      html += '<p class="muted" style="margin-top:8px">Nenhum diagnóstico do bot disponível. Inicie o bot para ver dados.</p>';
    }
    body.innerHTML = html;
  }).catch(err => {
    body.innerHTML = '<p class="err" style="color:var(--red)">Erro ao carregar: ' + err.message + '</p>';
  });
}

function closeDiagnostic() {
  document.getElementById('diagModal').style.display = 'none';
}

async function setupLogin() {
  const btn = document.getElementById('btnSetupLogin');
  btn.disabled = true;
  btn.textContent = 'Abrindo navegador...';
  try {
    const res = await fetch('/api/setup/login', { method: 'POST' });
    const data = await res.json();
    addLog('info', data.message || 'Setup iniciado');
    if (data.ok) {
      // Abre VNC automaticamente
      window.open('/vnc.html', '_blank');
      btn.textContent = '🔑 Setup Ativo';
      btn.onclick = stopSetupLogin;
    } else {
      btn.disabled = false;
      btn.textContent = '🔑 Setup Login';
    }
  } catch (err) {
    addLog('error', 'Erro ao iniciar setup: ' + err.message);
    btn.disabled = false;
    btn.textContent = '🔑 Setup Login';
  }
}

async function stopSetupLogin() {
  const btn = document.getElementById('btnSetupLogin');
  btn.textContent = 'Fechando...';
  try {
    await fetch('/api/setup/stop', { method: 'POST' });
    addLog('info', 'Setup encerrado');
  } catch {}
  btn.textContent = '🔑 Setup Login';
  btn.onclick = setupLogin;
  btn.disabled = false;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function clearLogs() {
  document.getElementById('logContainer').innerHTML = '<div class="log-empty">Logs aparecerão aqui...</div>';
}

// ===== Settings =====
async function saveSettings() {
  const settings = {
    asset: document.getElementById('cfgAsset').value,
    entryValue: document.getElementById('cfgEntry').value,
    minSignalScore: document.getElementById('cfgScore').value,
    expirationSeconds: document.getElementById('cfgExp').value,
    candleTimeframeSeconds: document.getElementById('cfgTf').value,
    martingaleLevels: document.getElementById('cfgGale').value,
    martingaleMultiplier: document.getElementById('cfgGaleMult').value,
    cooldownSeconds: document.getElementById('cfgCooldown').value,
    maxDailyProfit: document.getElementById('cfgProfit').value,
    maxDailyTrades: document.getElementById('cfgMaxTrades').value,
    maxDailyLoss: document.getElementById('cfgStopLoss').value,
  };
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const saved = document.getElementById('cfgSaved');
    saved.textContent = '✓ Salvo!';
    setTimeout(() => { saved.textContent = ''; }, 2000);
    addLog('info', 'Configurações salvas');
  } catch (err) {
    addLog('error', 'Erro ao salvar: ' + err.message);
  }
}

// ===== Candle Chart =====
function initChart() {
  const ctx = document.getElementById('candleChart').getContext('2d');
  candleChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Preço',
        data: [],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.08)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      scales: {
        x: { display: false },
        y: {
          position: 'right',
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#6b7280', font: { size: 10 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#131825',
          titleColor: '#e4e7ef',
          bodyColor: '#e4e7ef',
        },
      },
    },
  });
}

function updateChart(candle) {
  if (!candleChart) return;
  const time = new Date(candle.time).toLocaleTimeString('pt-BR');
  candleChart.data.labels.push(time);
  candleChart.data.datasets[0].data.push(candle.close);
  // Limita a 80 pontos
  if (candleChart.data.labels.length > 80) {
    candleChart.data.labels.shift();
    candleChart.data.datasets[0].data.shift();
  }
  candleChart.update('none');
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

async function fetchSystemStatus() {
  try {
    const res = await fetch('/api/system');
    const data = await res.json();
    if (data.status === 'ok') {
      document.getElementById('sysUptime').textContent = '⏱️ ' + formatUptime(data.uptime);
      document.getElementById('sysTrades').textContent = '📊 ' + data.db.tradeCount + ' trades';
    }
  } catch (err) {
    console.error('Erro ao buscar system status:', err);
  }
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  initChart();
  refreshStats();
  loadTrades();
  fetchState();
  loadAnalytics();
  fetchSystemStatus();
  setInterval(refreshStats, 10000);
  setInterval(fetchState, 5000);
  setInterval(fetchSystemStatus, 15000);
});

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();
    updateState(state);
  } catch (err) {
    console.error('Erro ao buscar estado:', err);
  }
}

// ===== Analytics =====
async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    const data = await res.json();
    renderGaleStats(data.galeStats);
    renderHourlyGale(data.hourlyGales);
    renderHourlyPerformance(data.hourlyPerformance);
    renderMarketStats(data.marketStateStats);
  } catch (err) {
    console.error('Erro ao carregar analytics:', err);
  }
}

function renderGaleStats(gale) {
  const el = document.getElementById('analyticsGale');
  if (!gale.totalGales) {
    el.innerHTML = '<p class="muted">Nenhum gale registrado ainda</p>';
    return;
  }
  let html = `<div class="analytics-stat"><span class="label">Total de gales</span><span class="value">${gale.totalGales}</span></div>`;
  html += `<div class="analytics-stat"><span class="label">Nivel medio</span><span class="value">${gale.avgLevel}</span></div>`;
  html += `<div style="margin-top:4px;font-size:11px;color:var(--text-muted)">Distribuicao:</div>`;
  const maxCount = Math.max(...Object.values(gale.distribution), 1);
  for (const [key, count] of Object.entries(gale.distribution)) {
    const pct = (count / maxCount) * 100;
    html += `<div class="analytics-stat"><span class="label">${key.replace('nivel_', 'Nivel ')}</span><div class="analytics-bar-wrap"><div class="analytics-bar"><div class="analytics-bar-fill" style="width:${pct}%;background:var(--orange)"></div></div><span class="value">${count}</span></div></div>`;
  }
  el.innerHTML = html;
}

function renderHourlyGale(hourly) {
  const el = document.getElementById('analyticsHourlyGale');
  if (!hourly.length) {
    el.innerHTML = '<p class="muted">Sem dados de gale por horario</p>';
    return;
  }
  const maxCount = Math.max(...hourly.map(h => h.count), 1);
  let html = '';
  for (const h of hourly) {
    const pct = (h.count / maxCount) * 100;
    const hourLabel = `${h.hour.toString().padStart(2, '0')}:00`;
    html += `<div class="analytics-stat"><span class="label">${hourLabel}</span><div class="analytics-bar-wrap"><div class="analytics-bar"><div class="analytics-bar-fill" style="width:${pct}%;background:var(--orange)"></div></div><span class="value">${h.count}</span></div></div>`;
  }
  el.innerHTML = html;
}

function renderHourlyPerformance(hourly) {
  const el = document.getElementById('analyticsHours');
  if (!hourly.length) {
    el.innerHTML = '<p class="muted">Sem dados de performance por horario</p>';
    return;
  }
  const sorted = [...hourly].sort((a, b) => b.winRate - a.winRate);
  const best = sorted.slice(0, 3).filter(h => h.total >= 2);
  const worst = sorted.slice(-3).reverse().filter(h => h.total >= 2);

  let html = '<div style="margin-bottom:6px"><span style="color:var(--green)">✅ Melhores horarios:</span></div>';
  if (best.length) {
    for (const h of best) {
      html += `<div class="analytics-stat"><span class="label">${h.hour.toString().padStart(2, '0')}:00</span><span class="value green">${h.winRate}% (${h.wins}W/${h.losses}L)</span></div>`;
    }
  } else {
    html += '<p class="muted">Ainda sem dados suficientes</p>';
  }
  html += '<div style="margin:6px 0 4px"><span style="color:var(--red)">❌ Piores horarios:</span></div>';
  if (worst.length) {
    for (const h of worst) {
      html += `<div class="analytics-stat"><span class="label">${h.hour.toString().padStart(2, '0')}:00</span><span class="value red">${h.winRate}% (${h.wins}W/${h.losses}L)</span></div>`;
    }
  } else {
    html += '<p class="muted">Ainda sem dados suficientes</p>';
  }
  el.innerHTML = html;
}

function renderMarketStats(marketStats) {
  const el = document.getElementById('analyticsMarket');
  if (!marketStats.length) {
    el.innerHTML = '<p class="muted">Sem dados de mercado ainda (comece a operar para gerar)</p>';
    return;
  }
  const maxCount = Math.max(...marketStats.map(m => m.total), 1);
  let html = '';
  for (const m of marketStats) {
    const pct = (m.total / maxCount) * 100;
    const stateLabel = m.state.replace(/_/g, ' ');
    html += `<div class="analytics-stat"><span class="label">${stateLabel}</span><div class="analytics-bar-wrap"><div class="analytics-bar"><div class="analytics-bar-fill" style="width:${pct}%;background:${m.winRate >= 50 ? 'var(--green)' : 'var(--red)'}"></div></div><span class="value ${m.winRate >= 50 ? 'green' : 'red'}">${m.winRate}% (${m.wins}W/${m.losses}L)</span></div></div>`;
  }
  el.innerHTML = html;
}
