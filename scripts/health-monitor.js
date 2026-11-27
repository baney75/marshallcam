const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = process.env.MARSHALLCAM_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'healthmonitor.log');
const PORT = Number(process.env.HEALTH_MONITOR_PORT || 9999);

function log(msg) {
  const line = `[${new Date().toISOString()}] [HealthMonitor] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* noop */ }
}

function getLogTail(filename, lines = 50) {
  try {
    const data = fs.readFileSync(filename, 'utf8');
    return data.split('\n').filter(l => l.trim()).slice(-lines).join('\n');
  } catch (e) {
    return `Cannot read ${filename}: ${e.message}`;
  }
}

function getProcessInfo(pattern) {
  return new Promise((resolve) => {
    exec(`pgrep -f "${pattern}" | head -n 1`, (err, stdout) => {
      const pid = stdout.trim();
      if (!pid) {
        resolve({ running: false, pid: null, mem: null, cpu: null });
        return;
      }
      exec(`ps -o rss=,%cpu= -p ${pid}`, (err2, stdout2) => {
        if (err2) {
          resolve({ running: true, pid, mem: null, cpu: null });
          return;
        }
        const parts = stdout2.trim().split(/\s+/);
        resolve({ running: true, pid, mem: parts[0] || null, cpu: parts[1] || null });
      });
    });
  });
}

async function buildDashboard() {
  const serverInfo = await getProcessInfo('MarshallCamServer');
  const guardInfo = await getProcessInfo('kiosk-guard.sh');
  const avlockInfo = await getProcessInfo('av-lock.sh');
  const healthInfo = await getProcessInfo('health-monitor');

  const serverLogs = getLogTail(path.join(LOG_DIR, 'marshallcam.log'), 30);
  const guardLogs = getLogTail(path.join(LOG_DIR, 'kiosk-guard.log'), 20);
  const avlockLogs = getLogTail(path.join(LOG_DIR, 'avlock.log'), 20);

  const statusColor = (running) => running ? '#2ecc71' : '#e74c3c';
  const statusText = (running) => running ? 'RUNNING' : 'DOWN';

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="10">
    <title>MarshallCam Health</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #eee; margin: 0; padding: 20px; }
        h1 { color: #3498db; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .card { background: #1a1a1a; border-radius: 8px; padding: 20px; border: 1px solid #333; }
        .card h2 { margin-top: 0; color: #9b59b6; }
        .status { font-size: 24px; font-weight: bold; margin: 10px 0; }
        .logs { background: #000; color: #0f0; font-family: 'Courier New', monospace; padding: 15px; border-radius: 4px; font-size: 12px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
        .metric { color: #f39c12; }
        .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <h1>MarshallCam Kiosk Health</h1>
    <div class="grid">
        <div class="card">
            <h2>MarshallCam</h2>
            <div class="status" style="color: ${statusColor(serverInfo.running)}">${statusText(serverInfo.running)}</div>
            <div>PID: <span class="metric">${serverInfo.pid || 'N/A'}</span></div>
            <div>Memory: <span class="metric">${serverInfo.mem ? serverInfo.mem + 'KB' : 'N/A'}</span></div>
            <div>CPU: <span class="metric">${serverInfo.cpu ? serverInfo.cpu + '%' : 'N/A'}</span></div>
        </div>
        <div class="card">
            <h2>Kiosk Guard</h2>
            <div class="status" style="color: ${statusColor(guardInfo.running)}">${statusText(guardInfo.running)}</div>
            <div>PID: <span class="metric">${guardInfo.pid || 'N/A'}</span></div>
        </div>
        <div class="card">
            <h2>AV Lock</h2>
            <div class="status" style="color: ${statusColor(avlockInfo.running)}">${statusText(avlockInfo.running)}</div>
            <div>PID: <span class="metric">${avlockInfo.pid || 'N/A'}</span></div>
        </div>
        <div class="card">
            <h2>Health Monitor</h2>
            <div class="status" style="color: ${statusColor(healthInfo.running)}">${statusText(healthInfo.running)}</div>
            <div>PID: <span class="metric">${healthInfo.pid || 'N/A'}</span></div>
            <div>Port: <span class="metric">${PORT}</span></div>
        </div>
        <div class="card">
            <h2>Server Logs</h2>
            <div class="logs">${serverLogs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
        <div class="card">
            <h2>Guard Logs</h2>
            <div class="logs">${guardLogs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
        <div class="card">
            <h2>AV Lock Logs</h2>
            <div class="logs">${avlockLogs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
    </div>
    <div class="footer">
        Last update: ${new Date().toISOString()} | Auto-refresh: 10s
    </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const html = await buildDashboard();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end(`Error: ${e.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Health monitor listening on http://127.0.0.1:${PORT}`);
});

setInterval(() => {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 1048576) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      log('Log rotated.');
    }
  } catch (e) { /* noop */ }
}, 3600000);

log('HealthMonitor initialized.');
