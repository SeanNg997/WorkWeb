const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const INFO_FILE = 'info.json';
const LEGACY_COLLECTION_FILES = {
  notes: 'notes.json',
  projects: 'projects.json'
};

ensureDir(DATA_DIR);
ensureDataFile(INFO_FILE, []);
ensureCollectionDir('notes');
ensureCollectionDir('projects');
migrateLegacyCollection('notes');
migrateLegacyCollection('projects');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureDataFile(file, fallback = []) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf-8');
  }
  return filePath;
}

function ensureCollectionDir(key) {
  return ensureDir(path.join(DATA_DIR, key));
}

function readJSON(file, fallback = null) {
  const filePath = ensureDataFile(file, fallback ?? []);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  const filePath = ensureDataFile(file);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function listCollectionFiles(key) {
  const dir = ensureCollectionDir(key);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name));
}

function sanitizeEntityId(id, fallbackPrefix) {
  const raw = String(id || '').trim();
  if (raw) return raw.replace(/[^\w-]/g, '_');
  return `${fallbackPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readCollection(key) {
  return listCollectionFiles(key)
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

function writeCollection(key, items) {
  const dir = ensureCollectionDir(key);
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

  listCollectionFiles(key).forEach(filePath => {
    if (!keepFiles.has(path.basename(filePath))) fs.unlinkSync(filePath);
  });
}

function migrateLegacyCollection(key) {
  if (listCollectionFiles(key).length > 0) return;

  const legacyFile = LEGACY_COLLECTION_FILES[key];
  const legacyData = readJSON(legacyFile, []);
  if (Array.isArray(legacyData) && legacyData.length) writeCollection(key, legacyData);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/notes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readCollection('notes')));
    return;
  }

  if (pathname === '/api/notes' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        writeCollection('notes', JSON.parse(body));
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
    res.end(JSON.stringify(readJSON(INFO_FILE, [])));
    return;
  }

  if (pathname === '/api/info' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        writeJSON(INFO_FILE, JSON.parse(body));
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
    res.end(JSON.stringify(readCollection('projects')));
    return;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        writeCollection('projects', JSON.parse(body));
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
    '.js': 'application/javascript',
    '.json': 'application/json'
  };

  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`工作面板已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
