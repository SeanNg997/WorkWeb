'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('../server');

const rootDir = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-note-electron-'));
app.setPath('userData', userDataDir);
app.disableHardwareAcceleration();

const desktopMainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.js'), 'utf8');
const allowedDesktopSettings = new Set(
  [...(desktopMainSource.match(/const ALLOWED_DESKTOP_SETTING_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '')
    .matchAll(/'([^']+)'/g)].map(([, key]) => key)
);
const desktopSettingsPath = path.join(userDataDir, 'desktop-settings.json');
const readDesktopSettings = () => {
  try { return JSON.parse(fs.readFileSync(desktopSettingsPath, 'utf8')); } catch { return {}; }
};
ipcMain.handle('workweb:getSetting', (_event, key) => allowedDesktopSettings.has(key) ? readDesktopSettings()[key] : undefined);
ipcMain.handle('workweb:setSetting', (_event, key, value) => {
  if (!allowedDesktopSettings.has(key)) return undefined;
  fs.writeFileSync(desktopSettingsPath, JSON.stringify({ ...readDesktopSettings(), [key]: value }));
  return value;
});
ipcMain.handle('workweb:setWindowTheme', () => true);
ipcMain.handle('workweb:isWindowMaximized', () => false);
ipcMain.handle('workweb:checkLatestVersion', () => ({ hasUpdate: false }));
ipcMain.handle('workweb:getUpdateState', () => ({ status: 'idle' }));

async function startServer(dataDir) {
  const instance = createServer({ dataDir, host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', resolve);
  });
  return { server: instance.server, origin: `http://127.0.0.1:${instance.server.address().port}` };
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function api(origin, route, options = {}) {
  const response = await fetch(`${origin}/api/${route}`, {
    method: options.method || 'GET',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${options.method || 'GET'} ${route}: ${body.error || response.status}`);
  return body;
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await check();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`Timed out: ${message}`);
}

async function evaluate(window, script) {
  return window.webContents.executeJavaScript(script);
}

async function seedNote(origin, id, title, order) {
  const now = Date.now() + order;
  return api(origin, `notes/${id}`, {
    method: 'PUT',
    body: {
      item: { id, title, content: `<p>${title}</p>`, span: 1, createdAt: now, updatedAt: now, order },
      baseRevision: null,
      baseToken: null
    }
  });
}

async function createConflictFixture(origin, dataDir, id, title, replicaTitle, order, localDrafts = []) {
  const seeded = await seedNote(origin, id, title, order);
  const notesDir = path.join(dataDir, 'notes');
  const canonicalPath = path.join(notesDir, `${id}.json`);
  const replicaPath = path.join(notesDir, `${id}-replica.json`);
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  fs.writeFileSync(replicaPath, JSON.stringify({
    ...canonical,
    title: replicaTitle,
    content: `<p>${replicaTitle}</p>`,
    revision: Number(canonical.revision || 0) + 1,
    updatedAt: Number(canonical.updatedAt || Date.now()) + 1
  }));
  let current = (await api(origin, 'notes')).find(note => note.id === id);
  const drafts = [];
  for (const draft of localDrafts) {
    const saved = await api(origin, `notes/${id}/draft`, {
      method: 'POST',
      body: {
        item: { id, title: draft.title, content: draft.content, span: 1, order },
        baseRevision: current.revision,
        baseToken: current.syncToken
      }
    });
    current = (await api(origin, 'notes')).find(note => note.id === id);
    drafts.push(current.syncConflict?.localDrafts?.find(draft => draft.draftId === saved.draft.draftId) || saved.draft);
  }
  return { seeded: seeded.item, canonicalPath, replicaPath, state: current, drafts };
}

async function openConflictDialog(window, id) {
  await evaluate(window, `(() => {
    const badge = document.querySelector('.note-card[data-id="${id}"] .note-save-status');
    if (!badge || badge.disabled) throw new Error('missing active conflict badge: ${id}');
    badge.click();
  })()`);
  await waitFor(async () => evaluate(window, "document.getElementById('noteConflictDialog').open"), `dialog ${id} open`);
  const layout = await evaluate(window, `(() => {
    const dialog = document.getElementById('noteConflictDialog');
    const rect = dialog.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    return { open: dialog.open, x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, display: style.display, visibility: style.visibility, opacity: style.opacity, margin: style.margin };
  })()`);
  if (id === 'n_resolve_copy') {
    assert.equal(layout.open, true);
    assert.ok(layout.width > 0 && layout.height > 0);
    assert.ok(layout.x >= 0 && layout.y >= 0);
    assert.ok(layout.x + layout.width <= layout.viewportWidth + 1);
    assert.ok(layout.y + layout.height <= layout.viewportHeight + 1);
    assert.ok(Math.abs(layout.x + layout.width / 2 - layout.viewportWidth / 2) < 2);
    assert.ok(Math.abs(layout.y + layout.height / 2 - layout.viewportHeight / 2) < 2);
  }
}

async function chooseNoteConflictOption(window, selectId, value) {
  await evaluate(window, `(() => {
    const select = document.getElementById(${JSON.stringify(selectId)});
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function clickConflictAction(window, buttonId) {
  await evaluate(window, `document.getElementById(${JSON.stringify(buttonId)}).click()`);
}

async function waitForConflictDialogClosed(window) {
  try {
    await waitFor(async () => evaluate(window, "!document.getElementById('noteConflictDialog').open"), 'conflict dialog close');
  } catch (error) {
    const diagnostic = await evaluate(window, `(() => {
      const lastResolve = [...(window.__noteSyncTest?.operations || [])].reverse()
        .find(operation => operation.path?.endsWith('/resolve')) || null;
      return {
        status: document.getElementById('noteConflictStatus')?.textContent || '',
        lastResolve
      };
    })()`);
    console.error('CONFLICT_DIALOG_CLOSE_DIAGNOSTIC ' + JSON.stringify(diagnostic));
    throw error;
  }
}

async function inputTitle(window, id, title) {
  await evaluate(window, `(() => {
    const input = document.querySelector('.note-card[data-id="${id}"] .note-title-input');
    if (!input) throw new Error('missing note title input: ${id}');
    input.value = ${JSON.stringify(title)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function confirmDelete(window, id) {
  await evaluate(window, `(() => {
    askDeleteNote(${JSON.stringify(id)});
    const confirm = document.querySelector('#confirmOverlay .btn-danger-solid');
    if (!confirm) throw new Error('missing delete confirmation');
    confirm.click();
  })()`);
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-note-data-'));
  let httpServer;
  let window;
  let origin;
  try {
    ({ server: httpServer, origin } = await startServer(dataDir));
    await api(origin, 'storage-migrate', { method: 'POST' });
    await waitFor(async () => {
      const status = await api(origin, 'storage-status');
      return status.state === 'complete' || status.state === 'ready';
    }, 'storage migration');

    const notes = [
      ['n_queue', 'Queue', 0],
      ['n_conflict', 'Conflict', 1],
      ['n_success_conflict', 'Success conflict', 2],
      ['n_startup_conflict', 'Startup conflict', 3],
      ['n_delete_fail', 'Delete failure', 4],
      ['n_delete_wait', 'Delete wait', 5]
    ];
    const seeded = new Map();
    for (const [id, title, order] of notes) seeded.set(id, await seedNote(origin, id, title, order));

    const diskFixture = await createConflictFixture(origin, dataDir, 'n_resolve_disk', 'Disk canonical', 'Disk replica', 6);
    const localFixture = await createConflictFixture(origin, dataDir, 'n_resolve_local', 'Local canonical', 'Local replica', 7, [
      { title: 'Local choice one', content: '<p>Local choice one body</p>' },
      { title: 'Local choice two', content: '<p>Local choice two body</p>' }
    ]);
    const copyFixture = await createConflictFixture(origin, dataDir, 'n_resolve_copy', 'Copy canonical', 'Copy replica', 8, [
      { title: 'Copy local', content: '<p>Copy local body</p>' }
    ]);
    const cancelFixture = await createConflictFixture(origin, dataDir, 'n_resolve_cancel', 'Cancel canonical', 'Cancel replica', 9, [
      { title: 'Cancel local', content: '<p>Cancel local body</p>' }
    ]);
    const staleFixture = await createConflictFixture(origin, dataDir, 'n_resolve_stale', 'Stale canonical', 'Stale replica', 10, [
      { title: 'Stale local', content: '<p>Stale local body</p>' }
    ]);
    const restartFixture = await createConflictFixture(origin, dataDir, 'n_restart_local', 'Restart canonical', 'Restart replica', 11, [
      { title: 'Restart actual local', content: '<p>Restart actual local body</p>' }
    ]);
    for (const [id, fixture, order] of [
      ['n_resolve_disk', diskFixture, 6], ['n_resolve_local', localFixture, 7],
      ['n_resolve_copy', copyFixture, 8], ['n_resolve_cancel', cancelFixture, 9],
      ['n_resolve_stale', staleFixture, 10], ['n_restart_local', restartFixture, 11]
    ]) {
      seeded.set(id, { item: fixture.seeded });
      notes.push([id, fixture.seeded.title, order]);
    }

    const deletedFixture = await seedNote(origin, 'n_deleted_ui', 'Deleted UI note', 12);
    seeded.set('n_deleted_ui', deletedFixture);
    const deletedResponse = await fetch(`${origin}/api/notes/${deletedFixture.item.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: deletedFixture.item,
        baseRevision: deletedFixture.item.revision,
        baseToken: deletedFixture.item.syncToken
      })
    });
    assert.equal(deletedResponse.status, 200);
    const staleWriteResponse = await fetch(`${origin}/api/notes/${deletedFixture.item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: { ...deletedFixture.item, title: 'Deleted local preview', content: '<p>Deleted local preview</p>' },
        baseRevision: deletedFixture.item.revision,
        baseToken: deletedFixture.item.syncToken
      })
    });
    const staleWriteBody = await staleWriteResponse.json();
    assert.equal(staleWriteResponse.status, 409);
    assert.ok(staleWriteBody.draft?.draftId);
    notes.push(['n_deleted_ui', 'Deleted UI note', 12]);

    const startup = seeded.get('n_startup_conflict').item;
    await api(origin, `notes/${startup.id}/draft`, {
      method: 'POST',
      body: {
        item: { ...startup, title: 'Startup local draft' },
        baseRevision: startup.revision,
        baseToken: startup.syncToken
      }
    });

    window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 850,
      webPreferences: {
        backgroundThrottling: false,
        offscreen: true,
        preload: path.join(rootDir, 'electron', 'preload.js')
      }
    });
    await window.loadURL(origin);
    await waitFor(async () => evaluate(window,
      `document.querySelectorAll('#notesGrid .note-card').length === ${notes.length}`
    ), 'notes render');

    await evaluate(window, `(() => {
      const state = {
        operations: [],
        holdNext: new Set(),
        release: {},
        active: {},
        maxInFlight: {},
        failDraftNext: new Set(),
        failDeleteNext: new Set(),
        successConflictNext: new Set()
      };
      const nativeFetch = window.fetch.bind(window);
      window.__noteSyncTest = state;
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const match = url.pathname.match(/^\\/api\\/notes\\/([^/]+)(\\/(?:draft|resolve))?$/);
        if (!match) return nativeFetch(input, init);
        const id = decodeURIComponent(match[1]);
        const method = String(init.method || 'GET').toUpperCase();
        const body = init.body ? JSON.parse(init.body) : undefined;
        const op = { method, id, path: url.pathname, body, startedAt: Date.now() };
        state.operations.push(op);
        if (method === 'POST' && match[2] === '/draft' && state.failDraftNext.delete(id)) {
          op.status = 500;
          return new Response(JSON.stringify({ error: 'simulated draft failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'DELETE' && state.failDeleteNext.delete(id)) {
          op.status = 500;
          return new Response(JSON.stringify({ error: 'simulated delete failure' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'PUT') {
          state.active[id] = (state.active[id] || 0) + 1;
          state.maxInFlight[id] = Math.max(state.maxInFlight[id] || 0, state.active[id]);
          try {
            if (state.holdNext.delete(id)) await new Promise(resolve => { state.release[id] = resolve; });
            if (state.successConflictNext.delete(id)) {
              op.status = 200;
              return new Response(JSON.stringify({
                ok: true,
                item: {
                  id,
                  revision: Number(body?.baseRevision || 1) + 1,
                  syncToken: 'mock-token-' + id,
                  syncConflict: { token: 'mock-conflict-' + id, deleted: false, missing: false, variants: [], localDrafts: [] }
                }
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            const response = await nativeFetch(input, init);
            op.status = response.status;
            op.response = await response.clone().json().catch(() => ({}));
            return response;
          } finally {
            state.active[id] -= 1;
          }
        }
        const response = await nativeFetch(input, init);
        op.status = response.status;
        op.response = await response.clone().json().catch(() => ({}));
        return response;
      };
    })()`);

    const countOps = (method, id) => evaluate(window,
      `window.__noteSyncTest.operations.filter(op => op.method === ${JSON.stringify(method)} && op.id === ${JSON.stringify(id)}).length`
    );
    const ops = id => evaluate(window,
      `window.__noteSyncTest.operations.filter(op => op.id === ${JSON.stringify(id)})`
    );

    await evaluate(window, "window.__noteSyncTest.holdNext.add('n_queue')");
    await inputTitle(window, 'n_queue', 'Queue first');
    await waitFor(async () => (await countOps('PUT', 'n_queue')) === 1, 'first queue PUT');
    await waitFor(async () => evaluate(window, "!!window.__noteSyncTest.release.n_queue"), 'held queue PUT');
    await inputTitle(window, 'n_queue', 'Queue latest');
    await wait(380);
    assert.equal(await countOps('PUT', 'n_queue'), 1, 'later input must reuse the single in-flight PUT');
    assert.equal(await evaluate(window, "window.__noteSyncTest.maxInFlight.n_queue"), 1);
    await evaluate(window, 'window.__noteSyncTest.release.n_queue(); delete window.__noteSyncTest.release.n_queue');
    await waitFor(async () => (await countOps('PUT', 'n_queue')) === 2, 'queued latest PUT');
    await waitFor(async () => (await api(origin, 'notes')).find(note => note.id === 'n_queue')?.title === 'Queue latest', 'latest queue title on disk');
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_queue\"] .note-title-input').value"
    ), 'Queue latest', 'an older response must not restore stale title data');
    const queueOps = await ops('n_queue');
    assert.equal(queueOps[1].body.baseRevision, queueOps[0].response.item.revision);
    assert.equal(queueOps[1].body.baseToken, queueOps[0].response.item.syncToken);
    console.log('PASS per-note queue serializes writes and saves latest input');

    const beforeBlur = await countOps('PUT', 'n_queue');
    await evaluate(window, `(() => {
      const input = document.querySelector('.note-card[data-id="n_queue"] .note-title-input');
      input.focus();
      input.blur();
    })()`);
    await wait(450);
    assert.equal(await countOps('PUT', 'n_queue'), beforeBlur, 'unchanged blur must not PUT');
    console.log('PASS unchanged blur skips PUT');

    await evaluate(window, "window.__noteSyncTest.holdNext.add('n_conflict'); window.__noteSyncTest.failDraftNext.add('n_conflict')");
    await inputTitle(window, 'n_conflict', 'Conflict request snapshot');
    await waitFor(async () => (await countOps('PUT', 'n_conflict')) === 1, 'conflicting PUT start');
    await waitFor(async () => evaluate(window, "!!window.__noteSyncTest.release.n_conflict"), 'held conflicting PUT');
    const conflictBase = seeded.get('n_conflict').item;
    const remote = await api(origin, `notes/${conflictBase.id}`, {
      method: 'PUT',
      body: {
        item: { ...conflictBase, title: 'Remote update', content: '<p>Remote update</p>' },
        baseRevision: conflictBase.revision,
        baseToken: conflictBase.syncToken
      }
    });
    await inputTitle(window, 'n_conflict', 'Latest local after conflict');
    await wait(380);
    await evaluate(window, 'window.__noteSyncTest.release.n_conflict(); delete window.__noteSyncTest.release.n_conflict');
    await waitFor(async () => (await ops('n_conflict')).some(op => op.method === 'POST' && op.path.endsWith('/draft') && op.status === 500), 'draft protection failure');
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_conflict\"] .note-title-input').disabled"
    ), true);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_conflict\"] .note-content-editor-host').inert"
    ), true);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_conflict\"] .note-save-status').textContent"
    ), '重试草稿保护');
    await evaluate(window, "document.querySelector('.note-card[data-id=\"n_conflict\"] .note-save-status').click()");
    await waitFor(async () => evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_conflict\"] .note-save-status').textContent === '待处理冲突'"
    ), 'durable conflict draft retry');
    const conflictOps = await ops('n_conflict');
    const conflictedPut = conflictOps.find(op => op.method === 'PUT' && op.status === 409);
    const protectedDraft = conflictOps.find(op => op.method === 'POST' && op.path.endsWith('/draft') && op.status === 200);
    assert.ok(conflictedPut?.response?.draft?.draftId);
    assert.equal(protectedDraft.body.item.title, 'Latest local after conflict');
    assert.equal(protectedDraft.body.supersedesDraftId, conflictedPut.response.draft.draftId);
    const conflictRecord = (await api(origin, 'notes')).find(note => note.id === 'n_conflict');
    assert.deepEqual(conflictRecord.syncConflict.localDrafts.map(draft => draft.item.title), ['Latest local after conflict']);
    assert.equal((await api(origin, 'notes')).find(note => note.id === 'n_conflict').title, 'Remote update');
    await evaluate(window, 'closeNoteConflictDialog()');
    await waitForConflictDialogClosed(window);
    console.log('PASS conflict protects latest scene, freezes editor, and retries failed protection');

    await evaluate(window, "window.__noteSyncTest.successConflictNext.add('n_success_conflict')");
    await inputTitle(window, 'n_success_conflict', 'Successful response conflict scene');
    await waitFor(async () => evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_success_conflict\"] .note-save-status').textContent === '待处理冲突'"
    ), '200 syncConflict protection');
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_success_conflict\"] .note-title-input').disabled"
    ), true);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_success_conflict\"] .note-content-editor-host').inert"
    ), true);
    const successfulConflictDraft = (await ops('n_success_conflict')).find(op => op.method === 'POST' && op.path.endsWith('/draft'));
    assert.equal(successfulConflictDraft.body.item.title, 'Successful response conflict scene');
    assert.equal(Object.hasOwn(successfulConflictDraft.body, 'supersedesDraftId'), false);
    console.log('PASS 200 syncConflict protects scene and freezes editor');

    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_startup_conflict\"] .note-title-input').disabled"
    ), true);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_startup_conflict\"] .note-content-editor-host').inert"
    ), true);
    await evaluate(window, "persistNote('n_startup_conflict').catch(() => {})");
    assert.equal(await countOps('PUT', 'n_startup_conflict'), 0);
    console.log('PASS startup conflict remains frozen');

    await evaluate(window, "window.__noteSyncTest.failDeleteNext.add('n_delete_fail')");
    await confirmDelete(window, 'n_delete_fail');
    await waitFor(async () => (await countOps('DELETE', 'n_delete_fail')) === 1, 'failed DELETE');
    await waitFor(async () => evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_delete_fail\"] .note-save-status').textContent === '删除失败，便笺已保留'"
    ), 'delete failure status');
    assert.equal(await evaluate(window,
      "!!document.querySelector('.note-card[data-id=\"n_delete_fail\"]')"
    ), true);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_delete_fail\"] .note-title-input').disabled"
    ), false);
    const failedDelete = (await ops('n_delete_fail')).find(op => op.method === 'DELETE');
    assert.equal(failedDelete.body.baseRevision, seeded.get('n_delete_fail').item.revision);
    assert.equal(failedDelete.body.baseToken, seeded.get('n_delete_fail').item.syncToken);
    assert.equal(failedDelete.body.item.id, 'n_delete_fail');
    console.log('PASS failed DELETE keeps note visible and unlocks it');

    await evaluate(window, "window.__noteSyncTest.holdNext.add('n_delete_wait')");
    await inputTitle(window, 'n_delete_wait', 'Delete request snapshot');
    await waitFor(async () => (await countOps('PUT', 'n_delete_wait')) === 1, 'delete wait PUT start');
    await waitFor(async () => evaluate(window, "!!window.__noteSyncTest.release.n_delete_wait"), 'held delete wait PUT');
    await inputTitle(window, 'n_delete_wait', 'Latest before delete');
    await wait(380);
    await confirmDelete(window, 'n_delete_wait');
    assert.equal(await countOps('DELETE', 'n_delete_wait'), 0, 'DELETE must wait for the in-flight flush');
    await evaluate(window, 'window.__noteSyncTest.release.n_delete_wait(); delete window.__noteSyncTest.release.n_delete_wait');
    await waitFor(async () => (await countOps('DELETE', 'n_delete_wait')) === 1, 'DELETE after flush');
    await waitFor(async () => !(await api(origin, 'notes')).some(note => note.id === 'n_delete_wait'), 'deleted note absent from server');
    const deleteWaitOps = await ops('n_delete_wait');
    const deleteIndex = deleteWaitOps.findIndex(op => op.method === 'DELETE');
    assert.deepEqual(deleteWaitOps.filter(op => op.method === 'PUT').map(op => op.body.item.title), [
      'Delete request snapshot', 'Latest before delete'
    ]);
    assert.equal(deleteWaitOps[deleteIndex - 1].method, 'PUT', 'latest PUT must finish immediately before DELETE');
    assert.equal(deleteWaitOps[deleteIndex].body.item.title, 'Latest before delete');
    await wait(450);
    assert.equal(await countOps('PUT', 'n_delete_wait'), 2, 'late autosave must not recreate a deleted note');
    assert.equal(await evaluate(window,
      "!!document.querySelector('.note-card[data-id=\"n_delete_wait\"]')"
    ), false);
    console.log('PASS DELETE waits for the latest save and cannot resurrect the note');

    await openConflictDialog(window, 'n_resolve_cancel');
    await evaluate(window, 'closeNoteConflictDialog()');
    await waitForConflictDialogClosed(window);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_resolve_cancel\"] .note-title-input').disabled"
    ), true);
    assert.ok((await api(origin, 'notes')).find(note => note.id === 'n_resolve_cancel').syncConflict);
    console.log('PASS cancel closes dialog and leaves conflict pending');

    const diskVariant = diskFixture.state.syncConflict.variants.find(variant => variant.file === 'n_resolve_disk.json');
    assert.ok(diskVariant?.key);
    await openConflictDialog(window, 'n_resolve_disk');
    await chooseNoteConflictOption(window, 'noteConflictDiskSelect', diskVariant.key);
    assert.equal(await evaluate(window, "document.getElementById('noteConflictDiskTitle').value"), 'Disk canonical');
    await clickConflictAction(window, 'noteConflictChooseDisk');
    await waitForConflictDialogClosed(window);
    let resolvedNotes = await api(origin, 'notes');
    let diskResolved = resolvedNotes.find(note => note.id === 'n_resolve_disk');
    assert.equal(diskResolved.title, 'Disk canonical');
    assert.equal(diskResolved.syncConflict, undefined);
    assert.equal(await countOps('POST', 'n_resolve_disk'), 1);
    console.log('PASS disk selection resolves only the requested note');

    const selectedLocalDraft = localFixture.drafts[0];
    const remainingLocalDraft = localFixture.drafts[1];
    await openConflictDialog(window, 'n_resolve_local');
    await chooseNoteConflictOption(window, 'noteConflictLocalSelect', selectedLocalDraft.draftId);
    assert.equal(await evaluate(window, "document.getElementById('noteConflictLocalBody').value"), selectedLocalDraft.item.content);
    await clickConflictAction(window, 'noteConflictChooseLocal');
    await waitForConflictDialogClosed(window);
    resolvedNotes = await api(origin, 'notes');
    const localResolved = resolvedNotes.find(note => note.id === 'n_resolve_local');
    assert.equal(localResolved.title, 'Local choice one');
    assert.equal(localResolved.content, '<p>Local choice one body</p>');
    assert.deepEqual(localResolved.syncConflict.localDrafts.map(draft => draft.draftId), [remainingLocalDraft.draftId]);
    assert.equal(await evaluate(window,
      "document.querySelector('.note-card[data-id=\"n_resolve_local\"] .note-title-input').disabled"
    ), true);
    console.log('PASS local selection uses draft content and leaves other drafts pending');

    const copyDraft = copyFixture.drafts[0];
    const copyDiskVariant = copyFixture.state.syncConflict.variants.find(variant => variant.file === 'n_resolve_copy.json');
    await openConflictDialog(window, 'n_resolve_copy');
    await chooseNoteConflictOption(window, 'noteConflictDiskSelect', copyDiskVariant.key);
    await chooseNoteConflictOption(window, 'noteConflictLocalSelect', copyDraft.draftId);
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await wait(3200);
    const conflictPreviewPath = path.join(rootDir, 'temp', 'note-conflict-preview.png');
    fs.mkdirSync(path.dirname(conflictPreviewPath), { recursive: true });
    fs.writeFileSync(conflictPreviewPath, (await window.webContents.capturePage()).toPNG());
    console.log(`SCREENSHOT ${conflictPreviewPath}`);
    await clickConflictAction(window, 'noteConflictChooseCopy');
    await waitForConflictDialogClosed(window);
    resolvedNotes = await api(origin, 'notes');
    const copyOriginal = resolvedNotes.find(note => note.id === 'n_resolve_copy');
    const copiedNote = resolvedNotes.find(note => note.title === 'Copy local');
    assert.equal(copyOriginal.title, 'Copy canonical');
    assert.ok(copiedNote?.id && copiedNote.id !== 'n_resolve_copy');
    assert.equal(copiedNote.content, '<p>Copy local body</p>');
    assert.equal(await evaluate(window,
      `!!document.querySelector('.note-card[data-id="${copiedNote.id}"]')`
    ), true);
    console.log('PASS copy selection preserves disk item and adds a new note ID');

    await openConflictDialog(window, 'n_resolve_stale');
    const staleDiskBefore = JSON.parse(fs.readFileSync(staleFixture.canonicalPath, 'utf8'));
    fs.writeFileSync(staleFixture.canonicalPath, JSON.stringify({
      ...staleDiskBefore,
      title: 'External disk change',
      content: '<p>External disk change</p>',
      revision: Number(staleDiskBefore.revision || 0) + 10,
      updatedAt: Number(staleDiskBefore.updatedAt || Date.now()) + 10
    }));
    await clickConflictAction(window, 'noteConflictChooseDisk');
    await waitFor(async () => (await countOps('POST', 'n_resolve_stale')) === 1, 'stale resolve request');
    await waitFor(async () => evaluate(window,
      "document.getElementById('noteConflictStatus').textContent.includes('冲突状态已变化')"
    ), 'stale resolve refresh notice');
    const staleResolveOp = (await ops('n_resolve_stale')).find(op => op.method === 'POST' && op.path.endsWith('/resolve'));
    assert.equal(staleResolveOp.status, 409);
    assert.equal(await countOps('POST', 'n_resolve_stale'), 1, '409 must not retry automatically');
    const refreshedDiskOptions = await evaluate(window,
      "Array.from(document.getElementById('noteConflictDiskSelect').options).map(option => option.textContent).join('|')"
    );
    assert.match(refreshedDiskOptions, /External disk change/);
    assert.equal((await api(origin, 'notes')).find(note => note.id === 'n_resolve_stale').title, 'External disk change');
    await evaluate(window, 'closeNoteConflictDialog()');
    await waitForConflictDialogClosed(window);
    console.log('PASS stale resolve refreshes options and requires another user choice');

    const previousServer = httpServer;
    await window.loadURL('about:blank');
    await closeServer(previousServer);
    ({ server: httpServer, origin } = await startServer(dataDir));
    await window.loadURL(origin);
    const restartedNoteCount = (await api(origin, 'notes')).length;
    await waitFor(async () => evaluate(window,
      `document.querySelectorAll('#notesGrid .note-card').length === ${restartedNoteCount}`
    ), 'notes after server restart');
    await openConflictDialog(window, 'n_restart_local');
    assert.equal(await evaluate(window, "document.getElementById('noteConflictLocalSelect').value"), restartFixture.drafts[0].draftId);
    assert.equal(await evaluate(window, "document.getElementById('noteConflictDiskTitle').value"), 'Restart canonical');
    assert.equal(await evaluate(window, "document.getElementById('noteConflictLocalBody').value"), '<p>Restart actual local body</p>');
    await clickConflictAction(window, 'noteConflictChooseLocal');
    await waitForConflictDialogClosed(window);
    const restartResolved = (await api(origin, 'notes')).find(note => note.id === 'n_restart_local');
    assert.equal(restartResolved.title, 'Restart actual local');
    assert.equal(restartResolved.content, '<p>Restart actual local body</p>');
    console.log('PASS restart selects the actual local draft instead of the disk preview');

    await openConflictDialog(window, 'n_deleted_ui');
    assert.match(await evaluate(window, "document.getElementById('noteConflictState').textContent"), /服务器记录已删除/);
    assert.equal(await evaluate(window, "document.getElementById('noteConflictChooseDisk').textContent"), '接受删除状态');
    await clickConflictAction(window, 'noteConflictChooseDisk');
    await waitForConflictDialogClosed(window);
    assert.equal((await api(origin, 'notes')).some(note => note.id === 'n_deleted_ui'), false);
    const deletedMarkers = fs.readdirSync(path.join(dataDir, 'deletions', 'notes'))
      .map(file => JSON.parse(fs.readFileSync(path.join(dataDir, 'deletions', 'notes', file), 'utf8')));
    assert.ok(deletedMarkers.some(marker => marker.id === 'n_deleted_ui'));
    console.log('PASS deleted status is explicit and accepting it keeps the tombstone');
  } catch (error) {
    console.error(`FAIL ${error.stack || error}`);
    throw error;
  } finally {
    window?.destroy();
    await closeServer(httpServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(() => app.quit()).catch(error => {
  console.error(error.stack || error);
  app.exit(1);
});
