const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PACKAGE_FILE = path.join(__dirname, 'package.json');
const DEFAULT_PORT = Number(process.env.WORKWEB_PORT || 3000);
const DEFAULT_HOST = process.env.WORKWEB_HOST || '127.0.0.1';
const DEFAULT_DATA_DIR = path.resolve(process.env.WORKWEB_DATA_DIR || path.join(__dirname, 'data'));
const INFO_FILE = 'info.json';
const EXPORT_MAGIC = 'workweb-data-export';
const EXPORT_FILE_NAME = 'WorkWeb_data.workweb';
const TRASH_DIR = 'trash';
const FIGURES_DIR = path.join('projects', 'figures');
const LEGACY_COLLECTION_FILES = {
  notes: 'notes.json',
  projects: 'projects.json'
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureDataFile(dataDir, file, fallback = []) {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf-8');
  }
  return filePath;
}

function ensureCollectionDir(dataDir, key) {
  return ensureDir(path.join(dataDir, key));
}

function ensureTrashDir(dataDir, key = '') {
  return ensureDir(path.join(dataDir, TRASH_DIR, key));
}

function readJSON(dataDir, file, fallback = null) {
  const filePath = ensureDataFile(dataDir, file, fallback ?? []);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJSON(dataDir, file, data) {
  const filePath = ensureDataFile(dataDir, file);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function listCollectionFiles(dataDir, key) {
  const dir = ensureCollectionDir(dataDir, key);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name));
}

function sanitizeEntityId(id, fallbackPrefix) {
  const raw = String(id || '').trim();
  if (raw) return raw.replace(/[^\w-]/g, '_');
  return `${fallbackPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readCollection(dataDir, key) {
  return listCollectionFiles(dataDir, key)
    .map(filePath => {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { return null; }
    })
    .filter(item => item && typeof item === 'object')
    .sort((a, b) => {
      const orderDiff = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

function writeCollection(dataDir, key, items) {
  const dir = ensureCollectionDir(dataDir, key);
  const nextItems = Array.isArray(items) ? items : [];
  const keepFiles = new Set();

  nextItems.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;

    const id = sanitizeEntityId(item.id, key === 'notes' ? 'n' : 'p');
    const fileName = `${id}.json`;
    const nextItem = { ...item, id, order: index };

    keepFiles.add(fileName);
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(nextItem, null, 2), 'utf-8');
  });

  listCollectionFiles(dataDir, key).forEach(filePath => {
    if (keepFiles.has(path.basename(filePath))) return;

    const trashDir = ensureTrashDir(dataDir, key);
    const item = (() => {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { return {}; }
    })();
    const deletedAt = new Date().toISOString();
    const baseName = path.basename(filePath, '.json');
    const trashPath = makeUniqueFilePath(path.join(trashDir, `${baseName}_${Date.now()}.json`));
    fs.writeFileSync(trashPath, JSON.stringify({ ...item, deletedAt }, null, 2), 'utf-8');
    fs.unlinkSync(filePath);
  });
}

function migrateLegacyCollection(dataDir, key) {
  if (listCollectionFiles(dataDir, key).length > 0) return;

  const legacyFile = LEGACY_COLLECTION_FILES[key];
  const legacyData = readJSON(dataDir, legacyFile, []);
  if (Array.isArray(legacyData) && legacyData.length) writeCollection(dataDir, key, legacyData);
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf-8'));
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

function initializeData(dataDir) {
  ensureDir(dataDir);
  ensureDataFile(dataDir, INFO_FILE, []);
  ensureCollectionDir(dataDir, 'notes');
  ensureCollectionDir(dataDir, 'projects');
  ensureTrashDir(dataDir);
  ensureDir(path.join(dataDir, FIGURES_DIR));
  migrateLegacyCollection(dataDir, 'notes');
  migrateLegacyCollection(dataDir, 'projects');
}

function safeRelativePath(value) {
  const relativePath = String(value || '').replace(/\\/g, '/');
  if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) return '';
  return relativePath;
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error('图片格式不正确');
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64')
  };
}

function saveProjectFigure(dataDir, body = {}) {
  const { mime, buffer } = decodeDataUrl(body.dataUrl);
  const extByMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
  };
  const ext = extByMime[mime];
  if (!ext) throw new Error('仅支持常见图片格式');

  const rawName = String(body.name || '').trim();
  const safeBase = path.basename(rawName, path.extname(rawName)).replace(/[^\w-]+/g, '_') || 'figure';
  const fileName = `${Date.now()}_${safeBase}${ext}`;
  const targetDir = ensureDir(path.join(dataDir, FIGURES_DIR));
  const targetPath = makeUniqueFilePath(path.join(targetDir, fileName));
  fs.writeFileSync(targetPath, buffer);
  return path.relative(dataDir, targetPath).replace(/\\/g, '/');
}

function listTrash(dataDir) {
  const root = path.join(dataDir, TRASH_DIR);
  if (!fs.existsSync(root)) return [];

  const files = [];
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
    });
  }
  walk(root);

  return files.map(filePath => {
    let item = {};
    try { item = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
    const relativePath = path.relative(dataDir, filePath).replace(/\\/g, '/');
    const key = inferTrashCollection(relativePath, item);
    const stat = fs.statSync(filePath);
    return {
      file: relativePath,
      type: key === 'notes' ? 'todo' : 'project',
      title: item.title || (key === 'notes' ? '无标题 TODO' : '未命名项目'),
      deletedAt: item.deletedAt || stat.mtime.toISOString()
    };
  }).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

function inferTrashCollection(relativePath, item = {}) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/');
  if (['notes', 'todo', 'todos'].includes(parts[1])) return 'notes';
  if (['projects', 'project'].includes(parts[1])) return 'projects';
  if (Array.isArray(item.pages) || Object.prototype.hasOwnProperty.call(item, 'summary')) return 'projects';
  return 'notes';
}

function restoreTrashFile(dataDir, file) {
  const relativePath = safeRelativePath(file);
  if (!relativePath.startsWith(`${TRASH_DIR}/`) || !relativePath.endsWith('.json')) throw new Error('无效的恢复项目');
  const sourcePath = path.join(dataDir, relativePath);
  if (!sourcePath.startsWith(path.join(dataDir, TRASH_DIR)) || !fs.existsSync(sourcePath)) throw new Error('恢复项目不存在');

  const item = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  const key = inferTrashCollection(relativePath, item);
  if (!['notes', 'projects'].includes(key)) throw new Error('无效的恢复项目');

  delete item.deletedAt;
  const existingIds = new Set(readCollection(dataDir, key).map(entry => entry.id).filter(Boolean));
  const fallbackPrefix = key === 'notes' ? 'n' : 'p';
  const originalId = sanitizeEntityId(item.id, fallbackPrefix);
  const id = existingIds.has(originalId) ? sanitizeEntityId('', fallbackPrefix) : originalId;
  const targetDir = ensureCollectionDir(dataDir, key);
  const targetPath = path.join(targetDir, `${id}.json`);
  fs.writeFileSync(targetPath, JSON.stringify({ ...item, id, updatedAt: Date.now() }, null, 2), 'utf-8');
  fs.unlinkSync(sourcePath);
  return { type: key === 'notes' ? 'todo' : 'project' };
}

function clearTrash(dataDir) {
  const root = path.join(dataDir, TRASH_DIR);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
  ensureTrashDir(dataDir);
}

function listDataFiles(dataDir) {
  const root = path.resolve(dataDir);
  if (!fs.existsSync(root)) return [];

  const files = [];
  function walk(currentDir) {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (!entry.isFile()) return;

      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      files.push({
        path: relativePath,
        data: fs.readFileSync(fullPath).toString('base64')
      });
    });
  }

  walk(root);
  return files;
}

function createDataExport(dataDir, outputDir) {
  const rawOutputDir = String(outputDir || '').trim();
  if (!rawOutputDir) throw new Error('请选择导出目录');
  const targetDir = path.resolve(rawOutputDir);
  ensureDir(targetDir);

  const archive = {
    magic: EXPORT_MAGIC,
    version: 1,
    exportedAt: new Date().toISOString(),
    files: listDataFiles(dataDir)
  };
  const outputFile = path.join(targetDir, EXPORT_FILE_NAME);
  fs.writeFileSync(outputFile, zlib.gzipSync(JSON.stringify(archive)));
  return outputFile;
}

function readDataExport(filePath) {
  const rawFilePath = String(filePath || '').trim();
  if (!rawFilePath) throw new Error('请选择导入文件');
  const sourceFile = path.resolve(rawFilePath);
  if (!fs.existsSync(sourceFile)) throw new Error('请选择导入文件');

  let archive = null;
  try {
    archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(sourceFile)).toString('utf-8'));
  } catch {
    throw new Error('请导入正确的格式');
  }

  if (archive?.magic !== EXPORT_MAGIC || !Array.isArray(archive.files)) {
    throw new Error('请导入正确的格式');
  }

  return archive;
}

function makeUniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let index = 1;
  let nextPath = path.join(dir, `${base}_${index}${ext}`);

  while (fs.existsSync(nextPath)) {
    index += 1;
    nextPath = path.join(dir, `${base}_${index}${ext}`);
  }

  return nextPath;
}

function mergeInfoFile(dataDir, content) {
  const imported = JSON.parse(content);
  const current = readJSON(dataDir, INFO_FILE, []);
  if (!Array.isArray(imported)) return 0;

  const usedIds = new Set(current.map(item => item?.id).filter(Boolean));
  const nextItems = imported.map(item => {
    if (!item || typeof item !== 'object') return item;
    const nextItem = { ...item };
    if (nextItem.id && usedIds.has(nextItem.id)) nextItem.id = sanitizeEntityId('', 'i');
    if (nextItem.id) usedIds.add(nextItem.id);
    return nextItem;
  });

  writeJSON(dataDir, INFO_FILE, [...current, ...nextItems]);
  return nextItems.length;
}

function mergeCollectionFile(dataDir, key, relativePath, content) {
  const item = JSON.parse(content);
  if (!item || typeof item !== 'object') return 0;

  const dir = ensureCollectionDir(dataDir, key);
  const fallbackPrefix = key === 'notes' ? 'n' : 'p';
  const existingIds = new Set(readCollection(dataDir, key).map(entry => entry.id).filter(Boolean));
  const nextItem = { ...item };
  if (!nextItem.id || existingIds.has(nextItem.id)) nextItem.id = sanitizeEntityId('', fallbackPrefix);

  const fileName = `${sanitizeEntityId(nextItem.id, fallbackPrefix)}.json`;
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(nextItem, null, 2), 'utf-8');
  return 1;
}

function mergeLegacyCollectionFile(dataDir, key, content) {
  const items = JSON.parse(content);
  if (!Array.isArray(items)) return 0;

  return items.reduce((count, item) => {
    const file = {
      path: `${key}/${sanitizeEntityId(item?.id, key === 'notes' ? 'n' : 'p')}.json`,
      data: Buffer.from(JSON.stringify(item || {})).toString('base64')
    };
    return count + writeImportedFile(dataDir, file);
  }, 0);
}

function writeImportedFile(dataDir, file) {
  const relativePath = safeRelativePath(file?.path);
  if (!relativePath) return 0;

  const content = Buffer.from(String(file.data || ''), 'base64').toString('utf-8');
  if (relativePath === INFO_FILE) return mergeInfoFile(dataDir, content);
  if (relativePath === 'notes.json') return mergeLegacyCollectionFile(dataDir, 'notes', content);
  if (relativePath === 'projects.json') return mergeLegacyCollectionFile(dataDir, 'projects', content);
  if (relativePath.startsWith('notes/') && relativePath.endsWith('.json')) {
    return mergeCollectionFile(dataDir, 'notes', relativePath, content);
  }
  if (relativePath.startsWith('projects/') && relativePath.endsWith('.json')) {
    return mergeCollectionFile(dataDir, 'projects', relativePath, content);
  }

  const targetPath = makeUniqueFilePath(path.join(dataDir, relativePath));
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, Buffer.from(String(file.data || ''), 'base64'));
  return 1;
}

function importDataExport(dataDir, filePath) {
  const archive = readDataExport(filePath);
  initializeData(dataDir);
  return archive.files.reduce((count, file) => count + writeImportedFile(dataDir, file), 0);
}

function mergeDataDirs(sourceDir, targetDir) {
  ensureDir(targetDir);
  const archive = {
    files: listDataFiles(sourceDir)
  };
  return archive.files.reduce((count, file) => count + writeImportedFile(targetDir, file), 0);
}

function createServerContext(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT);
  const host = options.host || DEFAULT_HOST;
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);

  initializeData(dataDir);

  return {
    port,
    host,
    dataDir,
    onDataDirChange: typeof options.onDataDirChange === 'function' ? options.onDataDirChange : null,
    origin: `http://${host}:${port}`
  };
}

function createServer(options = {}) {
  const context = createServerContext(options);

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, context.origin);
    const pathname = url.pathname;

    if (pathname === '/api/version' && req.method === 'GET') {
      sendJSON(res, 200, { version: readPackageVersion() });
      return;
    }

    if (pathname === '/api/data-dir' && req.method === 'GET') {
      sendJSON(res, 200, { dataDir: context.dataDir });
      return;
    }

    if (pathname === '/api/data-dir' && req.method === 'POST') {
      readRequestBody(req).then(async body => {
        const rawTargetDir = String(body?.targetDir || '').trim();
        if (!rawTargetDir) {
          sendJSON(res, 400, { error: '请选择新的数据目录' });
          return;
        }

        try {
          const targetDir = path.resolve(rawTargetDir);
          const previousDir = context.dataDir;
          if (path.resolve(previousDir).toLowerCase() === targetDir.toLowerCase()) {
            sendJSON(res, 200, { ok: true, dataDir: targetDir });
            return;
          }

          initializeData(previousDir);
          mergeDataDirs(previousDir, targetDir);
          initializeData(targetDir);
          context.dataDir = targetDir;
          await context.onDataDirChange?.(targetDir);
          sendJSON(res, 200, { ok: true, dataDir: targetDir });
        } catch (error) {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '迁移数据失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/export-data' && req.method === 'POST') {
      readRequestBody(req).then(body => {
        try {
          const filePath = createDataExport(context.dataDir, body?.outputDir);
          sendJSON(res, 200, { ok: true, filePath });
        } catch (error) {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '导出失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/import-data' && req.method === 'POST') {
      readRequestBody(req).then(body => {
        try {
          const importedCount = importDataExport(context.dataDir, body?.filePath);
          sendJSON(res, 200, { ok: true, importedCount });
        } catch (error) {
          const message = error instanceof Error ? error.message : '导入失败';
          sendJSON(res, message === '请导入正确的格式' ? 400 : 500, { error: message });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/notes' && req.method === 'GET') {
      sendJSON(res, 200, readCollection(context.dataDir, 'notes'));
      return;
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          writeCollection(context.dataDir, 'notes', JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readJSON(context.dataDir, INFO_FILE, [])));
      return;
    }

    if (pathname === '/api/info' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          writeJSON(context.dataDir, INFO_FILE, JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readCollection(context.dataDir, 'projects')));
      return;
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          writeCollection(context.dataDir, 'projects', JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (pathname === '/api/project-figures' && req.method === 'POST') {
      readRequestBody(req).then(body => {
        try {
          const imagePath = saveProjectFigure(context.dataDir, body);
          sendJSON(res, 200, { ok: true, path: imagePath });
        } catch (error) {
          sendJSON(res, 400, { error: error instanceof Error ? error.message : '保存图片失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/trash' && req.method === 'GET') {
      sendJSON(res, 200, listTrash(context.dataDir));
      return;
    }

    if (pathname === '/api/restore-trash' && req.method === 'POST') {
      readRequestBody(req).then(body => {
        try {
          sendJSON(res, 200, { ok: true, ...restoreTrashFile(context.dataDir, body?.file) });
        } catch (error) {
          sendJSON(res, 400, { error: error instanceof Error ? error.message : '恢复失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/clear-trash' && req.method === 'POST') {
      clearTrash(context.dataDir);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/projects/figures/')) {
      const relativePath = safeRelativePath(decodeURIComponent(pathname.slice(1)));
      const figureRoot = path.join(context.dataDir, FIGURES_DIR);
      const figurePath = path.join(context.dataDir, relativePath);
      if (!relativePath.startsWith(`${FIGURES_DIR.replace(/\\/g, '/')}/`) || !figurePath.startsWith(figureRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(figurePath) || fs.statSync(figurePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const figureMime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      };
      res.writeHead(200, { 'Content-Type': figureMime[path.extname(figurePath).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(figurePath).pipe(res);
      return;
    }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.ico': 'image/x-icon',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };

    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  return { server, context };
}

function startServer(options = {}) {
  const { server, context } = createServer(options);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.port, context.host, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : context.port;
      server.off('error', reject);
      resolve({
        server,
        ...context,
        port: actualPort,
        origin: `http://${context.host}:${actualPort}`
      });
    });
  });
}

if (require.main === module) {
  startServer().then(({ origin, dataDir }) => {
    console.log(`工作面板已启动: ${origin}`);
    console.log(`数据目录: ${dataDir}`);
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  createServer,
  readPackageVersion,
  startServer
};
