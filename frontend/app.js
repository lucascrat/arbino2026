// ===== PWA =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ===== AUTH =====
var authToken = sessionStorage.getItem('arb_token') || '';

function getToken() { return authToken; }

async function api(path, opts = {}) {
  var h = opts.headers || {};
  h['Authorization'] = 'Bearer ' + authToken;
  h['Content-Type'] = h['Content-Type'] || 'application/json';
  var res = await fetch(path, { ...opts, headers: h });
  if (res.status === 401) { doLogout(); throw new Error('Sessao expirada'); }
  return res;
}

window.doLogin = async function() {
  var user = document.getElementById('loginUser').value;
  var password = document.getElementById('loginPass').value;
  try {
    var res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password })
    });
    var data = await res.json();
    if (data.ok) {
      authToken = data.token;
      sessionStorage.setItem('arb_token', authToken);
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      initApp();
    } else {
      document.getElementById('loginErr').style.display = 'block';
    }
  } catch(e) {
    document.getElementById('loginErr').style.display = 'block';
  }
};

function doLogout() {
  authToken = '';
  sessionStorage.removeItem('arb_token');
  if (socket) { socket.disconnect(); socket = null; }
  appInited = false;
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// Enter key on password field
document.getElementById('loginPass').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

// Auto-login if token exists
if (authToken) {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

// ===== APP INIT =====
var botRunning = false;
var socket;
var chart;
var appInited = false;

function initApp() {
  if (appInited || !authToken) return;
  appInited = true;
  // Socket.IO (passa token via auth)
  socket = io({ auth: { token: authToken }, transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    document.getElementById('sysStatus').innerHTML = '<span class="dot green"></span> Conectado';
  });
  socket.on('connect_error', (err) => {
    document.getElementById('sysStatus').innerHTML = '<span class="dot red"></span> Erro: ' + (err.message || 'socket');
    addLog('error', 'Socket.IO: ' + err.message);
  });
  socket.on('disconnect', () => {
    document.getElementById('sysStatus').innerHTML = '<span class="dot red"></span> Offline';
  });
  socket.on('log', (d) => addLog(d.level, d.message, d.service));
  socket.on('candle', (c) => updateChart(c));
  socket.on('state', (s) => updateState(s));
  socket.on('signal', (d) => showSignal(d));
  socket.on('trade', (t) => { addTradeRow(t, true); refreshStats(); });
  socket.on('result', (t) => { updateTradeResult(t); refreshStats(); });
  socket.on('balance', (b) => { document.getElementById('balanceValue').textContent = `R$ ${b.toFixed(2)}`; });
  socket.on('warmup', (d) => {
    var pct = d.target > 0 ? Math.round(d.candles / d.target * 100) : 0;
    var bar = document.getElementById('warmupBar');
    bar.classList.add('show');
    document.getElementById('warmupFill').style.width = pct + '%';
    if (pct >= 100) bar.classList.remove('show');
  });
  socket.on('diagnostic', updateDiagnostic);

  initChart();
  refreshStats();
  loadTrades();
  fetchState();
  fetchSystemStatus();
  setInterval(refreshStats, 10000);
  setInterval(fetchState, 5000);
  setInterval(fetchSystemStatus, 15000);
}

if (authToken) initApp();

// ===== BOT CONTROLS =====
async function startBot() {
  try {
    var res = await api('/api/bot/start', { method: 'POST', body: JSON.stringify({ mode: 'trade' }) });
    var data = await res.json();
    if (data.ok) {
      document.getElementById('btnStart').disabled = true;
      document.getElementById('btnStop').disabled = false;
      updateStatusBadge(true);
      addLog('info', 'Bot iniciado');
      document.getElementById('vncHint').classList.add('show');
    }
  } catch(e) { addLog('error', 'Erro ao iniciar: ' + e.message); }
}

async function stopBot() {
  try {
    await api('/api/bot/stop', { method: 'POST' });
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStop').disabled = true;
    updateStatusBadge(false);
    document.getElementById('vncHint').classList.remove('show');
    addLog('info', 'Bot parado');
  } catch(e) { addLog('error', 'Erro ao parar: ' + e.message); }
}

function updateStatusBadge(running) {
  var dot = document.getElementById('statusDot');
  dot.className = 'status-badge' + (running ? ' running' : '');
  var warmup = document.getElementById('warmupBar');
  if (!running) { warmup.classList.remove('show'); document.getElementById('warmupFill').style.width = '0%'; }
}

async function setupLogin() {
  try {
    var res = await api('/api/setup/login', { method: 'POST' });
    var data = await res.json();
    addLog('info', data.message || 'Navegador aberto para login');
    window.open('/vnc.html', '_blank');
  } catch(e) { addLog('error', 'Setup: ' + e.message); }
}

// ===== STATE =====
function updateState(s) {
  if (s.running !== undefined) {
    botRunning = s.running;
    document.getElementById('btnStart').disabled = botRunning;
    document.getElementById('btnStop').disabled = !botRunning;
    updateStatusBadge(botRunning);
  }
  document.getElementById('statTradesToday').textContent = s.tradesToday || 0;
  document.getElementById('statLossesToday').textContent = 'Perdas: R$ ' + (s.lossesToday || 0).toFixed(2);
  document.getElementById('statConsecLosses').textContent = s.consecutiveLosses || 0;
  document.getElementById('statGaleInfo').textContent = 'Gale: ' + (s.martingaleLevels || 0) + ' níveis';
  document.getElementById('chartAsset').textContent = s.asset;
  document.getElementById('chartTf').textContent = 'TF: ' + (s.candleTimeframe || '—') + 's';
  var ai = document.getElementById('statAiStatus');
  ai.textContent = s.aiEnabled ? 'Ativa' : 'Off';
  ai.style.color = s.aiEnabled ? 'var(--purple)' : 'var(--muted)';
  document.getElementById('statAiModel').textContent = s.aiModel || '—';
  if (s.balance) document.getElementById('balanceValue').textContent = 'R$ ' + s.balance.toFixed(2);
  // Preencher config
  if (s.asset) document.getElementById('cfgAsset').value = s.asset;
  if (s.entryValue != null) document.getElementById('cfgEntry').value = s.entryValue;
  if (s.minSignalScore != null) document.getElementById('cfgScore').value = s.minSignalScore;
  if (s.expiration != null) document.getElementById('cfgExp').value = s.expiration;
  if (s.candleTimeframe != null) document.getElementById('cfgTf').value = s.candleTimeframe;
  if (s.martingaleLevels != null) document.getElementById('cfgGale').value = s.martingaleLevels;
  if (s.martingaleMultiplier != null) document.getElementById('cfgGaleMult').value = s.martingaleMultiplier;
  if (s.cooldownSeconds != null) document.getElementById('cfgCooldown').value = s.cooldownSeconds;
  if (s.maxDailyProfit != null) document.getElementById('cfgProfit').value = s.maxDailyProfit;
  if (s.maxDailyTrades != null) document.getElementById('cfgMaxTrades').value = s.maxDailyTrades;
  if (s.maxDailyLoss != null) document.getElementById('cfgStopLoss').value = s.maxDailyLoss;
}

async function fetchState() {
  try { var r = await api('/api/state'); updateState(await r.json()); } catch(e) {}
}

// ===== STATS =====
async function refreshStats() {
  try {
    var r = await api('/api/stats'); var s = await r.json();
    if (s.overall) {
      var o = s.overall;
      var wr = o.total > 0 ? ((o.wins / o.total) * 100).toFixed(0) : '—';
      document.getElementById('statWinRate').textContent = wr + '%';
      document.getElementById('statWL').textContent = o.wins + 'W / ' + o.losses + 'L';
      var net = (o.totalProfit || 0).toFixed(2);
      var nel = document.getElementById('statNet');
      nel.textContent = 'R$ ' + net;
      nel.className = 'value ' + (parseFloat(net) >= 0 ? 'val-green' : 'val-red');
      document.getElementById('statTotalTrades').textContent = o.total + ' trades';
    }
  } catch(e) {}
}

// ===== TRADES =====
async function loadTrades() {
  try {
    var r = await api('/api/trades?limit=50'); var data = await r.json();
    var tbody = document.getElementById('tradeBody');
    if (!data.trades || !data.trades.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Nenhum trade</td></tr>'; return; }
    tbody.innerHTML = '';
    data.trades.forEach(function(t) { addTradeRow(t, false); });
  } catch(e) {}
}

function addTradeRow(t, prepend) {
  var tbody = document.getElementById('tradeBody');
  if (!tbody.children.length || tbody.children[0].textContent.includes('Nenhum')) tbody.innerHTML = '';
  var dir = t.direction === 'CALL' ? '<span class="badge badge-call">CALL</span>' : '<span class="badge badge-put">PUT</span>';
  var gale = t.martingaleLevel > 0 ? '<span class="badge badge-gale">G' + t.martingaleLevel + '</span>' : '—';
  var ai = t.aiApproved ? '<span class="badge badge-ai">IA</span>' : '—';
  var result = t.status === 'WIN' ? '<span class="badge badge-win">WIN</span>' : t.status === 'LOSS' ? '<span class="badge badge-loss">LOSS</span>' : t.status || '—';
  var time = t.time ? new Date(t.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  var row = '<tr>' +
    '<td>' + time + '</td>' +
    '<td>' + dir + '</td>' +
    '<td>R$ ' + (t.entryValue || 0).toFixed(2) + '</td>' +
    '<td>' + (t.score || '—') + '</td>' +
    '<td>' + gale + '</td>' +
    '<td>' + ai + '</td>' +
    '<td>' + result + '</td>' +
    '<td>' + (t.payout != null ? 'R$ ' + t.payout.toFixed(2) : '—') + '</td>' +
    '</tr>';
  if (prepend) tbody.insertAdjacentHTML('afterbegin', row);
  else tbody.insertAdjacentHTML('beforeend', row);
  if (tbody.children.length > 50) tbody.removeChild(tbody.lastChild);
}

function updateTradeResult(t) {
  var rows = document.querySelectorAll('#tradeBody tr');
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].querySelectorAll('td');
    if (cells.length > 6) {
      var result = t.status === 'WIN' ? '<span class="badge badge-win">WIN</span>' : t.status === 'LOSS' ? '<span class="badge badge-loss">LOSS</span>' : t.status || '—';
      cells[6].innerHTML = result;
      cells[7].textContent = t.payout != null ? 'R$ ' + t.payout.toFixed(2) : '—';
      break;
    }
  }
}

// ===== SIGNAL =====
function showSignal(d) {
  var card = document.getElementById('signalCard'); card.style.display = 'block';
  var el = document.getElementById('signalContent');
  var dirCls = d.signal.direction === 'CALL' ? 'signal-call' : 'signal-put';
  var tags = (d.signal.patterns || []).map(function(p) { return '<span class="tag">' + p + '</span>'; }).join('');
  var reasons = (d.signal.reasons || []).join(' | ');
  var aiBlock = '';
  if (d.aiVerdict) {
    var cls = d.executed ? 'ai-yes' : 'ai-no';
    aiBlock = '<div class="ai-block ' + cls + '">IA: ' + (d.executed ? 'APROVOU' : 'BLOQUEOU') + ' (conf: ' + d.aiVerdict.confidence + ' risk: ' + d.aiVerdict.risk + ')</div>';
  }
  el.innerHTML = '<div class="signal ' + dirCls + '"><b>' + d.signal.direction + '</b> score=' + d.signal.score + '<br>' + tags + '<br>' + reasons + aiBlock + '</div>';
}

// ===== SETTINGS =====
async function saveSettings() {
  var settings = {
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
    await api('/api/settings', { method: 'POST', body: JSON.stringify(settings) });
    var s = document.getElementById('cfgSaved');
    s.textContent = 'Salvo! Reinicie o bot para aplicar';
    setTimeout(function() { s.textContent = ''; }, 3000);
    addLog('info', 'Configurações salvas');
  } catch(e) { addLog('error', 'Erro ao salvar: ' + e.message); }
}

// ===== CHART =====
function initChart() {
  var ctx = document.getElementById('candleChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Preço', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.1)', fill: true, tension: .3, pointRadius: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { display: true, ticks: { color: '#6b7280', maxTicksLimit: 10, font: { size: 9 } }, grid: { color: '#1e2638' } },
        y: { display: true, ticks: { color: '#6b7280', font: { size: 9 }, callback: function(v) { return v.toFixed(6); } }, grid: { color: '#1e2638' } }
      },
      plugins: { legend: { display: false } },
      animation: false
    }
  });
}

function updateChart(candle) {
  if (!chart) return;
  chart.data.labels.push(new Date(candle.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  chart.data.datasets[0].data.push(candle.close);
  if (chart.data.labels.length > 80) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
  chart.update('none');
}

// ===== LOGS =====
function addLog(level, msg, svc) {
  var box = document.getElementById('logBox');
  if (box.textContent === '— aguardando eventos —') box.textContent = '';
  var time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var cls = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  box.innerHTML += '<span class="' + cls + '">' + time + ' [' + (svc || '') + '] ' + msg + '</span>\n';
  if (box.children.length > 150) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ===== DIAGNOSTIC =====
var diagData = null;
function updateDiagnostic(d) { diagData = d; }

async function openDiagnostic() {
  document.getElementById('diagModal').style.display = 'flex';
  try {
    var r = await api('/api/diagnose'); var d = await r.json();
    var c = document.getElementById('diagContent');
    var items = [
      ['Bot rodando', d.botRunning ? 'Sim' : 'Não', d.botRunning ? 'val-green' : 'val-red'],
      ['Server uptime', formatUptime(d.serverUptime || 0), ''],
      ['WS frames recebidos', d.wsFramesReceived || 0, ''],
      ['WS frames enviados', d.wsFramesSent || 0, ''],
      ['Sockets ativas', d.socketCount || 0, ''],
      ['Candles gerados', d.candleCount + ' / 30 necessário', d.candleCount>=30?'val-green':''],
      ['Último preço', d.lastPrice != null ? d.lastPrice.toFixed(8) : 'Nenhum', ''],
      ['Último tick há', d.lastTickTime ? Math.round((Date.now()-d.lastTickTime)/1000) + 's' : 'Nunca', ''],
      ['Asset', d.asset || '—', ''],
      ['Sessão pronta', d.sessionReady ? 'Sim' : 'Não', ''],
      ['Bot uptime', formatUptime(d.botUptime || 0), ''],
      ['URL da página', d.pageUrl || '—', ''],
    ];
    c.innerHTML = items.map(function(i) {
      return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span>' + i[0] + '</span><span class="' + (i[2]||'') + '">' + i[1] + '</span></div>';
    }).join('');
  } catch(e) {}
}

function closeDiagnostic() { document.getElementById('diagModal').style.display = 'none'; }

// ===== SYSTEM =====
async function fetchSystemStatus() {
  try {
    var r = await api('/api/system'); var s = await r.json();
    var el = document.getElementById('sysStatus');
    el.innerHTML = '<span class="dot green"></span> ' + formatUptime(s.uptime || 0) + ' | ' + ((s.db && s.db.tradeCount) || 0) + ' trades';
  } catch(e) {}
}

// ===== HELPERS =====
function formatUptime(sec) {
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  var p = [];
  if (d > 0) p.push(d + 'd');
  if (h > 0) p.push(h + 'h');
  p.push(m + 'm');
  return p.join(' ');
}
