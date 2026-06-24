const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PACKAGE_FILE = path.join(__dirname, 'package.json');
const DEFAULT_PORT = Number(process.env.WORKWEB_PORT || 3000);
const DEFAULT_HOST = process.env.WORKWEB_HOST || '127.0.0.1';
const DEFAULT_DATA_DIR = path.resolve(process.env.WORKWEB_DATA_DIR || path.join(__dirname, 'data'));
const INFO_FILE = 'info.json';
const STORAGE_META_FILE = 'storage-meta.json';
const STORAGE_SCHEMA_VERSION = 2;
const EXPORT_MAGIC = 'workweb-data-export';
const EXPORT_FILE_NAME = 'WorkWeb_data.workweb';
const TRASH_DIR = 'trash';
const FIGURES_DIR = path.join('projects', 'figures');
const PROJECT_ITEMS_DIR = path.join('projects', 'items');
const BACKUP_DIR = 'backups';
const DEFAULT_AI_MAX_TOKENS = 150;
const AI_REQUEST_TIMEOUT_MS = 15000;
const MIME_TYPES = {
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
const LEGACY_COLLECTION_FILES = {
  notes: 'notes.json',
  projects: 'projects.json'
};

class ConflictError extends Error {
  constructor(message, current) {
    super(message);
    this.name = 'ConflictError';
    this.current = current;
  }
}

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

function ensureProjectItemsDir(dataDir) {
  return ensureDir(path.join(dataDir, PROJECT_ITEMS_DIR));
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

function readOptionalJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJSONFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function nextRevision(previousRevision = 0) {
  const previous = Number(previousRevision) || 0;
  const now = Date.now();
  return now > previous ? now : previous + 1;
}

function readStorageMeta(dataDir) {
  return readOptionalJSON(path.join(dataDir, STORAGE_META_FILE), null);
}

function writeStorageMeta(dataDir, data = {}) {
  writeJSONFile(path.join(dataDir, STORAGE_META_FILE), {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ...data
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function collectFiles(root, shouldInclude = () => true) {
  if (!fs.existsSync(root)) return [];

  const files = [];
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (entry.isFile() && shouldInclude(fullPath, entry)) files.push(fullPath);
    });
  }

  walk(root);
  return files;
}

function listCollectionFiles(dataDir, key) {
  const dir = ensureCollectionDir(dataDir, key);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name));
}

function listLegacyProjectFiles(dataDir) {
  const dir = ensureCollectionDir(dataDir, 'projects');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(dir, entry.name));
}

function listProjectDirs(dataDir) {
  const dir = ensureProjectItemsDir(dataDir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name));
}

function sanitizeEntityId(id, fallbackPrefix) {
  const raw = String(id || '').trim();
  if (raw) return raw.replace(/[^\w-]/g, '_');
  return `${fallbackPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePageId(id) {
  return sanitizeEntityId(id, 'pg');
}

function normalizeNoteItem(item = {}, index = 0) {
  const id = sanitizeEntityId(item.id, 'n');
  const updatedAt = Number(item.updatedAt) || Date.now();
  return {
    ...item,
    id,
    title: String(item.title || ''),
    content: String(item.content || ''),
    span: Math.max(1, Math.min(3, Number(item.span) || 1)),
    createdAt: Number(item.createdAt) || updatedAt,
    updatedAt,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    revision: Number(item.revision) || updatedAt
  };
}

function readNotes(dataDir) {
  return listCollectionFiles(dataDir, 'notes')
    .map(filePath => {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { return null; }
    })
    .filter(item => item && typeof item === 'object')
    .map((item, index) => normalizeNoteItem(item, index))
    .sort((a, b) => {
      const orderDiff = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

function readNote(dataDir, id) {
  const safeId = sanitizeEntityId(id, 'n');
  const filePath = path.join(ensureCollectionDir(dataDir, 'notes'), `${safeId}.json`);
  const item = readOptionalJSON(filePath, null);
  return item && typeof item === 'object' ? normalizeNoteItem(item) : null;
}

function writeNote(dataDir, item, options = {}) {
  const existing = item?.id ? readNote(dataDir, item.id) : null;
  const baseRevision = options.baseRevision;
  if (existing && baseRevision != null && Number(baseRevision) !== Number(existing.revision || 0)) {
    throw new ConflictError('便笺已在其他设备更新', existing);
  }

  const note = normalizeNoteItem(
    {
      ...existing,
      ...item,
      updatedAt: item?.updatedAt || Date.now(),
      revision: nextRevision(existing?.revision)
    },
    Number(item?.order) || 0
  );
  const filePath = path.join(ensureCollectionDir(dataDir, 'notes'), `${note.id}.json`);
  writeJSONFile(filePath, note);
  return note;
}

function moveNoteToTrash(dataDir, id) {
  const note = readNote(dataDir, id);
  if (!note) return false;

  const sourcePath = path.join(ensureCollectionDir(dataDir, 'notes'), `${note.id}.json`);
  const trashDir = ensureTrashDir(dataDir, 'notes');
  const trashPath = makeUniqueFilePath(path.join(trashDir, `${note.id}_${Date.now()}.json`));
  writeJSONFile(trashPath, { ...note, deletedAt: new Date().toISOString() });
  fs.unlinkSync(sourcePath);
  return true;
}

function normalizeProjectSnapshot(project = {}, index = 0) {
  const id = sanitizeEntityId(project.id, 'p');
  const pages = Array.isArray(project.pages) && project.pages.length
    ? project.pages.map(page => String(page ?? ''))
    : [''];
  const rawPageIds = Array.isArray(project.pageIds) ? project.pageIds : [];
  const pageIds = pages.map((_page, pageIndex) => sanitizePageId(rawPageIds[pageIndex] || `pg_${pageIndex + 1}`));
  const updatedAt = Number(project.updatedAt) || Date.now();
  return {
    id,
    title: String(project.title || ''),
    summary: String(project.summary || ''),
    tags: Array.isArray(project.tags)
      ? project.tags.map(tag => String(tag || '').trim()).filter(Boolean)
      : String(project.tag || '').split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean),
    pages,
    pageIds,
    pageRevisions: project.pageRevisions && typeof project.pageRevisions === 'object' ? project.pageRevisions : {},
    createdAt: Number(project.createdAt) || updatedAt,
    updatedAt,
    order: Number.isFinite(Number(project.order)) ? Number(project.order) : index,
    revision: Number(project.revision) || updatedAt
  };
}

function getProjectDir(dataDir, id) {
  return path.join(ensureProjectItemsDir(dataDir), sanitizeEntityId(id, 'p'));
}

function getProjectMetaPath(dataDir, id) {
  return path.join(getProjectDir(dataDir, id), 'project.json');
}

function getProjectPagesDir(dataDir, id) {
  return ensureDir(path.join(getProjectDir(dataDir, id), 'pages'));
}

function getProjectPagePath(dataDir, projectId, pageId) {
  return path.join(getProjectPagesDir(dataDir, projectId), `${sanitizePageId(pageId)}.json`);
}

function readProjectPageFiles(dataDir, projectId) {
  const pagesDir = getProjectPagesDir(dataDir, projectId);
  return fs.readdirSync(pagesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => path.join(pagesDir, entry.name));
}

function readProject(dataDir, id) {
  const metaPath = getProjectMetaPath(dataDir, id);
  const meta = readOptionalJSON(metaPath, null);
  if (!meta || typeof meta !== 'object') return null;

  const pageMap = new Map();
  readProjectPageFiles(dataDir, meta.id || id).forEach(filePath => {
    const page = readOptionalJSON(filePath, null);
    if (!page || typeof page !== 'object') return;
    const pageId = sanitizePageId(page.id || path.basename(filePath, '.json'));
    pageMap.set(pageId, {
      ...page,
      id: pageId,
      content: String(page.content || ''),
      order: Number.isFinite(Number(page.order)) ? Number(page.order) : Number.MAX_SAFE_INTEGER,
      revision: Number(page.revision) || Number(page.updatedAt) || 0
    });
  });

  const orderedIds = Array.isArray(meta.pageOrder)
    ? meta.pageOrder.map(sanitizePageId).filter(Boolean)
    : Array.from(pageMap.values()).sort((a, b) => a.order - b.order).map(page => page.id);
  const pageIds = orderedIds.length ? orderedIds : ['pg_1'];
  const pages = pageIds.map(pageId => pageMap.get(pageId)?.content || '');
  const pageRevisions = {};
  pageIds.forEach(pageId => { pageRevisions[pageId] = pageMap.get(pageId)?.revision || 0; });

  return {
    id: sanitizeEntityId(meta.id || id, 'p'),
    title: String(meta.title || ''),
    summary: String(meta.summary || ''),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    pages,
    pageIds,
    pageRevisions,
    createdAt: Number(meta.createdAt) || Number(meta.updatedAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
    order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : Number.MAX_SAFE_INTEGER,
    revision: Number(meta.revision) || Number(meta.updatedAt) || 0
  };
}

function readProjects(dataDir) {
  return listProjectDirs(dataDir)
    .map(projectDir => readProject(dataDir, path.basename(projectDir)))
    .filter(Boolean)
    .sort((a, b) => {
      const orderDiff = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

function writeProjectSnapshot(dataDir, project, index = 0) {
  const snapshot = normalizeProjectSnapshot(project, index);
  const projectDir = getProjectDir(dataDir, snapshot.id);
  const pagesDir = getProjectPagesDir(dataDir, snapshot.id);
  const pageOrder = snapshot.pageIds;
  const pageRevisions = {};

  snapshot.pages.forEach((content, pageIndex) => {
    const pageId = pageOrder[pageIndex] || sanitizePageId('');
    const existing = readOptionalJSON(path.join(pagesDir, `${pageId}.json`), null);
    const revision = Number(snapshot.pageRevisions?.[pageId]) || nextRevision(existing?.revision);
    pageRevisions[pageId] = revision;
    writeJSONFile(path.join(pagesDir, `${pageId}.json`), {
      id: pageId,
      projectId: snapshot.id,
      content: String(content || ''),
      createdAt: Number(existing?.createdAt) || snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      order: pageIndex,
      revision
    });
  });

  const pageOrderSet = new Set(pageOrder);
  readProjectPageFiles(dataDir, snapshot.id).forEach(filePath => {
    if (pageOrderSet.has(path.basename(filePath, '.json'))) return;
    fs.unlinkSync(filePath);
  });

  writeJSONFile(path.join(projectDir, 'project.json'), {
    id: snapshot.id,
    title: snapshot.title,
    summary: snapshot.summary,
    tags: snapshot.tags,
    pageOrder,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    order: snapshot.order,
    revision: snapshot.revision
  });

  return { ...snapshot, pageRevisions };
}

function saveProjectMeta(dataDir, project, options = {}) {
  const existing = project?.id ? readProject(dataDir, project.id) : null;
  const baseRevision = options.baseRevision;
  if (existing && baseRevision != null && Number(baseRevision) !== Number(existing.revision || 0)) {
    throw new ConflictError('项目信息已在其他设备更新', existing);
  }

  const order = Number.isFinite(Number(project.order))
    ? Number(project.order)
    : Number.isFinite(Number(existing?.order))
      ? Number(existing.order)
      : 0;
  const snapshot = normalizeProjectSnapshot({
    ...existing,
    ...project,
    pages: Array.isArray(project.pages) && project.pages.length ? project.pages : existing?.pages || [''],
    pageIds: Array.isArray(project.pageIds) && project.pageIds.length ? project.pageIds : existing?.pageIds,
    pageRevisions: existing?.pageRevisions || project.pageRevisions || {},
    updatedAt: project.updatedAt || Date.now(),
    revision: nextRevision(existing?.revision)
  }, order);
  const existingPageIds = new Set(existing?.pageIds || []);
  const pageOrder = snapshot.pageIds;
  const pageOrderSet = new Set(pageOrder);

  pageOrder.forEach((pageId, pageIndex) => {
    const pagePath = getProjectPagePath(dataDir, snapshot.id, pageId);
    if (fs.existsSync(pagePath)) return;
    writeJSONFile(pagePath, {
      id: pageId,
      projectId: snapshot.id,
      content: String(snapshot.pages[pageIndex] || ''),
      createdAt: snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
      order: pageIndex,
      revision: nextRevision()
    });
  });

  existingPageIds.forEach(pageId => {
    if (pageOrderSet.has(pageId)) return;
    const pagePath = getProjectPagePath(dataDir, snapshot.id, pageId);
    if (fs.existsSync(pagePath)) fs.unlinkSync(pagePath);
  });

  writeJSONFile(getProjectMetaPath(dataDir, snapshot.id), {
    id: snapshot.id,
    title: snapshot.title,
    summary: snapshot.summary,
    tags: snapshot.tags,
    pageOrder,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    order: snapshot.order,
    revision: snapshot.revision
  });

  return readProject(dataDir, snapshot.id);
}

function saveProjectPage(dataDir, projectId, pageId, content, options = {}) {
  const safeProjectId = sanitizeEntityId(projectId, 'p');
  const meta = readOptionalJSON(getProjectMetaPath(dataDir, safeProjectId), null);
  if (!meta || typeof meta !== 'object') throw new Error('项目不存在');
  const normalizedProjectId = sanitizeEntityId(meta.id || safeProjectId, 'p');
  const safePageId = sanitizePageId(pageId);
  const pagePath = getProjectPagePath(dataDir, normalizedProjectId, safePageId);
  const existing = readOptionalJSON(pagePath, null);
  if (!existing) throw new Error('项目页面不存在');

  const baseRevision = options.baseRevision;
  if (baseRevision != null && Number(baseRevision) !== Number(existing.revision || 0)) {
    throw new ConflictError('项目页面已在其他设备更新', readProject(dataDir, normalizedProjectId));
  }

  const revision = nextRevision(existing.revision);
  writeJSONFile(pagePath, {
    ...existing,
    id: safePageId,
    projectId: normalizedProjectId,
    content: String(content || ''),
    updatedAt: Date.now(),
    revision
  });
  return { pageId: safePageId, revision };
}

function moveProjectToTrash(dataDir, id) {
  const project = readProject(dataDir, id);
  if (!project) return false;

  const trashDir = ensureTrashDir(dataDir, 'projects');
  const trashPath = makeUniqueFilePath(path.join(trashDir, `${project.id}_${Date.now()}.json`));
  writeJSONFile(trashPath, { ...project, deletedAt: new Date().toISOString() });
  fs.rmSync(getProjectDir(dataDir, project.id), { recursive: true, force: true });
  return true;
}

function updateCollectionOrder(dataDir, key, ids = []) {
  const safeIds = Array.isArray(ids) ? ids.map(id => sanitizeEntityId(id, key === 'notes' ? 'n' : 'p')) : [];
  if (key === 'notes') {
    safeIds.forEach((id, index) => {
      const note = readNote(dataDir, id);
      if (!note) return;
      writeJSONFile(path.join(ensureCollectionDir(dataDir, 'notes'), `${id}.json`), { ...note, order: index });
    });
    return;
  }

  safeIds.forEach((id, index) => {
    const metaPath = getProjectMetaPath(dataDir, id);
    const meta = readOptionalJSON(metaPath, null);
    if (!meta) return;
    writeJSONFile(metaPath, { ...meta, order: index });
  });
}

function readCollection(dataDir, key) {
  return key === 'projects' ? readProjects(dataDir) : readNotes(dataDir);
}

function writeCollection(dataDir, key, items) {
  const nextItems = Array.isArray(items) ? items : [];
  if (key === 'projects') {
    const keepIds = new Set();
    nextItems.forEach((item, index) => {
      const project = writeProjectSnapshot(dataDir, item, index);
      keepIds.add(project.id);
    });

    listProjectDirs(dataDir).forEach(projectDir => {
      const projectId = path.basename(projectDir);
      if (keepIds.has(projectId)) return;
      moveProjectToTrash(dataDir, projectId);
    });
    return;
  }

  const dir = ensureCollectionDir(dataDir, key);
  const keepFiles = new Set();

  nextItems.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;

    const id = sanitizeEntityId(item.id, key === 'notes' ? 'n' : 'p');
    const fileName = `${id}.json`;
    const existing = readNote(dataDir, id);
    const nextItem = normalizeNoteItem({
      ...existing,
      ...item,
      id,
      order: index,
      revision: nextRevision(existing?.revision)
    }, index);

    keepFiles.add(fileName);
    writeJSONFile(path.join(dir, fileName), nextItem);
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

function ensureBaseDataLayout(dataDir) {
  ensureDir(dataDir);
  ensureDataFile(dataDir, INFO_FILE, []);
  ensureCollectionDir(dataDir, 'notes');
  ensureCollectionDir(dataDir, 'projects');
  ensureProjectItemsDir(dataDir);
  ensureTrashDir(dataDir);
  ensureDir(path.join(dataDir, FIGURES_DIR));
  ensureDir(path.join(dataDir, BACKUP_DIR));
}

function inspectStorage(dataDir) {
  ensureBaseDataLayout(dataDir);
  const meta = readStorageMeta(dataDir);
  if (Number(meta?.schemaVersion) >= STORAGE_SCHEMA_VERSION) {
    return {
      schemaVersion: Number(meta.schemaVersion),
      needsMigration: false,
      reason: '',
      meta
    };
  }

  const hasLegacyNotesFile = fs.existsSync(path.join(dataDir, LEGACY_COLLECTION_FILES.notes));
  const hasLegacyProjectsFile = fs.existsSync(path.join(dataDir, LEGACY_COLLECTION_FILES.projects));
  const hasNoteFiles = listCollectionFiles(dataDir, 'notes').length > 0;
  const hasLegacyProjectFiles = listLegacyProjectFiles(dataDir).length > 0;
  const hasProjectDirs = listProjectDirs(dataDir).length > 0;
  const needsMigration = hasLegacyNotesFile
    || hasLegacyProjectsFile
    || hasNoteFiles
    || hasLegacyProjectFiles
    || hasProjectDirs;

  return {
    schemaVersion: Number(meta?.schemaVersion) || 1,
    needsMigration,
    reason: needsMigration ? '检测到旧版数据结构，需要升级为按项/按页存储' : '',
    meta
  };
}

function upsertByUpdatedAt(map, item, fallbackPrefix) {
  if (!item || typeof item !== 'object') return;
  const id = sanitizeEntityId(item.id, fallbackPrefix);
  const current = map.get(id);
  const currentUpdatedAt = Number(current?.updatedAt) || 0;
  const nextUpdatedAt = Number(item.updatedAt) || 0;
  if (!current || nextUpdatedAt >= currentUpdatedAt) map.set(id, { ...item, id });
}

function readLegacyNotesForMigration(dataDir) {
  const notes = new Map();
  const legacyFile = path.join(dataDir, LEGACY_COLLECTION_FILES.notes);
  const legacyItems = readOptionalJSON(legacyFile, []);
  if (Array.isArray(legacyItems)) {
    legacyItems.forEach(item => upsertByUpdatedAt(notes, item, 'n'));
  }

  listCollectionFiles(dataDir, 'notes').forEach(filePath => {
    upsertByUpdatedAt(notes, readOptionalJSON(filePath, null), 'n');
  });

  return Array.from(notes.values()).sort((a, b) => {
    const orderDiff = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    if (orderDiff !== 0) return orderDiff;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function readLegacyProjectsForMigration(dataDir) {
  const projects = new Map();
  const legacyFile = path.join(dataDir, LEGACY_COLLECTION_FILES.projects);
  const legacyItems = readOptionalJSON(legacyFile, []);
  if (Array.isArray(legacyItems)) {
    legacyItems.forEach(item => upsertByUpdatedAt(projects, item, 'p'));
  }

  listLegacyProjectFiles(dataDir).forEach(filePath => {
    upsertByUpdatedAt(projects, readOptionalJSON(filePath, null), 'p');
  });

  readProjects(dataDir).forEach(project => upsertByUpdatedAt(projects, project, 'p'));

  return Array.from(projects.values()).sort((a, b) => {
    const orderDiff = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    if (orderDiff !== 0) return orderDiff;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function listBackupSourceFiles(dataDir, backupRoot) {
  const root = path.resolve(dataDir);
  const backupPath = path.resolve(backupRoot);
  const files = [];

  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(dir, entry.name);
      const resolved = path.resolve(fullPath);
      if (resolved === backupPath || resolved.startsWith(`${backupPath}${path.sep}`)) return;
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (entry.isFile()) files.push(fullPath);
    });
  }

  walk(root);
  return files;
}

async function yieldMigrationStep() {
  await new Promise(resolve => setImmediate(resolve));
}

function updateMigrationState(state, progress, message, extra = {}) {
  Object.assign(state, {
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    message,
    ...extra
  });
}

async function createPreMigrationBackup(dataDir, state) {
  const backupRoot = ensureDir(path.join(dataDir, BACKUP_DIR));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = makeUniqueFilePath(path.join(backupRoot, `pre-schema-v2-${stamp}`));
  ensureDir(backupPath);

  const files = listBackupSourceFiles(dataDir, backupRoot);
  if (!files.length) return backupPath;

  for (let index = 0; index < files.length; index += 1) {
    const sourcePath = files[index];
    const relativePath = path.relative(dataDir, sourcePath);
    const targetPath = path.join(backupPath, relativePath);
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
    updateMigrationState(
      state,
      5 + ((index + 1) / files.length) * 35,
      `正在备份数据 ${index + 1}/${files.length}`,
      { backupPath }
    );
    if (index % 10 === 0) await yieldMigrationStep();
  }

  return backupPath;
}

async function runStorageMigration(context) {
  const state = context.storageMigration;
  try {
    state.state = 'running';
    state.error = '';
    updateMigrationState(state, 1, '准备升级数据结构...');

    const backupPath = await createPreMigrationBackup(context.dataDir, state);
    const notes = readLegacyNotesForMigration(context.dataDir);
    const projects = readLegacyProjectsForMigration(context.dataDir);
    const totalItems = Math.max(1, notes.length + projects.length);
    let doneItems = 0;

    for (const [index, note] of notes.entries()) {
      const normalized = normalizeNoteItem(note, index);
      normalized.revision = Number(note.revision) || nextRevision(note.updatedAt);
      writeJSONFile(path.join(ensureCollectionDir(context.dataDir, 'notes'), `${normalized.id}.json`), normalized);
      doneItems += 1;
      updateMigrationState(state, 40 + (doneItems / totalItems) * 50, `正在升级便笺 ${index + 1}/${notes.length}`, { backupPath });
      if (index % 10 === 0) await yieldMigrationStep();
    }

    for (const [index, project] of projects.entries()) {
      writeProjectSnapshot(context.dataDir, project, index);
      doneItems += 1;
      updateMigrationState(state, 40 + (doneItems / totalItems) * 50, `正在升级项目 ${index + 1}/${projects.length}`, { backupPath });
      await yieldMigrationStep();
    }

    updateMigrationState(state, 93, '正在清理旧格式文件...', { backupPath });
    [LEGACY_COLLECTION_FILES.notes, LEGACY_COLLECTION_FILES.projects].forEach(fileName => {
      const filePath = path.join(context.dataDir, fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    listLegacyProjectFiles(context.dataDir).forEach(filePath => fs.unlinkSync(filePath));

    writeStorageMeta(context.dataDir, {
      migratedAt: new Date().toISOString(),
      backupPath
    });

    updateMigrationState(state, 100, '数据结构升级完成', { backupPath });
    state.state = 'complete';
  } catch (error) {
    state.state = 'error';
    state.error = error instanceof Error ? error.message : '数据结构升级失败';
    state.message = state.error;
  }
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
  const status = inspectStorage(dataDir);
  if (!status.needsMigration && !status.meta) {
    writeStorageMeta(dataDir, { initializedAt: new Date().toISOString() });
  }
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
  const files = collectFiles(root, filePath => filePath.endsWith('.json'));

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
  const fallbackPrefix = key === 'notes' ? 'n' : 'p';
  const existingIds = new Set(readCollection(dataDir, key).map(entry => entry.id).filter(Boolean));
  const originalId = sanitizeEntityId(item.id, fallbackPrefix);
  const id = existingIds.has(originalId) ? sanitizeEntityId('', fallbackPrefix) : originalId;
  const restored = { ...item, id, updatedAt: Date.now() };
  if (key === 'projects') {
    writeProjectSnapshot(dataDir, restored, readProjects(dataDir).length);
  } else {
    writeNote(dataDir, restored);
  }
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
  const backupRoot = path.join(root, BACKUP_DIR);
  return collectFiles(root, filePath => {
    const resolved = path.resolve(filePath);
    return resolved !== backupRoot && !resolved.startsWith(`${backupRoot}${path.sep}`);
  }).map(filePath => ({
    path: path.relative(root, filePath).replace(/\\/g, '/'),
    data: fs.readFileSync(filePath).toString('base64')
  }));
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

function mergeCollectionItem(dataDir, key, item) {
  if (!item || typeof item !== 'object') return 0;

  const fallbackPrefix = key === 'notes' ? 'n' : 'p';
  const existingIds = new Set(readCollection(dataDir, key).map(entry => entry.id).filter(Boolean));
  const nextItem = { ...item };
  if (!nextItem.id || existingIds.has(nextItem.id)) nextItem.id = sanitizeEntityId('', fallbackPrefix);

  if (key === 'projects') {
    writeProjectSnapshot(dataDir, nextItem, readProjects(dataDir).length);
    return 1;
  }

  writeNote(dataDir, nextItem);
  return 1;
}

function mergeCollectionFile(dataDir, key, content) {
  return mergeCollectionItem(dataDir, key, JSON.parse(content));
}

function mergeLegacyCollectionFile(dataDir, key, content) {
  const items = JSON.parse(content);
  if (!Array.isArray(items)) return 0;

  return items.reduce((count, item) => count + mergeCollectionItem(dataDir, key, item || {}), 0);
}

function writeImportedFile(dataDir, file) {
  const relativePath = safeRelativePath(file?.path);
  if (!relativePath) return 0;

  const content = Buffer.from(String(file.data || ''), 'base64').toString('utf-8');
  if (relativePath === STORAGE_META_FILE || relativePath.startsWith(`${BACKUP_DIR}/`)) return 0;
  if (relativePath === INFO_FILE) return mergeInfoFile(dataDir, content);
  if (relativePath === 'notes.json') return mergeLegacyCollectionFile(dataDir, 'notes', content);
  if (relativePath === 'projects.json') return mergeLegacyCollectionFile(dataDir, 'projects', content);
  if (relativePath.startsWith('notes/') && relativePath.endsWith('.json')) {
    return mergeCollectionFile(dataDir, 'notes', content);
  }
  if (relativePath.startsWith(`${PROJECT_ITEMS_DIR.replace(/\\/g, '/')}/`) && relativePath.endsWith('.json')) {
    const targetPath = path.join(dataDir, relativePath);
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, Buffer.from(String(file.data || ''), 'base64'));
    return 1;
  }
  if (relativePath.startsWith('projects/') && relativePath.endsWith('.json')) {
    return mergeCollectionFile(dataDir, 'projects', content);
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
    storageMigration: {
      state: 'idle',
      progress: 0,
      message: '',
      backupPath: '',
      error: ''
    },
    onDataDirChange: typeof options.onDataDirChange === 'function' ? options.onDataDirChange : null,
    origin: `http://${host}:${port}`
  };
}

function getStorageStatusPayload(context) {
  if (['running', 'complete', 'error'].includes(context.storageMigration.state)) {
    return {
      ...context.storageMigration,
      needsMigration: context.storageMigration.state === 'running' || context.storageMigration.state === 'error',
      schemaVersion: STORAGE_SCHEMA_VERSION
    };
  }

  const status = inspectStorage(context.dataDir);
  return {
    state: status.needsMigration ? 'needed' : 'ready',
    progress: status.needsMigration ? 0 : 100,
    message: status.reason || '数据结构已是最新版本',
    needsMigration: status.needsMigration,
    schemaVersion: status.schemaVersion,
    backupPath: '',
    error: ''
  };
}

function ensureStorageReady(context, res) {
  const status = getStorageStatusPayload(context);
  if (status.state === 'running' || status.state === 'needed') {
    sendJSON(res, 423, { error: '数据结构正在升级，请稍候', status });
    return false;
  }
  return true;
}

function sendConflict(res, error) {
  sendJSON(res, 409, {
    error: error.message || '数据已在其他设备更新',
    current: error.current || null
  });
}

function handleJsonPost(req, res, handler, fallbackMessage = '保存失败') {
  readRequestBody(req).then(body => {
    try {
      handler(body);
      sendJSON(res, 200, { ok: true });
    } catch (error) {
      sendJSON(res, 500, { error: error instanceof Error ? error.message : fallbackMessage });
    }
  }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
}

function resolveMaxTokens(maxTokens) {
  const value = Number(maxTokens);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_AI_MAX_TOKENS;
  return Math.floor(value);
}

function buildAIRequestPayload({ isAnthropic, model, prompt, maxTokens }) {
  const tokenLimit = resolveMaxTokens(maxTokens);
  if (isAnthropic) {
    return {
      model,
      max_tokens: tokenLimit,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    };
  }

  return {
    model,
    max_tokens: tokenLimit,
    messages: [{ role: 'user', content: prompt }]
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

    if (pathname === '/api/storage-status' && req.method === 'GET') {
      sendJSON(res, 200, getStorageStatusPayload(context));
      return;
    }

    if (pathname === '/api/storage-migrate' && req.method === 'POST') {
      const status = inspectStorage(context.dataDir);
      if (!status.needsMigration) {
        context.storageMigration = {
          state: 'complete',
          progress: 100,
          message: '数据结构已是最新版本',
          backupPath: '',
          error: ''
        };
        sendJSON(res, 200, getStorageStatusPayload(context));
        return;
      }

      if (context.storageMigration.state !== 'running') {
        context.storageMigration = {
          state: 'running',
          progress: 0,
          message: '准备升级数据结构...',
          backupPath: '',
          error: ''
        };
        setImmediate(() => runStorageMigration(context));
      }

      sendJSON(res, 202, getStorageStatusPayload(context));
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

          if (!ensureStorageReady(context, res)) return;
          initializeData(previousDir);
          mergeDataDirs(previousDir, targetDir);
          initializeData(targetDir);
          context.dataDir = targetDir;
          context.storageMigration = {
            state: 'idle',
            progress: 0,
            message: '',
            backupPath: '',
            error: ''
          };
          await context.onDataDirChange?.(targetDir);
          sendJSON(res, 200, { ok: true, dataDir: targetDir });
        } catch (error) {
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '迁移数据失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (pathname === '/api/export-data' && req.method === 'POST') {
      if (!ensureStorageReady(context, res)) return;
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
      if (!ensureStorageReady(context, res)) return;
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

    if (!pathname.startsWith('/api/storage-') && pathname.startsWith('/api/') && !ensureStorageReady(context, res)) return;

    if (pathname === '/api/notes' && req.method === 'GET') {
      sendJSON(res, 200, readCollection(context.dataDir, 'notes'));
      return;
    }

    if (pathname === '/api/notes' && req.method === 'POST') {
      handleJsonPost(req, res, body => writeCollection(context.dataDir, 'notes', body));
      return;
    }

    if (pathname === '/api/notes/order' && req.method === 'POST') {
      handleJsonPost(req, res, body => updateCollectionOrder(context.dataDir, 'notes', body?.ids));
      return;
    }

    const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch && req.method === 'PUT') {
      readRequestBody(req).then(body => {
        try {
          const id = decodeURIComponent(noteMatch[1]);
          const item = { ...(body?.item || body || {}), id };
          const note = writeNote(context.dataDir, item, { baseRevision: body?.baseRevision });
          sendJSON(res, 200, { ok: true, item: note });
        } catch (error) {
          if (error instanceof ConflictError) {
            sendConflict(res, error);
            return;
          }
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '保存失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (noteMatch && req.method === 'DELETE') {
      try {
        moveNoteToTrash(context.dataDir, decodeURIComponent(noteMatch[1]));
        sendJSON(res, 200, { ok: true });
      } catch (error) {
        sendJSON(res, 500, { error: error instanceof Error ? error.message : '删除失败' });
      }
      return;
    }

    if (pathname === '/api/info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readJSON(context.dataDir, INFO_FILE, [])));
      return;
    }

    if (pathname === '/api/info' && req.method === 'POST') {
      handleJsonPost(req, res, body => writeJSON(context.dataDir, INFO_FILE, body));
      return;
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readCollection(context.dataDir, 'projects')));
      return;
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      handleJsonPost(req, res, body => writeCollection(context.dataDir, 'projects', body));
      return;
    }

    if (pathname === '/api/projects/order' && req.method === 'POST') {
      handleJsonPost(req, res, body => updateCollectionOrder(context.dataDir, 'projects', body?.ids));
      return;
    }

    const projectPageMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/);
    if (projectPageMatch && req.method === 'PUT') {
      readRequestBody(req).then(body => {
        try {
          const result = saveProjectPage(
            context.dataDir,
            decodeURIComponent(projectPageMatch[1]),
            decodeURIComponent(projectPageMatch[2]),
            body?.content,
            { baseRevision: body?.baseRevision }
          );
          sendJSON(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof ConflictError) {
            sendConflict(res, error);
            return;
          }
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '保存失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'PUT') {
      readRequestBody(req).then(body => {
        try {
          const id = decodeURIComponent(projectMatch[1]);
          const item = { ...(body?.item || body || {}), id };
          const project = saveProjectMeta(context.dataDir, item, { baseRevision: body?.baseRevision });
          sendJSON(res, 200, { ok: true, item: project });
        } catch (error) {
          if (error instanceof ConflictError) {
            sendConflict(res, error);
            return;
          }
          sendJSON(res, 500, { error: error instanceof Error ? error.message : '保存失败' });
        }
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
      return;
    }

    if (projectMatch && req.method === 'DELETE') {
      try {
        moveProjectToTrash(context.dataDir, decodeURIComponent(projectMatch[1]));
        sendJSON(res, 200, { ok: true });
      } catch (error) {
        sendJSON(res, 500, { error: error instanceof Error ? error.message : '删除失败' });
      }
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

    if (pathname === '/api/ai/complete' && req.method === 'POST') {
      readRequestBody(req).then(body => {
        const { protocol, baseUrl, apiKey, model, prompt, maxTokens } = body || {};
        if (!apiKey || !baseUrl || !model || !prompt) {
          sendJSON(res, 400, { error: '缺少必要参数' });
          return;
        }

        const trimmedBase = baseUrl.replace(/\/+$/, '');
        const isAnthropic = protocol === 'anthropic';
        const baseWithoutV1 = trimmedBase.replace(/\/v1$/, '');
        const endpoint = isAnthropic
          ? `${baseWithoutV1}/v1/messages`
          : `${baseWithoutV1}/v1/chat/completions`;

        const headers = {
          'Content-Type': 'application/json',
          ...(isAnthropic
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { 'Authorization': `Bearer ${apiKey}` })
        };

        const payload = buildAIRequestPayload({ isAnthropic, model, prompt, maxTokens });

        const url = new URL(endpoint);
        const requester = url.protocol === 'https:' ? https : http;

        const apiReq = requester.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
          timeout: AI_REQUEST_TIMEOUT_MS
        }, apiRes => {
          let data = '';
          apiRes.setEncoding('utf-8');
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
                sendJSON(res, apiRes.statusCode, { error: json.error?.message || 'AI 请求失败' });
                return;
              }
              const choice = json.choices?.[0]?.message;
              const text = isAnthropic
                ? (json.content?.[0]?.text || '')
                : (choice?.content || '');
              sendJSON(res, 200, { text: text || '' });
            } catch {
              sendJSON(res, 502, { error: 'AI 返回内容无法解析' });
            }
          });
        });

        apiReq.on('error', err => {
          sendJSON(res, 502, { error: err.message || 'AI 请求失败' });
        });
        apiReq.on('timeout', () => {
          apiReq.destroy(new Error('AI 请求超时'));
        });
        apiReq.write(JSON.stringify(payload));
        apiReq.end();
      }).catch(() => sendJSON(res, 400, { error: 'Invalid JSON' }));
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
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(figurePath).toLowerCase()] || 'application/octet-stream' });
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

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
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
