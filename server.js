const http = require('http');
const fs = require('fs');
const path = require('path');

const PACKAGE_FILE = path.join(__dirname, 'package.json');
const DEFAULT_PORT = Number(process.env.WORKWEB_PORT || 3000);
const DEFAULT_HOST = process.env.WORKWEB_HOST || '127.0.0.1';
const DEFAULT_DATA_DIR = path.resolve(process.env.WORKWEB_DATA_DIR || path.join(__dirname, 'data'));
const INFO_FILE = 'info.json';
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

function readJSON(dataDir, file, fallback = null) {
  const filePath = ensureDataFile(dataDir, file, fallback ?? []);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJSON(dataDir, file, data) {
  const filePath = ensureDataFile(dataDir, file);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
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
    if (!keepFiles.has(path.basename(filePath))) fs.unlinkSync(filePath);
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
  migrateLegacyCollection(dataDir, 'notes');
  migrateLegacyCollection(dataDir, 'projects');
}

function createServerContext(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const host = options.host || DEFAULT_HOST;
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);

  initializeData(dataDir);

  return {
    port,
    host,
    dataDir,
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: readPackageVersion() }));
      return;
    }

    if (pathname === '/api/notes' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readCollection(context.dataDir, 'notes')));
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
      '.png': 'image/png'
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
