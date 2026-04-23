const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'WorkWeb';
const DATA_FILES = {
  notes: 'notes.json',
  info: 'info.json',
  projects: 'projects.json'
};
const EMPTY_DATA = {
  'notes.json': [],
  'info.json': [],
  'projects.json': []
};

function getIconPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, '..', 'image', 'icon.ico');
  }
  return path.join(__dirname, '..', 'image', 'icon_32.png');
}

function getDataDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(__dirname, '..', 'data');
}

function ensureDataFile(file) {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const fullPath = path.join(dataDir, file);
  if (!fs.existsSync(fullPath)) {
    const fallback = Object.prototype.hasOwnProperty.call(EMPTY_DATA, file) ? EMPTY_DATA[file] : [];
    fs.writeFileSync(fullPath, JSON.stringify(fallback, null, 2), 'utf8');
  }
  return fullPath;
}

function readDataFile(key) {
  const file = DATA_FILES[key];
  if (!file) throw new Error(`Unsupported data key: ${key}`);
  const fullPath = ensureDataFile(file);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return [];
  }
}

function writeDataFile(key, data) {
  const file = DATA_FILES[key];
  if (!file) throw new Error(`Unsupported data key: ${key}`);
  const fullPath = ensureDataFile(file);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true };
}

function createMainWindow() {
  const iconPath = getIconPath();
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const win = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: '#f5f3ef',
    autoHideMenuBar: true,
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
  return win;
}

function focusMainWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return createMainWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    app.setName(APP_NAME);

    if (process.platform === 'darwin' && app.dock) {
      const dockIconPath = path.join(__dirname, '..', 'image', 'icon_32.png');
      if (fs.existsSync(dockIconPath)) {
        app.dock.setIcon(dockIconPath);
      }
    }

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else {
        focusMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('data:read', async (_event, key) => {
  return readDataFile(key);
});

ipcMain.handle('data:write', async (_event, key, data) => {
  return writeDataFile(key, data);
});
