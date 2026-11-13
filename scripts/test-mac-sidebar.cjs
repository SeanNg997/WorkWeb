'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('../server');

const rootDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-mac-sidebar-'));
const dataDir = path.join(tempDir, 'data');
const mockPreload = path.join(tempDir, 'platform-preload.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;

app.setPath('userData', path.join(tempDir, 'userData'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function evaluate(window, script) {
  return withTimeout(window.webContents.executeJavaScript(script), 10000, 'Renderer timed out');
}

async function sendMouseClick(window, x, y) {
  const event = { x, y, button: 'left', clickCount: 1 };
  window.webContents.sendInputEvent({ ...event, type: 'mouseDown' });
  window.webContents.sendInputEvent({ ...event, type: 'mouseUp' });
  await wait(40);
}

async function waitFor(window, script, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(window, script)) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${message}`);
}

function createWindow(platform) {
  const isMac = platform === 'darwin';
  const nativeVibrancy = isMac && typeof BrowserWindow.prototype.setVibrancy === 'function';
  return new BrowserWindow({
    show: isMac,
    width: 760,
    height: 850,
    minWidth: 600,
    title: 'WorkWeb sidebar test',
    transparent: nativeVibrancy,
    ...(nativeVibrancy
      ? {
          vibrancy: 'sidebar',
          visualEffectState: 'active',
          roundedCorners: true,
          hasShadow: true,
          backgroundColor: '#00000000'
        }
      : {}),
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      ...(nativeVibrancy ? { additionalArguments: ['--workweb-native-vibrancy'] } : {}),
      ...(platform === 'browser' ? {} : {
        preload: isMac ? path.join(rootDir, 'electron', 'preload.js') : mockPreload,
        ...(!nativeVibrancy ? { additionalArguments: isMac ? [] : [`--workweb-test-platform=${platform}`] } : {})
      })
    },
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {})
  });
}

async function verifyLayout(window) {
  return evaluate(window, `(() => {
    const sidebar = document.getElementById('primarySidebar');
    const button = document.getElementById('sidebarExpandBtn');
    const workspaceHeader = document.querySelector('.workspace-header');
    const titlebar = document.querySelector('.desktop-titlebar');
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      sidebarWidth: sidebar.getBoundingClientRect().width,
      workspaceWidth: document.querySelector('.workspace').getBoundingClientRect().width,
      buttonWidth: rect.width,
      buttonHeight: rect.height,
      buttonLeft: rect.left,
      buttonTop: rect.top,
      titlebarHeight: document.querySelector('.desktop-titlebar')?.getBoundingClientRect().height || 0,
      titlebarPreviousSibling: titlebar?.previousElementSibling?.className || 'removed',
      buttonParent: button.parentElement.id || button.parentElement.className,
      buttonDisplay: getComputedStyle(button).display,
      windowsControlsDisplay: document.querySelector('.windows-window-controls')
        ? getComputedStyle(document.querySelector('.windows-window-controls')).display
        : 'removed',
      hitButton: hit?.closest('#sidebarExpandBtn') === button,
      appRegion: getComputedStyle(button).webkitAppRegion,
      workspaceHeaderRegion: getComputedStyle(document.querySelector('.workspace-header')).webkitAppRegion,
      titlebarRegion: titlebar ? getComputedStyle(titlebar).webkitAppRegion : 'removed',
      dragRegion: getComputedStyle(document.elementFromPoint(140, 20)).webkitAppRegion,
      inert: sidebar.inert,
      activeElement: document.activeElement.id
    };
  })()`);
}

async function waitForCollapsed(window, width) {
  await waitFor(window, `document.body.classList.contains('sidebar-collapsed') &&
    document.getElementById('sidebarExpandBtn').disabled === false &&
    document.getElementById('primarySidebar').getBoundingClientRect().width === ${width}`,
  `sidebar width ${width}`);
}

async function verifyMacWindow(origin) {
  registerTestIpcHandlers();

  const window = createWindow('darwin');
  try {
    await withTimeout(window.loadURL(origin), 15000, 'Mac window load timed out');
    await waitFor(window, "document.getElementById('sidebarToggleBtn') && !document.getElementById('sidebarToggleBtn').disabled", 'Mac UI ready');
    await evaluate(window, "localStorage.setItem('wb_sidebar_collapsed', '0'); location.reload()");
    await waitFor(window, "!document.body.classList.contains('sidebar-collapsed') && !document.getElementById('primarySidebar').inert", 'expanded Mac state');

    const expandedWidth = await evaluate(window, "document.getElementById('primarySidebar').getBoundingClientRect().width");
    assert.equal(expandedWidth, 270);
    const initialWorkspaceWidth = await evaluate(window, "document.querySelector('.workspace').getBoundingClientRect().width");

    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 0);
    let state = await verifyLayout(window);
    assert.equal(state.sidebarWidth, 0);
    assert.equal(state.workspaceWidth, 760);
    assert.ok(state.workspaceWidth > initialWorkspaceWidth);
    assert.equal(state.buttonParent, 'desktop-titlebar');
    assert.deepEqual([state.buttonWidth, state.buttonHeight], [40, 40]);
    assert.equal(state.buttonLeft, 84);
    assert.equal(state.buttonTop, 5);
    assert.equal(state.buttonTop + state.buttonHeight, state.titlebarHeight - 1);
    assert.equal(state.buttonDisplay, 'grid');
    assert.equal(state.windowsControlsDisplay, 'none');
    assert.equal(state.hitButton, true);
    assert.equal(state.titlebarPreviousSibling, 'workspace');
    assert.equal(state.workspaceHeaderRegion, 'drag');
    assert.equal(state.titlebarRegion, 'drag');
    console.log('PASS macOS titlebar follows workspace and preserves drag regions');
    assert.equal(state.appRegion, 'no-drag');
    assert.equal(state.dragRegion, 'drag');
    assert.equal(state.inert, true);
    assert.equal(state.activeElement, 'sidebarExpandBtn');
    assert.equal(await evaluate(window, "localStorage.getItem('wb_sidebar_collapsed')"), '1');
    await evaluate(window, "document.querySelector('.nav-item').focus()");
    assert.notEqual(await evaluate(window, 'document.activeElement.className'), 'nav-item');
    console.log('PASS mac collapse width, workspace, hit area, drag regions, inert and focus');

    await withTimeout(window.webContents.reload(), 15000, 'Reload timed out');
    await waitForCollapsed(window, 0);
    state = await verifyLayout(window);
    assert.equal(state.sidebarWidth, 0);
    assert.equal(state.buttonLeft, 84);
    assert.equal(state.buttonParent, 'desktop-titlebar');
    assert.equal(state.inert, true);
    console.log('PASS collapsed state persists after reload');

    let point = await evaluate(window, `(() => {
      const rect = document.getElementById('sidebarExpandBtn').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await sendMouseClick(window, point.x, point.y);
    await waitFor(window, `!document.body.classList.contains('sidebar-collapsed') &&
      !document.getElementById('sidebarToggleBtn').disabled && document.getElementById('primarySidebar').getBoundingClientRect().width > 269`, 'Mac expand');
    assert.equal(await evaluate(window, 'document.activeElement.id'), 'sidebarToggleBtn');
    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 0);
    point = await evaluate(window, `(() => {
      const rect = document.getElementById('sidebarExpandBtn').getBoundingClientRect();
      return { x: rect.left + 2, y: rect.top + rect.height / 2 };
    })()`);
    await sendMouseClick(window, point.x, point.y);
    await waitFor(window, `!document.body.classList.contains('sidebar-collapsed') &&
      !document.getElementById('sidebarToggleBtn').disabled && document.getElementById('primarySidebar').getBoundingClientRect().width > 269`, 'Mac edge click');
    assert.equal(await evaluate(window, 'document.activeElement.id'), 'sidebarToggleBtn');
    console.log('PASS titlebar center and edge mouse clicks restore keyboard focus');

    const entered = new Promise(resolve => window.once('enter-full-screen', resolve));
    window.setFullScreen(true);
    await withTimeout(entered, 10000, 'Native fullscreen did not enter');
    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 0);
    state = await verifyLayout(window);
    assert.equal(state.buttonLeft, 84);
    assert.equal(state.buttonTop, 5);
    assert.equal(state.hitButton, true);
    assert.equal(state.dragRegion, 'drag');
    console.log('PASS fullscreen collapse and titlebar control remain available');

    point = await evaluate(window, `(() => {
      const rect = document.getElementById('sidebarExpandBtn').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await sendMouseClick(window, point.x, point.y);
    await waitFor(window, `!document.body.classList.contains('sidebar-collapsed') &&
      !document.getElementById('sidebarToggleBtn').disabled && document.getElementById('primarySidebar').getBoundingClientRect().width > 269`, 'fullscreen mouse click');
    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 0);

    const exited = new Promise(resolve => window.once('leave-full-screen', resolve));
    window.setFullScreen(false);
    await withTimeout(exited, 10000, 'Native fullscreen did not exit');
    state = await verifyLayout(window);
    assert.equal(state.buttonLeft, 84);
    assert.equal(state.hitButton, true);
    point = await evaluate(window, `(() => {
      const rect = document.getElementById('sidebarExpandBtn').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await sendMouseClick(window, point.x, point.y);
    await waitFor(window, `!document.body.classList.contains('sidebar-collapsed') &&
      !document.getElementById('sidebarToggleBtn').disabled && !document.getElementById('primarySidebar').inert &&
      document.getElementById('primarySidebar').getBoundingClientRect().width > 269`, 'Mac expand after fullscreen');
    assert.ok(await evaluate(window, "document.getElementById('primarySidebar').getBoundingClientRect().width > 269"));

    window.setSize(620, 850);
    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 0);
    state = await verifyLayout(window);
    assert.equal(state.buttonDisplay, 'grid');
    assert.equal(state.buttonLeft, 84);
    assert.equal(state.buttonWidth, 40);
    assert.equal(state.hitButton, true);
    await evaluate(window, "document.getElementById('sidebarExpandBtn').click()");
    await waitFor(window, "!document.body.classList.contains('sidebar-collapsed')", 'narrow window expand');
    console.log('PASS expand control remains visible and clickable at narrow width');
    console.log('PASS titlebar control remains usable after fullscreen exit');
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function registerTestIpcHandlers() {
  ipcMain.handle('workweb:setWindowTheme', () => true);
  ipcMain.handle('workweb:getSetting', () => undefined);
  ipcMain.handle('workweb:setSetting', (_event, _key, value) => value);
  ipcMain.handle('workweb:getUpdateState', () => ({ supported: false, status: 'unsupported' }));
  ipcMain.handle('workweb:checkLatestVersion', () => ({ hasUpdate: false }));
}

async function holdMacWindow(origin) {
  registerTestIpcHandlers();
  const window = createWindow('darwin');
  await withTimeout(window.loadURL(origin), 15000, 'Mac window load timed out');
  await waitFor(window, "document.getElementById('sidebarToggleBtn')", 'Mac UI ready');
  await evaluate(window, "localStorage.setItem('wb_sidebar_collapsed', '1'); location.reload()");
  await waitForCollapsed(window, 0);
  console.log('READY native mouse click test; close this window to finish');
  await new Promise(resolve => window.once('closed', resolve));
}

async function verifyFallbackWindow(origin, platform) {
  const window = createWindow(platform);
  try {
    await withTimeout(window.loadURL(origin), 15000, `${platform} window load timed out`);
    await waitFor(window, "document.getElementById('sidebarToggleBtn')", `${platform} UI ready`);
    await evaluate(window, "localStorage.setItem('wb_sidebar_collapsed', '0'); location.reload()");
    await waitFor(window, "!document.body.classList.contains('sidebar-collapsed')", `${platform} initial state`);
    assert.equal(await evaluate(window, "document.documentElement.classList.contains('platform-darwin')"), false);
    assert.equal(await evaluate(window, "document.querySelector('.sidebar').getBoundingClientRect().width"), 270);

    await evaluate(window, "document.getElementById('sidebarToggleBtn').click()");
    await waitForCollapsed(window, 64);
    const state = await verifyLayout(window);
    assert.equal(state.sidebarWidth, 64);
    assert.equal(state.buttonParent, 'sidebar-footer');
    assert.equal(state.inert, false);
    if (platform === 'win32') {
      assert.equal(state.workspaceHeaderRegion, 'drag');
      console.log('PASS win32 workspace header drag region remains unchanged');
    }
    await evaluate(window, "document.getElementById('sidebarExpandBtn').click()");
    await waitFor(window, "!document.body.classList.contains('sidebar-collapsed') && document.getElementById('primarySidebar').getBoundingClientRect().width > 269", `${platform} expand`);
    console.log(`PASS ${platform} remains 64px and uses the sidebar toggle`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function run() {
  await app.whenReady();
  fs.writeFileSync(mockPreload, `const { contextBridge } = require('electron');
const platform = process.argv.find(value => value.startsWith('--workweb-test-platform='))?.split('=')[1] || '';
contextBridge.exposeInMainWorld('workwebDesktop', { platform, nativeAcrylic: false, nativeVibrancy: false });
`);
  const instance = createServer({ dataDir, host: '127.0.0.1', port: 0 });
  server = instance.server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  if (process.argv.includes('--hold')) {
    await holdMacWindow(origin);
    return;
  }

  await verifyMacWindow(origin);
  for (const platform of ['win32', 'linux', 'browser']) {
    await verifyFallbackWindow(origin, platform);
  }
}

async function cleanup() {
  server?.closeAllConnections?.();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

run().then(async () => {
  console.log('PASS macOS sidebar regression');
  await cleanup();
  app.exit(0);
}).catch(async error => {
  console.error(error.stack || error);
  await cleanup();
  app.exit(1);
});
