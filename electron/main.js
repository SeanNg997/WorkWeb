const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startServer } = require('../server');

const APP_ID = 'com.xiaoran.workweb';
const HOST = '127.0.0.1';
const ICON_PATH = path.join(__dirname, '..', 'image', process.platform === 'darwin' ? 'icon.icns' : 'icon.ico');
const SETTINGS_FILE_NAME = 'desktop-settings.json';
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const ALLOWED_DESKTOP_SETTING_KEYS = new Set(['wb_markdown_size']);

let mainWindow = null;
let localServer = null;
let updateState = {
  supported: false,
  status: 'idle',
  message: '尚未检查更新',
  version: '',
  progress: 0
};

app.setAppUserModelId(APP_ID);
app.setName('WorkWeb');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readJSONFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJSONFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function saveDataDirSetting(dataDir) {
  const settingsFile = getSettingsFilePath();
  const settings = readJSONFile(settingsFile, {});
  writeJSONFile(settingsFile, {
    ...settings,
    dataDir,
    dataDirConfirmed: true
  });
}

function readDesktopSettings() {
  return readJSONFile(getSettingsFilePath(), {});
}

function saveDesktopSetting(key, value) {
  if (!ALLOWED_DESKTOP_SETTING_KEYS.has(key)) return undefined;
  const settingsFile = getSettingsFilePath();
  const settings = readJSONFile(settingsFile, {});
  writeJSONFile(settingsFile, {
    ...settings,
    [key]: value
  });
  return value;
}

function isWindowsUpdaterSupported() {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function sendUpdateState(patch = {}) {
  updateState = {
    ...updateState,
    supported: isWindowsUpdaterSupported(),
    ...patch
  };
  mainWindow?.webContents.send('workweb:updateState', updateState);
  return updateState;
}

function configureAutoUpdater() {
  updateState.supported = isWindowsUpdaterSupported();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({ status: 'checking', message: '正在检查更新', progress: 0 });
  });

  autoUpdater.on('update-available', info => {
    sendUpdateState({
      status: 'available',
      message: `发现新版本 v${info?.version || ''}`,
      version: info?.version || '',
      progress: 0
    });
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateState({ status: 'latest', message: '当前已经是最新版本', progress: 0 });
  });

  autoUpdater.on('download-progress', progress => {
    sendUpdateState({
      status: 'downloading',
      message: '正在下载更新',
      progress: Math.max(0, Math.min(100, Number(progress?.percent || 0)))
    });
  });

  autoUpdater.on('update-downloaded', () => {
    sendUpdateState({ status: 'downloaded', message: '下载完成，正在重启安装', progress: 100 });
    setTimeout(() => {
      autoUpdater.quitAndInstall(false, true);
    }, 800);
  });

  autoUpdater.on('error', error => {
    sendUpdateState({
      status: 'error',
      message: error instanceof Error ? error.message : '更新失败',
      progress: 0
    });
  });
}

function isWritableDir(dirPath) {
  try {
    ensureDir(dirPath);
    const probeFile = path.join(dirPath, '.workweb-write-check');
    fs.writeFileSync(probeFile, '');
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

function resolveSuggestedDataDir() {
  if (process.platform === 'darwin') {
    const appBundleDir = path.resolve(path.dirname(process.execPath), '..', '..');
    return path.join(appBundleDir, 'data');
  }

  return path.join(path.dirname(process.execPath), 'data');
}

function normalizeStoredDataDir(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function looksLikeSourceWorkspace(dirPath) {
  let currentPath = path.resolve(dirPath);

  for (let depth = 0; depth < 6; depth += 1) {
    const hasProjectMarkers =
      fs.existsSync(path.join(currentPath, 'package.json')) &&
      fs.existsSync(path.join(currentPath, 'index.html')) &&
      fs.existsSync(path.join(currentPath, 'server.js'));

    if (hasProjectMarkers) return true;

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  return false;
}

function shouldReuseStoredDataDir(settings, storedDataDir) {
  if (!storedDataDir) return false;
  if (settings.dataDirConfirmed !== true) return false;
  if (!isWritableDir(storedDataDir)) return false;
  if (app.isPackaged && looksLikeSourceWorkspace(storedDataDir)) return false;
  return true;
}

async function chooseDataDir(defaultPath) {
  while (true) {
    const intro = await dialog.showMessageBox({
      type: 'info',
      title: 'WorkWeb',
      buttons: ['使用默认路径', '选择其他位置', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: '首次启动需要选择数据目录',
      detail: `默认数据路径：${defaultPath}\n\n如果不修改默认路径，数据会保存在软件安装目录下的 data 文件夹中；当软件被卸载时，这些数据可能被一并删除。`
    });

    if (intro.response === 2) return '';
    if (intro.response === 0) {
      if (isWritableDir(defaultPath)) return path.resolve(defaultPath);

      const fallback = await dialog.showMessageBox({
        type: 'error',
        title: 'WorkWeb',
        buttons: ['重新选择', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: '默认数据目录无法创建',
        detail: `无法使用默认路径：${defaultPath}\n请重新选择其他可写入的位置。`
      });

      if (fallback.response !== 0) return '';
      continue;
    }

    break;
  }

  let currentPath = defaultPath;
  while (true) {
    const result = await dialog.showOpenDialog({
      title: '选择 WorkWeb 数据目录',
      defaultPath: currentPath,
      buttonLabel: '使用这个目录',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || !result.filePaths[0]) return '';

    const selectedDir = path.resolve(result.filePaths[0]);
    if (isWritableDir(selectedDir)) return selectedDir;

    const retry = await dialog.showMessageBox({
      type: 'error',
      title: 'WorkWeb',
      buttons: ['重新选择', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: '所选目录无法写入',
      detail: '请重新选择一个有写入权限的文件夹。'
    });

    if (retry.response !== 0) return '';
    currentPath = selectedDir;
  }
}

async function resolveDataDir() {
  if (!app.isPackaged) return path.join(app.getAppPath(), 'data');

  const settingsFile = getSettingsFilePath();
  const settings = readJSONFile(settingsFile, {});
  const storedDataDir = normalizeStoredDataDir(settings.dataDir);

  if (shouldReuseStoredDataDir(settings, storedDataDir)) return storedDataDir;

  const selectedDir = await chooseDataDir(resolveSuggestedDataDir());
  if (!selectedDir) throw new Error('未选择数据目录，应用已取消启动');

  writeJSONFile(settingsFile, {
    ...settings,
    dataDir: selectedDir,
    dataDirConfirmed: true
  });
  return selectedDir;
}

async function ensureServer() {
  if (localServer) return localServer.origin;

  localServer = await startServer({
    dataDir: await resolveDataDir(),
    host: HOST,
    port: 0,
    onDataDirChange: saveDataDirSetting
  });

  return localServer.origin;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: 'WorkWeb',
    icon: ICON_PATH,
    backgroundColor: '#f4efe4',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('workweb:selectDirectory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件夹',
      buttonLabel: options.buttonLabel || '选择',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });

    return result.canceled ? '' : result.filePaths[0] || '';
  });

  ipcMain.handle('workweb:selectImportFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 WorkWeb 数据文件',
      buttonLabel: '导入',
      filters: [
        { name: 'WorkWeb 数据文件', extensions: ['workweb'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    return result.canceled ? '' : result.filePaths[0] || '';
  });

  ipcMain.handle('workweb:getSetting', (_event, key) => {
    if (!ALLOWED_DESKTOP_SETTING_KEYS.has(key)) return undefined;
    const settings = readDesktopSettings();
    return settings?.[key];
  });

  ipcMain.handle('workweb:setSetting', (_event, key, value) => saveDesktopSetting(key, value));

  ipcMain.handle('workweb:getUpdateState', () => sendUpdateState());

  ipcMain.handle('workweb:checkForUpdates', async () => {
    if (!isWindowsUpdaterSupported()) {
      return sendUpdateState({
        status: 'unsupported',
        message: '自动更新仅支持 Windows 安装版，不支持便携版',
        progress: 0
      });
    }

    await autoUpdater.checkForUpdates();
    return updateState;
  });

  ipcMain.handle('workweb:downloadUpdate', async () => {
    if (!isWindowsUpdaterSupported()) {
      return sendUpdateState({
        status: 'unsupported',
        message: '自动更新仅支持 Windows 安装版，不支持便携版',
        progress: 0
      });
    }

    sendUpdateState({ status: 'downloading', message: '正在下载更新', progress: 0 });
    await autoUpdater.downloadUpdate();
    return updateState;
  });
}

async function openApp() {
  const url = await ensureServer();

  if (!mainWindow) createWindow();
  await mainWindow.loadURL(url);
  mainWindow.show();
}

function handleFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (app.isReady()) dialog.showErrorBox('WorkWeb 启动失败', message);
  app.quit();
}

const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      openApp().catch(handleFatalError);
      return;
    }

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    configureAutoUpdater();
    registerIpcHandlers();
    openApp().catch(handleFatalError);
  });

  app.on('activate', () => {
    if (!mainWindow) openApp().catch(handleFatalError);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async () => {
    if (!localServer?.server) return;
    await new Promise(resolve => localServer.server.close(resolve));
    localServer = null;
  });
}
