const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');
const SERVER_LOG = path.join(RUNTIME_DIR, 'workweb-server.log');
const PORT = 3000;
const URL = `http://127.0.0.1:${PORT}`;

function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}

function requestOnce(url, timeoutMs = 800) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(maxWaitMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await requestOnce(URL)) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

function startServerInBackground() {
  ensureRuntimeDir();
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true
  });
  child.unref();
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

async function main() {
  if (!(await requestOnce(URL))) {
    startServerInBackground();
    const ready = await waitForServer();
    if (!ready) {
      console.error(`WorkWeb 启动失败，请查看日志: ${SERVER_LOG}`);
      process.exit(1);
    }
  }

  openBrowser(URL);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
