const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const KIOSK_DIR = path.join(process.env.HOME, 'MarshallOS');
const LOG_FILE = path.join(KIOSK_DIR, 'healthmonitor.log');
const PORT = 9999;

function log(msg) {
  const line = `[${new Date().toISOString()}] [HealthMonitor] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
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

function getUptime() {
  try {
    const uptime = fs.readFileSync('/proc/uptime', 'utf8');
    return Math.floor(parseFloat(uptime.split(' ')[0]));
  } catch (e) {
    return null;
  }
}

async function buildDashboard() {
  const kioskInfo = await getProcessInfo('MarshallCam.js');
  const watchdogInfo = await getProcessInfo('Watchdog.sh');
  const avlockInfo = await getProcessInfo('AV_Lock.sh');
  const healthInfo = await getProcessInfo('HealthMonitor');
  
  const kioskLogs = getLogTail(path.join(KIOSK_DIR, 'kiosk.log'), 30);
  const watchdogLogs = getLogTail(path.join(KIOSK_DIR, 'watchdog.log'), 20);
  const avlockLogs = getLogTail(path.join(KIOSK_DIR, 'avlock.log'), 20);
  
  const statusColor = (running) => running ? '#2ecc71' : '#e74c3c';
  const statusText = (running) => running ? 'RUNNING' : 'DOWN';
  
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="10">
    <title>Marshall | MarshallCam Kiosk Health</title>
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
    <h1>Marshall | MarshallCam Kiosk Health Monitor</h1>
    <div class="grid">
        <div class="card">
            <h2>MarshallCam</h2>
            <div class="status" style="color: ${statusColor(kioskInfo.running)}">${statusText(kioskInfo.running)}</div>
            <div>PID: <span class="metric">${kioskInfo.pid || 'N/A'}</span></div>
            <div>Memory: <span class="metric">${kioskInfo.mem ? kioskInfo.mem + 'KB' : 'N/A'}</span></div>
            <div>CPU: <span class="metric">${kioskInfo.cpu ? kioskInfo.cpu + '%' : 'N/A'}</span></div>
        </div>
        <div class="card">
            <h2>Watchdog</h2>
            <div class="status" style="color: ${statusColor(watchdogInfo.running)}">${statusText(watchdogInfo.running)}</div>
            <div>PID: <span class="metric">${watchdogInfo.pid || 'N/A'}</span></div>
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
            <h2>Kiosk Logs</h2>
            <div class="logs">${kioskLogs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
        <div class="card">
            <h2>Watchdog Logs</h2>
            <div class="logs">${watchdogLogs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
    </div>
    <div class="footer">
        Marshall Systems Architect | Last update: ${new Date().toLocaleString()} | Auto-refresh: 10s
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

server.listen(PORT, '0.0.0.0', () => {
  log(`Health monitor listening on http://0.0.0.0:${PORT}`);
});

// Rotate log file if too large
setInterval(() => {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > 1048576) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      log('Log rotated.');
    }
  } catch (e) {}
}, 3600000); // Check every hour

log('HealthMonitor initialized.');
