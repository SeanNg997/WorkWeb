'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createServer } = require('../server');

async function request(origin, route, options = {}) {
  return fetch(`${origin}/api/${route}`, {
    method: options.method || 'GET',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(5000)
  });
}

async function startServer(dataDir) {
  const instance = createServer({ dataDir, host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server: instance.server,
    origin: `http://127.0.0.1:${instance.server.address().port}`
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-storage-sync-'));
  let server;
  try {
    const started = await startServer(dataDir);
    server = started.server;
    const origin = started.origin;
    const notesDir = path.join(dataDir, 'notes');
    const brokenPath = path.join(notesDir, 'broken.json');
    const brokenBytes = Buffer.from('{ definitely not json');
    fs.writeFileSync(brokenPath, brokenBytes);

    let response = await request(origin, 'notes');
    let body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /读取JSON失败/);
    assert.ok(body.error.includes(brokenPath));
    assert.deepEqual(fs.readFileSync(brokenPath), brokenBytes);

    response = await request(origin, 'notes/broken', {
      method: 'PUT',
      body: { item: { id: 'broken', title: 'replacement', content: 'must not overwrite' } }
    });
    body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /读取JSON失败/);
    assert.deepEqual(fs.readFileSync(brokenPath), brokenBytes);
    console.log('PASS corrupt notes return explicit errors and remain unchanged');

    fs.unlinkSync(brokenPath);
    const sidecarPath = path.join(notesDir, '._ignored.json');
    fs.writeFileSync(sidecarPath, '{ sidecar metadata');
    response = await request(origin, 'notes');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    fs.unlinkSync(sidecarPath);
    console.log('PASS macOS JSON sidecars are ignored');

    for (const [id, bytes] of [
      ['invalid-null', Buffer.from('null')],
      ['invalid-array', Buffer.from('[]')]
    ]) {
      const filePath = path.join(notesDir, `${id}.json`);
      fs.writeFileSync(filePath, bytes);
      response = await request(origin, `notes/${id}`, {
        method: 'PUT',
        body: { item: { id, title: 'replacement', content: 'must not overwrite' } }
      });
      body = await response.json();
      assert.equal(response.status, 500);
      assert.match(body.error, /JSON 内容必须为对象/);
      assert.deepEqual(fs.readFileSync(filePath), bytes);
      fs.unlinkSync(filePath);
    }
    console.log('PASS invalid note JSON shapes are not treated as missing');

    response = await request(origin, 'fitness');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    console.log('PASS other API routes remain available');

    const missingProjectDir = path.join(dataDir, 'projects', 'items', 'p_missing-page');
    fs.mkdirSync(path.join(missingProjectDir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(missingProjectDir, 'project.json'), JSON.stringify({
      id: 'p_missing-page',
      title: 'Missing page fixture',
      pageOrder: ['pg_expected'],
      createdAt: 1,
      updatedAt: 1
    }));
    response = await request(origin, 'projects');
    body = await response.json();
    assert.equal(response.status, 500);
    assert.ok(body.error.includes('pg_expected.json'));
    assert.match(body.error, /页面文件不存在/);
    console.log('PASS declared project pages cannot silently become empty');

    const infoPath = path.join(dataDir, 'info.json');
    const originalInfo = fs.readFileSync(infoPath);
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (path.resolve(target) === path.resolve(infoPath)) {
        const error = new Error('injected rename failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename.call(fs, source, target);
    };
    try {
      response = await request(origin, 'info', { method: 'POST', body: [{ id: 'failed' }] });
    } finally {
      fs.renameSync = originalRename;
    }
    body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /写入JSON失败/);
    assert.ok(body.error.includes(infoPath));
    assert.deepEqual(fs.readFileSync(infoPath), originalInfo);
    assert.deepEqual(fs.readdirSync(dataDir).filter(name => /^\.workweb-[\w-]+\.tmp$/i.test(name)), []);
    console.log('PASS failed atomic rename preserves destination and cleans its temp file');

    const transferTempName = '.workweb-123e4567-e89b-12d3-a456-426614174000.tmp';
    fs.writeFileSync(path.join(dataDir, transferTempName), 'partial JSON temp');
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-storage-export-'));
    try {
      response = await request(origin, 'export-data', { method: 'POST', body: { outputDir: exportDir } });
      body = await response.json();
      assert.equal(response.status, 200);
      const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(body.filePath)).toString('utf-8'));
      assert.equal(archive.files.some(file => file.path === transferTempName), false);
    } finally {
      fs.rmSync(exportDir, { recursive: true, force: true });
    }
    fs.unlinkSync(path.join(dataDir, transferTempName));
    console.log('PASS atomic JSON temps are excluded from data export');

    const identicalNote = {
      id: 'sync-identical', title: 'Same note', content: 'same content', span: 1,
      createdAt: 10, updatedAt: 20, revision: 20, order: 0
    };
    const identicalCanonical = path.join(notesDir, 'sync-identical.json');
    const identicalCopy = path.join(notesDir, 'sync-identical-copy.json');
    const identicalBytes = Buffer.from(JSON.stringify(identicalNote));
    fs.writeFileSync(identicalCanonical, identicalBytes);
    fs.writeFileSync(identicalCopy, identicalBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    const identicalResult = body.find(note => note.id === 'sync-identical');
    assert.equal(response.status, 200);
    assert.equal(body.filter(note => note.id === 'sync-identical').length, 1);
    assert.equal(identicalResult.content, 'same content');
    assert.equal(identicalResult.syncConflict, undefined);
    assert.equal(typeof identicalResult.syncToken, 'string');
    assert.deepEqual(fs.readFileSync(identicalCanonical), identicalBytes);
    assert.deepEqual(fs.readFileSync(identicalCopy), identicalBytes);
    console.log('PASS identical note copies aggregate without changing source files');

    const conflictCanonical = path.join(notesDir, 'sync-conflict.json');
    const conflictCopy = path.join(notesDir, 'sync-conflict-copy.json');
    const conflictCanonicalBytes = Buffer.from(JSON.stringify({
      id: 'sync-conflict', title: 'Conflict A', content: 'version A', span: 1,
      createdAt: 30, updatedAt: 40, revision: 40, order: 1
    }));
    const conflictCopyBytes = Buffer.from(JSON.stringify({
      id: 'sync-conflict', title: 'Conflict B', content: 'version B', span: 1,
      createdAt: 30, updatedAt: 40, revision: 40, order: 1
    }));
    fs.writeFileSync(conflictCanonical, conflictCanonicalBytes);
    fs.writeFileSync(conflictCopy, conflictCopyBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    const conflictNote = body.find(note => note.id === 'sync-conflict');
    assert.equal(response.status, 200);
    assert.equal(conflictNote.syncConflict.variants.length, 2);
    assert.deepEqual(fs.readFileSync(conflictCanonical), conflictCanonicalBytes);
    assert.deepEqual(fs.readFileSync(conflictCopy), conflictCopyBytes);

    response = await request(origin, 'notes/sync-conflict', {
      method: 'PUT',
      body: {
        item: { ...conflictNote, title: 'Local draft', content: 'local version' },
        baseRevision: conflictNote.revision,
        baseToken: conflictNote.syncToken
      }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.variants.length, 2);
    assert.ok(body.draft?.draftId);
    const conflictDraftId = body.draft.draftId;
    const conflictDraftPath = path.join(dataDir, 'conflict-drafts', 'notes', 'sync-conflict', body.draft.file);
    assert.equal(fs.existsSync(conflictDraftPath), true);
    response = await request(origin, 'notes');
    body = await response.json();
    const conflictedAgain = body.find(note => note.id === 'sync-conflict');
    assert.equal(conflictedAgain.syncConflict.localDrafts.length, 1);
    assert.equal(conflictedAgain.syncConflict.localDrafts[0].draftId, conflictDraftId);
    assert.deepEqual(fs.readFileSync(conflictCanonical), conflictCanonicalBytes);
    assert.deepEqual(fs.readFileSync(conflictCopy), conflictCopyBytes);
    console.log('PASS different note copies return variants and persist visible conflict drafts');

    const invalidDraftPath = path.join(dataDir, 'conflict-drafts', 'notes', 'sync-conflict', 'not-a-uuid.json');
    fs.writeFileSync(invalidDraftPath, JSON.stringify({
      id: 'sync-conflict', draftId: 'not-a-uuid', item: { id: 'sync-conflict' }
    }));
    response = await request(origin, 'notes');
    body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /便笺草稿 JSON 内容无效/);
    fs.unlinkSync(invalidDraftPath);
    console.log('PASS malformed conflict draft IDs are rejected');

    const revisionPath = path.join(notesDir, 'sync-revision.json');
    const revisionOriginal = {
      id: 'sync-revision', title: 'Revision check', content: 'server version', span: 1,
      createdAt: 50, updatedAt: 60, revision: 60, order: 2
    };
    fs.writeFileSync(revisionPath, JSON.stringify(revisionOriginal));
    response = await request(origin, 'notes');
    body = await response.json();
    const revisionNote = body.find(note => note.id === 'sync-revision');
    fs.writeFileSync(revisionPath, JSON.stringify({ ...revisionOriginal, content: 'changed at same revision' }));
    const changedRevisionBytes = fs.readFileSync(revisionPath);
    response = await request(origin, 'notes/sync-revision', {
      method: 'PUT',
      body: {
        item: { ...revisionNote, content: 'stale local edit' },
        baseRevision: revisionNote.revision,
        baseToken: revisionNote.syncToken
      }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.ok(body.draft?.draftId);
    assert.deepEqual(fs.readFileSync(revisionPath), changedRevisionBytes);
    console.log('PASS same-revision content changes invalidate stale sync tokens');

    const cleanupCanonical = path.join(notesDir, 'sync-cleanup.json');
    const cleanupCopy = path.join(notesDir, 'sync-cleanup-copy.json');
    const cleanupCanonicalBytes = Buffer.from(JSON.stringify({
      id: 'sync-cleanup', title: 'Before merge', content: 'same body', span: 1,
      createdAt: 70, updatedAt: 80, revision: 8, order: 3
    }));
    const cleanupCopyBytes = Buffer.from(JSON.stringify({
      id: 'sync-cleanup', title: 'Before merge', content: 'same body', span: 1,
      createdAt: 70, updatedAt: 90, revision: 19, order: 3
    }));
    fs.writeFileSync(cleanupCanonical, cleanupCanonicalBytes);
    fs.writeFileSync(cleanupCopy, cleanupCopyBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    const cleanupNote = body.find(note => note.id === 'sync-cleanup');
    response = await request(origin, 'notes/sync-cleanup', {
      method: 'PUT',
      body: {
        item: { ...cleanupNote, title: 'Merged note', content: 'updated body' },
        baseRevision: cleanupNote.revision,
        baseToken: cleanupNote.syncToken
      }
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.item.revision > 19);
    assert.equal(fs.existsSync(cleanupCopy), false);
    assert.equal(fs.existsSync(cleanupCanonical), true);
    const historyDir = path.join(dataDir, 'sync-history', 'notes', 'sync-cleanup');
    const historyFiles = fs.readdirSync(historyDir).filter(file => file.endsWith('.json'));
    assert.equal(historyFiles.length, 1);
    const archive = JSON.parse(fs.readFileSync(path.join(historyDir, historyFiles[0]), 'utf-8'));
    assert.deepEqual(archive.files.map(file => file.rawText).sort(), [cleanupCanonicalBytes.toString(), cleanupCopyBytes.toString()].sort());
    console.log('PASS successful save archives identical copies, advances revision, and removes duplicates');

    const occupiedPath = path.join(notesDir, 'sync-occupied.json');
    const occupiedBytes = Buffer.from(JSON.stringify({
      id: 'sync-owner', title: 'Other internal ID', content: 'keep this file', span: 1,
      createdAt: 100, updatedAt: 110, revision: 110, order: 4
    }));
    fs.writeFileSync(occupiedPath, occupiedBytes);
    response = await request(origin, 'notes/sync-occupied', {
      method: 'PUT',
      body: {
        item: { id: 'sync-occupied', title: 'Local note', content: 'do not lose', span: 1 },
        baseRevision: 0,
        baseToken: 'missing'
      }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.ok(body.draft?.draftId);
    assert.deepEqual(fs.readFileSync(occupiedPath), occupiedBytes);
    const occupiedDraftPath = path.join(dataDir, 'conflict-drafts', 'notes', 'sync-occupied', body.draft.file);
    assert.equal(JSON.parse(fs.readFileSync(occupiedDraftPath, 'utf-8')).item.content, 'do not lose');
    console.log('PASS conflicting target IDs preserve the occupied file and save a local draft');

    const deleteCanonical = path.join(notesDir, 'sync-delete.json');
    const deleteCopy = path.join(notesDir, 'sync-delete-copy.json');
    const deleteNote = {
      id: 'sync-delete', title: 'Tombstoned note', content: 'must stay deleted', span: 1,
      createdAt: 120, updatedAt: 130, revision: 130, order: 5
    };
    const deleteCanonicalBytes = Buffer.from(JSON.stringify(deleteNote));
    const deleteCopyBytes = Buffer.from(JSON.stringify(deleteNote));
    fs.writeFileSync(deleteCanonical, deleteCanonicalBytes);
    fs.writeFileSync(deleteCopy, deleteCopyBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    const deleteSnapshot = body.find(note => note.id === 'sync-delete');
    response = await request(origin, 'notes/sync-delete', {
      method: 'DELETE',
      body: {
        baseRevision: deleteSnapshot.revision,
        baseToken: deleteSnapshot.syncToken,
        item: deleteSnapshot
      }
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(deleteCanonical), false);
    assert.equal(fs.existsSync(deleteCopy), false);
    const deletionsDir = path.join(dataDir, 'deletions', 'notes');
    const deleteMarkerFile = fs.readdirSync(deletionsDir).find(file => {
      const marker = JSON.parse(fs.readFileSync(path.join(deletionsDir, file), 'utf-8'));
      return marker.id === 'sync-delete';
    });
    assert.ok(deleteMarkerFile);
    response = await request(origin, 'notes');
    body = await response.json();
    assert.equal(body.some(note => note.id === 'sync-delete'), false);

    const oldReplicaPath = path.join(notesDir, 'old-device-copy.json');
    const oldReplicaBytes = Buffer.from(JSON.stringify(deleteNote));
    fs.writeFileSync(oldReplicaPath, oldReplicaBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    assert.equal(body.some(note => note.id === 'sync-delete'), false);
    response = await request(origin, 'notes/sync-delete', {
      method: 'PUT',
      body: {
        item: { ...deleteSnapshot, content: 'stale device content' },
        baseRevision: deleteSnapshot.revision,
        baseToken: deleteSnapshot.syncToken
      }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.deleted, true);
    assert.equal(body.current, null);
    assert.ok(body.token);
    assert.ok(body.draft?.draftId);
    assert.deepEqual(fs.readFileSync(oldReplicaPath), oldReplicaBytes);
    response = await request(origin, 'notes/sync-delete', { method: 'DELETE', body: {} });
    assert.equal(response.status, 200);
    console.log('PASS deleted notes stay hidden and reject stale replica writes with a draft');

    const trashResponse = await request(origin, 'trash');
    const trashItems = await trashResponse.json();
    const deletedTrashItem = trashItems.find(item => item.title === 'Tombstoned note');
    assert.ok(deletedTrashItem);
    response = await request(origin, 'restore-trash', { method: 'POST', body: { file: deletedTrashItem.file } });
    assert.equal(response.status, 200);
    response = await request(origin, 'notes');
    body = await response.json();
    const restoredNote = body.find(note => note.title === 'Tombstoned note' && note.id !== 'sync-delete');
    assert.ok(restoredNote);
    assert.notEqual(restoredNote.id, 'sync-delete');
    response = await request(origin, 'clear-trash', { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    assert.ok(fs.existsSync(path.join(deletionsDir, deleteMarkerFile)));
    response = await request(origin, 'notes');
    body = await response.json();
    const deletedPreview = body.find(note => note.id === 'sync-delete');
    assert.ok(deletedPreview);
    assert.equal(deletedPreview.syncConflict.deleted, true);
    console.log('PASS restoring tombstoned notes assigns a new ID and clearing trash keeps deletion markers');

    const staleDeletePath = path.join(notesDir, 'sync-stale-delete.json');
    const staleDeleteNote = {
      id: 'sync-stale-delete', title: 'Stale delete', content: 'server version', span: 1,
      createdAt: 140, updatedAt: 150, revision: 150, order: 6
    };
    fs.writeFileSync(staleDeletePath, JSON.stringify(staleDeleteNote));
    response = await request(origin, 'notes');
    body = await response.json();
    const staleDeleteSnapshot = body.find(note => note.id === 'sync-stale-delete');
    fs.writeFileSync(staleDeletePath, JSON.stringify({ ...staleDeleteNote, content: 'newer server version' }));
    const staleDeleteBytes = fs.readFileSync(staleDeletePath);
    response = await request(origin, 'notes/sync-stale-delete', {
      method: 'DELETE',
      body: {
        item: staleDeleteSnapshot,
        baseRevision: staleDeleteSnapshot.revision,
        baseToken: staleDeleteSnapshot.syncToken
      }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.deleted, false);
    assert.ok(body.draft?.draftId);
    assert.deepEqual(fs.readFileSync(staleDeletePath), staleDeleteBytes);
    assert.equal(fs.readdirSync(deletionsDir).some(file => JSON.parse(fs.readFileSync(path.join(deletionsDir, file), 'utf-8')).id === 'sync-stale-delete'), false);
    console.log('PASS stale DELETE is rejected without deleting the newer note');

    const bulkPath = path.join(notesDir, 'sync-bulk.json');
    const bulkBytes = Buffer.from(JSON.stringify({
      id: 'sync-bulk', title: 'Bulk guard', content: 'preserve', span: 1,
      createdAt: 160, updatedAt: 170, revision: 170, order: 7
    }));
    fs.writeFileSync(bulkPath, bulkBytes);
    response = await request(origin, 'notes', { method: 'POST', body: [] });
    body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /逐项保存/);
    assert.deepEqual(fs.readFileSync(bulkPath), bulkBytes);
    console.log('PASS bulk note replacement is rejected without changing files');

    const orderPaths = [path.join(notesDir, 'zz-order-a.json'), path.join(notesDir, 'zz-order-b.json')];
    const orderFixtures = [
      {
        id: 'sync-order', title: 'Order A', content: 'version A', customField: 'preserve-a',
        createdAt: 180, updatedAt: 190, revision: 190, order: 8
      },
      {
        id: 'sync-order', title: 'Order B', content: 'version B', customField: 'preserve-b',
        createdAt: 180, updatedAt: 200, revision: 200, order: 9
      }
    ];
    const orderFixtureBytes = orderFixtures.map(item => Buffer.from(JSON.stringify(item)));
    orderPaths.forEach((filePath, index) => fs.writeFileSync(filePath, orderFixtureBytes[index]));
    response = await request(origin, 'notes');
    body = await response.json();
    const beforeOrder = body.find(note => note.id === 'sync-order');
    const beforeOrderVariantKeys = beforeOrder.syncConflict.variants
      .map(({ file, key }) => ({ file, key }));
    response = await request(origin, 'notes/order', { method: 'POST', body: { ids: ['sync-order'] } });
    assert.equal(response.status, 200);
    response = await request(origin, 'notes');
    body = await response.json();
    const afterOrder = body.find(note => note.id === 'sync-order');
    assert.equal(afterOrder.syncToken, beforeOrder.syncToken);
    assert.deepEqual(afterOrder.syncConflict.variants.map(({ file, key }) => ({ file, key })), beforeOrderVariantKeys);
    assert.deepEqual(fs.readdirSync(notesDir).filter(file => file.startsWith('sync-order')), []);
    for (const [index, filePath] of orderPaths.entries()) {
      const ordered = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(ordered.id, 'sync-order');
      assert.equal(ordered.title, orderFixtures[index].title);
      assert.equal(ordered.content, orderFixtures[index].content);
      assert.equal(ordered.customField, orderFixtures[index].customField);
      assert.equal(ordered.revision, orderFixtures[index].revision);
      assert.equal(ordered.updatedAt, orderFixtures[index].updatedAt);
      assert.equal(ordered.order, 0);
    }

    for (const filePath of orderPaths) {
      const ordered = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      ordered.createdAt += 1;
      ordered.order += 1;
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(Object.entries(ordered).reverse()), null, 2));
    }
    response = await request(origin, 'notes');
    body = await response.json();
    const reformattedOrder = body.find(note => note.id === 'sync-order');
    assert.equal(reformattedOrder.syncToken, beforeOrder.syncToken);
    assert.deepEqual(reformattedOrder.syncConflict.variants.map(({ file, key }) => ({ file, key })), beforeOrderVariantKeys);
    console.log('PASS variant keys ignore order, createdAt, and JSON formatting changes');

    const sortedOrderPaths = [...orderPaths].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const originalRenameForOrder = fs.renameSync;
    let changedDuringOrder = false;
    fs.renameSync = (source, target) => {
      const result = originalRenameForOrder.call(fs, source, target);
      if (!changedDuringOrder && path.resolve(target) === path.resolve(sortedOrderPaths[0])) {
        const changed = JSON.parse(fs.readFileSync(sortedOrderPaths[1], 'utf-8'));
        changed.content = 'version B changed while ordering';
        fs.writeFileSync(sortedOrderPaths[1], JSON.stringify(changed));
        changedDuringOrder = true;
      }
      return result;
    };
    try {
      response = await request(origin, 'notes/order', { method: 'POST', body: { ids: ['sync-order'] } });
    } finally {
      fs.renameSync = originalRenameForOrder;
    }
    assert.equal(response.status, 200);
    assert.equal(changedDuringOrder, true);
    assert.equal(JSON.parse(fs.readFileSync(sortedOrderPaths[1], 'utf-8')).content, 'version B changed while ordering');
    assert.equal(orderPaths.every(filePath => fs.existsSync(filePath)), true);
    assert.equal(fs.existsSync(path.join(notesDir, 'sync-order.json')), false);
    console.log('PASS note ordering preserves divergent versions and skips candidates changed during write');

    const targetDeletedId = 'sync-import-target-deleted';
    const sourceDeletedId = 'sync-import-source-deleted';
    const targetMarkerDir = path.join(dataDir, 'deletions', 'notes');
    const targetMarkerPath = path.join(targetMarkerDir, 'target-marker-name.json');
    const targetMarkerBytes = Buffer.from(JSON.stringify({ id: targetDeletedId, deletedAt: '2026-11-18T00:00:00.000Z' }));
    fs.writeFileSync(targetMarkerPath, targetMarkerBytes);
    const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-storage-import-'));
    try {
      const transferEntry = (filePath, value) => ({
        path: filePath,
        data: Buffer.from(JSON.stringify(value)).toString('base64')
      });
      const archiveFiles = [
        transferEntry('notes/source-legacy-name.json', {
          id: sourceDeletedId, title: 'Must not resurrect', content: 'old body', span: 1,
          createdAt: 210, updatedAt: 220, revision: 220, order: 8
        }),
        transferEntry('notes/target-legacy-name.json', {
          id: targetDeletedId, title: 'Explicit import', content: 'retain under new id', span: 1,
          createdAt: 230, updatedAt: 240, revision: 240, order: 9
        }),
        transferEntry('deletions/notes/source-marker-name.json', {
          id: sourceDeletedId, deletedAt: '2026-11-18T00:00:00.000Z'
        })
      ];
      const importPath = path.join(importDir, 'fixture.workweb');
      fs.writeFileSync(importPath, zlib.gzipSync(Buffer.from(JSON.stringify({
        magic: 'workweb-data-export', version: 1, exportedAt: new Date().toISOString(), files: archiveFiles
      }))));
      response = await request(origin, 'import-data', { method: 'POST', body: { filePath: importPath } });
      body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.importedCount, 2);
      assert.deepEqual(fs.readFileSync(targetMarkerPath), targetMarkerBytes);
      response = await request(origin, 'notes');
      body = await response.json();
      assert.equal(body.some(note => note.id === sourceDeletedId), false);
      assert.equal(body.some(note => note.id === targetDeletedId), false);
      const explicitlyImported = body.find(note => note.title === 'Explicit import');
      assert.ok(explicitlyImported);
      assert.notEqual(explicitlyImported.id, targetDeletedId);
      const sourceHistoryDir = path.join(dataDir, 'sync-history', 'notes', sourceDeletedId);
      assert.ok(fs.readdirSync(sourceHistoryDir).some(file => file.startsWith('import-')));
    } finally {
      fs.rmSync(importDir, { recursive: true, force: true });
    }
    console.log('PASS imported tombstones precede notes and prevent same-source resurrection');

    const diskResolveId = 'sync-resolve-disk';
    const diskResolveCanonical = path.join(notesDir, `${diskResolveId}.json`);
    const diskResolveCopy = path.join(notesDir, `${diskResolveId}-copy.json`);
    const diskResolveBytes = [
      Buffer.from(JSON.stringify({
        id: diskResolveId, title: 'Disk A', content: 'disk version A', span: 1,
        createdAt: 300, updatedAt: 310, revision: 310, order: 10
      })),
      Buffer.from(JSON.stringify({
        id: diskResolveId, title: 'Disk B', content: 'disk version B', span: 1,
        createdAt: 300, updatedAt: 320, revision: 320, order: 10
      }))
    ];
    fs.writeFileSync(diskResolveCanonical, diskResolveBytes[0]);
    fs.writeFileSync(diskResolveCopy, diskResolveBytes[1]);
    response = await request(origin, 'notes');
    body = await response.json();
    const diskResolveState = body.find(note => note.id === diskResolveId);
    const selectedDiskVariant = diskResolveState.syncConflict.variants.find(variant => variant.file === path.basename(diskResolveCopy));
    response = await request(origin, `notes/${diskResolveId}/resolve`, {
      method: 'POST',
      body: { choice: 'disk', token: diskResolveState.syncToken, variantKey: selectedDiskVariant.key }
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.item.content, 'disk version B');
    assert.ok(body.item.revision > 320);
    assert.equal(body.item.order, 10);
    assert.equal(fs.existsSync(diskResolveCopy), false);
    const diskResolveHistoryDir = path.join(dataDir, 'sync-history', 'notes', diskResolveId);
    const diskResolveArchivePath = path.join(diskResolveHistoryDir, fs.readdirSync(diskResolveHistoryDir).find(file => file.startsWith('resolve-')));
    const diskResolveArchive = JSON.parse(fs.readFileSync(diskResolveArchivePath, 'utf-8'));
    assert.deepEqual(diskResolveArchive.files.map(file => file.rawText).sort(), diskResolveBytes.map(bytes => bytes.toString()).sort());
    console.log('PASS disk resolution selects one version and archives every source candidate');

    const localResolveId = 'sync-resolve-local';
    const localResolveCanonical = path.join(notesDir, `${localResolveId}.json`);
    const localResolveCopy = path.join(notesDir, `${localResolveId}-copy.json`);
    const localResolveFixtures = [
      { id: localResolveId, title: 'Server A', content: 'server A', span: 1, createdAt: 330, updatedAt: 340, revision: 340, order: 11 },
      { id: localResolveId, title: 'Server B', content: 'server B', span: 1, createdAt: 330, updatedAt: 350, revision: 350, order: 11 }
    ];
    const localResolveBytes = localResolveFixtures.map(item => Buffer.from(JSON.stringify(item)));
    fs.writeFileSync(localResolveCanonical, localResolveBytes[0]);
    fs.writeFileSync(localResolveCopy, localResolveBytes[1]);
    response = await request(origin, 'notes');
    body = await response.json();
    const localResolveState = body.find(note => note.id === localResolveId);
    const localBase = { baseRevision: localResolveState.revision, baseToken: localResolveState.syncToken };
    response = await request(origin, `notes/${localResolveId}/draft`, {
      method: 'POST',
      body: { item: { id: localResolveId, title: 'Local chosen', content: 'local chosen text', span: 1, order: 11 }, ...localBase }
    });
    const firstLocalDraftResponse = await response.json();
    assert.equal(response.status, 200);
    const firstLocalDraft = firstLocalDraftResponse.draft;
    const localDraftDir = path.join(dataDir, 'conflict-drafts', 'notes', localResolveId);
    fs.copyFileSync(path.join(localDraftDir, firstLocalDraft.file), path.join(localDraftDir, 'renamed-synced-copy.json'));
    response = await request(origin, 'notes');
    body = await response.json();
    assert.equal(body.find(note => note.id === localResolveId).syncConflict.localDrafts.length, 1);
    response = await request(origin, `notes/${localResolveId}/draft`, {
      method: 'POST',
      body: { item: { id: localResolveId, title: 'Other local', content: 'other local text', span: 1, order: 11 }, ...localBase }
    });
    const secondLocalDraftResponse = await response.json();
    assert.equal(response.status, 200);
    const secondLocalDraft = secondLocalDraftResponse.draft;
    response = await request(origin, 'notes');
    body = await response.json();
    const localResolveBefore = body.find(note => note.id === localResolveId);
    assert.equal(localResolveBefore.syncConflict.localDrafts.length, 2);
    response = await request(origin, `notes/${localResolveId}/resolve`, {
      method: 'POST',
      body: {
        choice: 'local', token: localResolveBefore.syncToken, draftId: firstLocalDraft.draftId,
        item: { id: localResolveId, title: 'Local chosen', content: 'local chosen text', span: 1, order: 11 }
      }
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.item.content, 'local chosen text');
    assert.ok(body.item.revision > 350);
    assert.equal(body.item.order, 11);
    assert.deepEqual(body.item.syncConflict.localDrafts.map(draft => draft.draftId), [secondLocalDraft.draftId]);
    const localResolveHistoryDir = path.join(dataDir, 'sync-history', 'notes', localResolveId);
    const localResolveArchive = JSON.parse(fs.readFileSync(path.join(localResolveHistoryDir, fs.readdirSync(localResolveHistoryDir).find(file => file.startsWith('resolve-'))), 'utf-8'));
    assert.deepEqual(localResolveArchive.files.map(file => file.rawText).sort(), localResolveBytes.map(bytes => bytes.toString()).sort());
    assert.equal(localResolveArchive.selectedDraft.draftId, firstLocalDraft.draftId);
    assert.ok(fs.readdirSync(path.join(dataDir, 'resolved-drafts', 'notes', localResolveId))
      .some(file => JSON.parse(fs.readFileSync(path.join(dataDir, 'resolved-drafts', 'notes', localResolveId, file), 'utf-8')).draftId === firstLocalDraft.draftId));
    fs.copyFileSync(path.join(localDraftDir, firstLocalDraft.file), path.join(localDraftDir, 'resolved-draft-synced-back.json'));
    response = await request(origin, 'notes');
    body = await response.json();
    assert.deepEqual(body.find(note => note.id === localResolveId).syncConflict.localDrafts.map(draft => draft.draftId), [secondLocalDraft.draftId]);
    console.log('PASS local resolution resolves only the selected draft and keeps resolved copies closed');

    const copyResolveId = 'sync-resolve-copy';
    const copyResolveCanonical = path.join(notesDir, `${copyResolveId}.json`);
    const copyResolveCopy = path.join(notesDir, `${copyResolveId}-copy.json`);
    const copyResolveFixtures = [
      { id: copyResolveId, title: 'Copy disk A', content: 'disk A', span: 1, createdAt: 360, updatedAt: 370, revision: 370, order: 12 },
      { id: copyResolveId, title: 'Copy disk B', content: 'disk B', span: 1, createdAt: 360, updatedAt: 380, revision: 380, order: 12 }
    ];
    const copyResolveBytes = copyResolveFixtures.map(item => Buffer.from(JSON.stringify(item)));
    fs.writeFileSync(copyResolveCanonical, copyResolveBytes[0]);
    fs.writeFileSync(copyResolveCopy, copyResolveBytes[1]);
    response = await request(origin, 'notes');
    body = await response.json();
    const copyResolveState = body.find(note => note.id === copyResolveId);
    const copyDiskVariant = copyResolveState.syncConflict.variants.find(variant => variant.file === path.basename(copyResolveCopy));
    response = await request(origin, `notes/${copyResolveId}/resolve`, {
      method: 'POST',
      body: {
        choice: 'copy', token: copyResolveState.syncToken, variantKey: copyDiskVariant.key,
        item: { id: copyResolveId, title: 'Local copy', content: 'preserved local text', span: 1, order: 12 }
      }
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.item.content, 'disk B');
    assert.equal(body.copiedItem.content, 'preserved local text');
    assert.notEqual(body.copiedItem.id, copyResolveId);
    assert.ok(body.item.revision > 380);
    const copyResolveHistoryDir = path.join(dataDir, 'sync-history', 'notes', copyResolveId);
    const copyResolveArchive = JSON.parse(fs.readFileSync(path.join(copyResolveHistoryDir, fs.readdirSync(copyResolveHistoryDir).find(file => file.startsWith('resolve-'))), 'utf-8'));
    assert.deepEqual(copyResolveArchive.files.map(file => file.rawText).sort(), copyResolveBytes.map(bytes => bytes.toString()).sort());
    console.log('PASS copy resolution keeps the selected disk version and creates a new local ID');

    const failedCopyId = 'sync-resolve-copy-fail';
    const failedCopyCanonical = path.join(notesDir, `${failedCopyId}.json`);
    const failedCopyDuplicate = path.join(notesDir, `${failedCopyId}-copy.json`);
    const failedCopyBytes = [
      Buffer.from(JSON.stringify({ id: failedCopyId, title: 'Keep A', content: 'keep A', span: 1, createdAt: 390, updatedAt: 400, revision: 400, order: 13 })),
      Buffer.from(JSON.stringify({ id: failedCopyId, title: 'Keep B', content: 'keep B', span: 1, createdAt: 390, updatedAt: 410, revision: 410, order: 13 }))
    ];
    fs.writeFileSync(failedCopyCanonical, failedCopyBytes[0]);
    fs.writeFileSync(failedCopyDuplicate, failedCopyBytes[1]);
    response = await request(origin, 'notes');
    body = await response.json();
    const failedCopyState = body.find(note => note.id === failedCopyId);
    const failedCopyVariant = failedCopyState.syncConflict.variants.find(variant => variant.file === path.basename(failedCopyDuplicate));
    const renameBeforeCopyFailure = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (path.resolve(target) === path.resolve(failedCopyCanonical)) {
        const error = new Error('injected canonical write failure');
        error.code = 'EIO';
        throw error;
      }
      return renameBeforeCopyFailure.call(fs, source, target);
    };
    try {
      response = await request(origin, `notes/${failedCopyId}/resolve`, {
        method: 'POST',
        body: {
          choice: 'copy', token: failedCopyState.syncToken, variantKey: failedCopyVariant.key,
          item: { id: failedCopyId, title: 'Copy remains', content: 'new local copy', span: 1, order: 13 }
        }
      });
    } finally {
      fs.renameSync = renameBeforeCopyFailure;
    }
    body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(fs.readFileSync(failedCopyCanonical), failedCopyBytes[0]);
    assert.deepEqual(fs.readFileSync(failedCopyDuplicate), failedCopyBytes[1]);
    response = await request(origin, 'notes');
    body = await response.json();
    assert.ok(body.some(note => note.id !== failedCopyId && note.title === 'Copy remains'));
    console.log('PASS failed copy resolution preserves every original candidate');

    const staleResolveId = 'sync-resolve-stale-token';
    const staleResolveCanonical = path.join(notesDir, `${staleResolveId}.json`);
    const staleResolveDuplicate = path.join(notesDir, `${staleResolveId}-copy.json`);
    const staleResolveFixture = {
      id: staleResolveId, title: 'Stale A', content: 'before change', span: 1,
      createdAt: 420, updatedAt: 430, revision: 430, order: 14
    };
    fs.writeFileSync(staleResolveCanonical, JSON.stringify(staleResolveFixture));
    fs.writeFileSync(staleResolveDuplicate, JSON.stringify({ ...staleResolveFixture, title: 'Stale B', content: 'other version' }));
    response = await request(origin, 'notes');
    body = await response.json();
    const staleResolveState = body.find(note => note.id === staleResolveId);
    const staleCanonicalVariantKey = staleResolveState.syncConflict.variants
      .find(variant => variant.file === path.basename(staleResolveCanonical)).key;
    fs.writeFileSync(staleResolveCanonical, JSON.stringify({ ...staleResolveFixture, content: 'changed after opening dialog' }));
    const staleResolveBytes = fs.readFileSync(staleResolveCanonical);
    response = await request(origin, `notes/${staleResolveId}/resolve`, {
      method: 'POST',
      body: { choice: 'local', token: staleResolveState.syncToken, item: { id: staleResolveId, title: 'Local stale', content: 'do not overwrite', span: 1 } }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.notEqual(body.token, staleResolveState.syncToken);
    assert.equal(body.conflict.variants.length, 2);
    assert.deepEqual(fs.readFileSync(staleResolveCanonical), staleResolveBytes);
    console.log('PASS resolve rejects a stale dialog token without overwriting newer disk content');

    response = await request(origin, 'notes');
    body = await response.json();
    const currentResolveState = body.find(note => note.id === staleResolveId);
    response = await request(origin, `notes/${staleResolveId}/resolve`, {
      method: 'POST',
      body: { choice: 'disk', token: currentResolveState.syncToken, variantKey: staleCanonicalVariantKey }
    });
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.token, currentResolveState.syncToken);
    assert.equal(body.conflict.variants.length, 2);
    assert.deepEqual(fs.readFileSync(staleResolveCanonical), staleResolveBytes);
    console.log('PASS expired variant keys return the current conflict state');

    const writeArchiveRaceId = 'sync-write-archive-race';
    const writeArchiveRaceCanonical = path.join(notesDir, `${writeArchiveRaceId}.json`);
    const writeArchiveRaceDuplicate = path.join(notesDir, `${writeArchiveRaceId}-copy.json`);
    const writeArchiveRaceFixture = {
      id: writeArchiveRaceId, title: 'Same note', content: 'base content', span: 1,
      createdAt: 440, updatedAt: 450, revision: 450, order: 15
    };
    const writeArchiveRaceCanonicalBytes = Buffer.from(JSON.stringify(writeArchiveRaceFixture));
    const writeArchiveRaceDuplicateBytes = Buffer.from(JSON.stringify({
      ...writeArchiveRaceFixture, updatedAt: 451, revision: 451
    }));
    fs.writeFileSync(writeArchiveRaceCanonical, writeArchiveRaceCanonicalBytes);
    fs.writeFileSync(writeArchiveRaceDuplicate, writeArchiveRaceDuplicateBytes);
    response = await request(origin, 'notes');
    body = await response.json();
    const writeArchiveRaceState = body.find(note => note.id === writeArchiveRaceId);
    const renameBeforeWriteArchiveRace = fs.renameSync;
    let changedDuringWriteArchive = false;
    const writeArchiveHistoryPrefix = path.resolve(path.join(dataDir, 'sync-history', 'notes', writeArchiveRaceId)) + path.sep;
    fs.renameSync = (source, target) => {
      const result = renameBeforeWriteArchiveRace.call(fs, source, target);
      if (!changedDuringWriteArchive && path.resolve(target).startsWith(writeArchiveHistoryPrefix)) {
        fs.writeFileSync(writeArchiveRaceCanonical, JSON.stringify({
          ...writeArchiveRaceFixture, content: 'arrived during write archive'
        }));
        changedDuringWriteArchive = true;
      }
      return result;
    };
    try {
      response = await request(origin, `notes/${writeArchiveRaceId}`, {
        method: 'PUT',
        body: {
          item: { id: writeArchiveRaceId, title: 'Local edit', content: 'keep as draft', span: 1 },
          baseRevision: writeArchiveRaceState.revision,
          baseToken: writeArchiveRaceState.syncToken
        }
      });
    } finally {
      fs.renameSync = renameBeforeWriteArchiveRace;
    }
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(changedDuringWriteArchive, true);
    assert.notEqual(body.token, writeArchiveRaceState.syncToken);
    assert.ok(body.draft?.draftId);
    assert.equal(body.conflict.localDrafts.some(draft => draft.draftId === body.draft.draftId), true);
    assert.equal(JSON.parse(fs.readFileSync(writeArchiveRaceCanonical, 'utf-8')).content, 'arrived during write archive');
    assert.deepEqual(fs.readFileSync(writeArchiveRaceDuplicate), writeArchiveRaceDuplicateBytes);
    console.log('PASS note PUT rechecks the token after archiving and keeps changed candidates');

    const writeMissingRaceId = 'sync-write-missing-race';
    const writeMissingRacePath = path.join(notesDir, `${writeMissingRaceId}.json`);
    const writeMissingRaceBytes = Buffer.from(JSON.stringify({
      id: writeMissingRaceId, title: 'Concurrent note', content: 'keep disk version', span: 1,
      createdAt: 455, updatedAt: 456, revision: 456, order: 16
    }));
    const readdirBeforeWriteMissingRace = fs.readdirSync;
    let insertedDuringMissingCheck = false;
    fs.readdirSync = function (directory, options) {
      const entries = readdirBeforeWriteMissingRace.call(fs, directory, options);
      if (!insertedDuringMissingCheck && path.resolve(String(directory)) === path.resolve(notesDir)) {
        fs.writeFileSync(writeMissingRacePath, writeMissingRaceBytes);
        insertedDuringMissingCheck = true;
      }
      return entries;
    };
    try {
      response = await request(origin, `notes/${writeMissingRaceId}`, {
        method: 'PUT',
        body: { item: { id: writeMissingRaceId, title: 'Local new note', content: 'keep as draft', span: 1 } }
      });
    } finally {
      fs.readdirSync = readdirBeforeWriteMissingRace;
    }
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(insertedDuringMissingCheck, true);
    assert.equal(body.conflict.missing, false);
    assert.equal(body.conflict.variants.length, 1);
    assert.ok(body.draft?.draftId);
    assert.deepEqual(fs.readFileSync(writeMissingRacePath), writeMissingRaceBytes);
    console.log('PASS new note PUT detects a concurrent creation before writing');

    const archiveRaceId = 'sync-resolve-archive-race';
    const archiveRaceCanonical = path.join(notesDir, `${archiveRaceId}.json`);
    const archiveRaceDuplicate = path.join(notesDir, `${archiveRaceId}-copy.json`);
    const archiveRaceFixture = {
      id: archiveRaceId, title: 'Race A', content: 'archive source A', span: 1,
      createdAt: 450, updatedAt: 460, revision: 460, order: 15
    };
    fs.writeFileSync(archiveRaceCanonical, JSON.stringify(archiveRaceFixture));
    fs.writeFileSync(archiveRaceDuplicate, JSON.stringify({ ...archiveRaceFixture, title: 'Race B', content: 'archive source B' }));
    response = await request(origin, 'notes');
    body = await response.json();
    const archiveRaceState = body.find(note => note.id === archiveRaceId);
    const renameBeforeArchiveRace = fs.renameSync;
    let changedDuringArchive = false;
    const archiveRaceHistoryPrefix = path.resolve(path.join(dataDir, 'sync-history', 'notes', archiveRaceId)) + path.sep;
    fs.renameSync = (source, target) => {
      const result = renameBeforeArchiveRace.call(fs, source, target);
      if (!changedDuringArchive && path.resolve(target).startsWith(archiveRaceHistoryPrefix)) {
        fs.writeFileSync(archiveRaceCanonical, JSON.stringify({ ...archiveRaceFixture, content: 'arrived during archive' }));
        changedDuringArchive = true;
      }
      return result;
    };
    try {
      response = await request(origin, `notes/${archiveRaceId}/resolve`, {
        method: 'POST',
        body: { choice: 'local', token: archiveRaceState.syncToken, item: { id: archiveRaceId, title: 'Local race', content: 'must not overwrite' } }
      });
    } finally {
      fs.renameSync = renameBeforeArchiveRace;
    }
    body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(changedDuringArchive, true);
    assert.notEqual(body.token, archiveRaceState.syncToken);
    assert.equal(JSON.parse(fs.readFileSync(archiveRaceCanonical, 'utf-8')).content, 'arrived during archive');
    console.log('PASS resolve rechecks the token after archiving before writing');

    const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-storage-migration-'));
    let migrationServer;
    try {
      const migrationNotesDir = path.join(migrationDir, 'notes');
      const migrationDeletionsDir = path.join(migrationDir, 'deletions', 'notes');
      fs.mkdirSync(migrationNotesDir, { recursive: true });
      fs.mkdirSync(migrationDeletionsDir, { recursive: true });
      fs.writeFileSync(path.join(migrationDir, 'storage-meta.json'), JSON.stringify({ schemaVersion: 1 }));
      const migrationNotePath = path.join(migrationNotesDir, 'legacy-filename.json');
      const migrationNoteBytes = Buffer.from(JSON.stringify({
        id: 'sync-migration-deleted', title: 'Migration old copy', content: 'do not migrate', span: 1,
        createdAt: 250, updatedAt: 260, revision: 260, order: 0
      }));
      fs.writeFileSync(migrationNotePath, migrationNoteBytes);
      const migrationIdCollision = {
        id: 'sync-migration-id-collision', title: 'Legacy candidate', content: 'preserve as copy', span: 1,
        createdAt: 270, updatedAt: 280, revision: 280, order: 1
      };
      const migrationBusinessConflict = {
        id: 'sync-migration-business-conflict', title: 'Legacy wins', content: 'new business content', span: 1,
        createdAt: 290, updatedAt: 610, revision: 610, order: 2
      };
      const migrationSameBusiness = {
        id: 'sync-migration-same-business', title: 'Same business', content: 'same body', span: 1,
        createdAt: 330, updatedAt: 630, revision: 630, order: 3
      };
      fs.writeFileSync(path.join(migrationDir, 'notes.json'), JSON.stringify([
        migrationIdCollision, migrationBusinessConflict, migrationSameBusiness
      ]));
      const collisionCanonicalPath = path.join(migrationNotesDir, `${migrationIdCollision.id}.json`);
      const collisionCanonicalBytes = Buffer.from(JSON.stringify({
        id: 'sync-migration-foreign-id', title: 'Foreign canonical', content: 'must be preserved', span: 1,
        createdAt: 100, updatedAt: 110, revision: 110, order: 4
      }));
      fs.writeFileSync(collisionCanonicalPath, collisionCanonicalBytes);
      const businessCanonicalPath = path.join(migrationNotesDir, `${migrationBusinessConflict.id}.json`);
      const businessCanonicalBytes = Buffer.from(JSON.stringify({
        ...migrationBusinessConflict, title: 'Canonical version', content: 'keep canonical content',
        createdAt: 290, updatedAt: 500, revision: 500
      }));
      fs.writeFileSync(businessCanonicalPath, businessCanonicalBytes);
      const sameBusinessCanonicalPath = path.join(migrationNotesDir, `${migrationSameBusiness.id}.json`);
      fs.writeFileSync(sameBusinessCanonicalPath, JSON.stringify({
        ...migrationSameBusiness, createdAt: 300, updatedAt: 620, revision: 620, order: 9
      }));
      fs.writeFileSync(path.join(migrationDeletionsDir, 'marker-with-unrelated-name.json'), JSON.stringify({
        id: 'sync-migration-deleted', deletedAt: '2026-11-18T00:00:00.000Z'
      }));
      const migrationStarted = await startServer(migrationDir);
      migrationServer = migrationStarted.server;
      response = await request(migrationStarted.origin, 'storage-migrate', { method: 'POST', body: {} });
      assert.equal(response.status, 202);
      let migrationStatus;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        response = await request(migrationStarted.origin, 'storage-status');
        migrationStatus = await response.json();
        if (migrationStatus.state === 'complete' || migrationStatus.state === 'error') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(migrationStatus.state, 'complete');
      response = await request(migrationStarted.origin, 'notes');
      body = await response.json();
      assert.equal(body.some(note => note.id === 'sync-migration-deleted'), false);
      assert.deepEqual(fs.readFileSync(migrationNotePath), migrationNoteBytes);
      assert.deepEqual(fs.readFileSync(collisionCanonicalPath), collisionCanonicalBytes);
      assert.deepEqual(fs.readFileSync(businessCanonicalPath), businessCanonicalBytes);
      const migratedFiles = fs.readdirSync(migrationNotesDir);
      const collisionCopyPath = path.join(migrationNotesDir, migratedFiles.find(file => file.startsWith(`${migrationIdCollision.id}_`)));
      const businessCopyPath = path.join(migrationNotesDir, migratedFiles.find(file => file.startsWith(`${migrationBusinessConflict.id}_`)));
      assert.equal(JSON.parse(fs.readFileSync(collisionCopyPath, 'utf-8')).content, migrationIdCollision.content);
      assert.equal(JSON.parse(fs.readFileSync(businessCopyPath, 'utf-8')).content, migrationBusinessConflict.content);
      assert.equal(migratedFiles.some(file => file.startsWith(`${migrationSameBusiness.id}_`)), false);
      const normalizedSameBusiness = JSON.parse(fs.readFileSync(sameBusinessCanonicalPath, 'utf-8'));
      assert.equal(normalizedSameBusiness.updatedAt, migrationSameBusiness.updatedAt);
      assert.equal(normalizedSameBusiness.order, migrationSameBusiness.order);
    } finally {
      await closeServer(migrationServer);
      fs.rmSync(migrationDir, { recursive: true, force: true });
    }
    console.log('PASS migration reads tombstones by content ID before legacy note files');

    const ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-storage-ghost-drafts-'));
    let ghostServer;
    try {
      const ghostNotesDir = path.join(ghostDir, 'notes');
      const ghostDeletionDir = path.join(ghostDir, 'deletions', 'notes');
      fs.mkdirSync(ghostNotesDir, { recursive: true });
      fs.mkdirSync(ghostDeletionDir, { recursive: true });
      const ghostDeletedId = 'sync-ghost-deleted';
      const ghostMissingId = 'sync-ghost-missing';
      const ghostRestoreId = 'sync-ghost-local-restore';
      const ghostDeletedMarkerPath = path.join(ghostDeletionDir, 'not-the-id.json');
      fs.writeFileSync(ghostDeletedMarkerPath, JSON.stringify({
        id: ghostDeletedId, deletedAt: '2026-11-18T00:00:00.000Z'
      }));
      let ghostStarted = await startServer(ghostDir);
      ghostServer = ghostStarted.server;

      response = await request(ghostStarted.origin, `notes/${ghostMissingId}/draft`, {
        method: 'POST',
        body: {
          item: { id: ghostMissingId, title: 'Older local', content: 'older text', span: 1, order: 0 },
          baseRevision: 5,
          baseToken: 'old-missing-token'
        }
      });
      const olderDraftResponse = await response.json();
      assert.equal(response.status, 200);
      const olderDraft = olderDraftResponse.draft;
      const latestDraftBody = {
        item: { id: ghostMissingId, title: 'Latest local', content: 'latest text', span: 1, order: 0 },
        baseRevision: 5,
        baseToken: 'old-missing-token',
        supersedesDraftId: olderDraft.draftId
      };
      const resolvedMarkerPrefix = path.resolve(path.join(ghostDir, 'resolved-drafts', 'notes', ghostMissingId)) + path.sep;
      const renameBeforeSupersede = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (path.resolve(target).startsWith(resolvedMarkerPrefix)) {
          const error = new Error('injected resolved marker failure');
          error.code = 'EIO';
          throw error;
        }
        return renameBeforeSupersede.call(fs, source, target);
      };
      try {
        response = await request(ghostStarted.origin, `notes/${ghostMissingId}/draft`, {
          method: 'POST', body: latestDraftBody
        });
      } finally {
        fs.renameSync = renameBeforeSupersede;
      }
      const failedSupersede = await response.json();
      assert.equal(response.status, 500);
      assert.ok(failedSupersede.draft?.draftId);
      const latestDraft = failedSupersede.draft;
      assert.equal(fs.existsSync(path.join(ghostDir, 'conflict-drafts', 'notes', ghostMissingId, latestDraft.file)), true);
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      assert.equal(body.find(note => note.id === ghostMissingId).syncConflict.localDrafts.length, 2);

      response = await request(ghostStarted.origin, `notes/${ghostMissingId}/draft`, {
        method: 'POST', body: latestDraftBody
      });
      const supersededResponse = await response.json();
      assert.equal(response.status, 200);
      assert.equal(supersededResponse.draft.draftId, latestDraft.draftId);
      assert.deepEqual(supersededResponse.conflict.localDrafts.map(draft => draft.draftId), [latestDraft.draftId]);

      response = await request(ghostStarted.origin, `notes/${ghostMissingId}/draft`, {
        method: 'POST', body: latestDraftBody
      });
      const replayedSupersede = await response.json();
      assert.equal(response.status, 200);
      assert.equal(replayedSupersede.draft.draftId, latestDraft.draftId);
      assert.deepEqual(replayedSupersede.conflict.localDrafts.map(draft => draft.draftId), [latestDraft.draftId]);
      console.log('PASS superseded draft retries are idempotent');

      response = await request(ghostStarted.origin, `notes/${ghostDeletedId}/draft`, {
        method: 'POST',
        body: {
          item: { id: ghostDeletedId, title: 'Deleted local', content: 'restore after delete', span: 1, order: 1 },
          baseRevision: 7,
          baseToken: 'old-deleted-token'
        }
      });
      const deletedDraftResponse = await response.json();
      assert.equal(response.status, 200);
      const deletedDraft = deletedDraftResponse.draft;

      response = await request(ghostStarted.origin, `notes/${ghostRestoreId}/draft`, {
        method: 'POST',
        body: {
          item: { id: ghostRestoreId, title: 'Missing local', content: 'restore missing', span: 1, order: 2 },
          baseRevision: 9,
          baseToken: 'old-missing-token'
        }
      });
      const restoreDraftResponse = await response.json();
      assert.equal(response.status, 200);
      const restoreDraft = restoreDraftResponse.draft;

      await closeServer(ghostServer);
      ghostServer = null;
      ghostStarted = await startServer(ghostDir);
      ghostServer = ghostStarted.server;
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      let ghostMissingPreview = body.find(note => note.id === ghostMissingId);
      const ghostDeletedPreview = body.find(note => note.id === ghostDeletedId);
      const ghostRestorePreview = body.find(note => note.id === ghostRestoreId);
      assert.equal(ghostMissingPreview.syncConflict.missing, true);
      assert.equal(ghostMissingPreview.syncConflict.localDrafts.length, 1);
      assert.equal(ghostMissingPreview.syncConflict.localDrafts[0].draftId, latestDraft.draftId);
      assert.equal(ghostDeletedPreview.syncConflict.deleted, true);
      assert.equal(ghostRestorePreview.syncConflict.missing, true);

      const ghostMissingToken = ghostMissingPreview.syncToken;
      const returnedOlderDraft = path.join(ghostDir, 'conflict-drafts', 'notes', ghostMissingId, 'older-draft-synced-back.json');
      fs.copyFileSync(path.join(ghostDir, 'conflict-drafts', 'notes', ghostMissingId, olderDraft.file), returnedOlderDraft);
      const lateMissingPath = path.join(ghostNotesDir, 'late-missing-source.json');
      const lateMissingBytes = Buffer.from(JSON.stringify({
        id: ghostMissingId, title: 'Late source', content: 'new source arrived', span: 1,
        createdAt: 500, updatedAt: 510, revision: 510, order: 0
      }));
      fs.writeFileSync(lateMissingPath, lateMissingBytes);
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      ghostMissingPreview = body.find(note => note.id === ghostMissingId);
      assert.notEqual(ghostMissingPreview.syncToken, ghostMissingToken);
      assert.equal(ghostMissingPreview.syncConflict.missing, false);
      assert.deepEqual(ghostMissingPreview.syncConflict.localDrafts.map(draft => draft.draftId), [latestDraft.draftId]);
      response = await request(ghostStarted.origin, `notes/${ghostMissingId}/resolve`, {
        method: 'POST',
        body: { choice: 'local', token: ghostMissingToken, draftId: latestDraft.draftId }
      });
      body = await response.json();
      assert.equal(response.status, 409);
      assert.deepEqual(fs.readFileSync(lateMissingPath), lateMissingBytes);
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      ghostMissingPreview = body.find(note => note.id === ghostMissingId);
      assert.deepEqual(ghostMissingPreview.syncConflict.localDrafts.map(draft => draft.draftId), [latestDraft.draftId]);

      const ghostDeletedToken = ghostDeletedPreview.syncToken;
      const lateDeletedPath = path.join(ghostNotesDir, 'late-deleted-source.json');
      const lateDeletedBytes = Buffer.from(JSON.stringify({
        id: ghostDeletedId, title: 'Late deleted replica', content: 'must remain hidden', span: 1,
        createdAt: 520, updatedAt: 530, revision: 530, order: 1
      }));
      fs.writeFileSync(lateDeletedPath, lateDeletedBytes);
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      const lateDeletedPreview = body.find(note => note.id === ghostDeletedId);
      assert.equal(lateDeletedPreview.syncConflict.deleted, true);
      assert.notEqual(lateDeletedPreview.syncToken, ghostDeletedToken);
      response = await request(ghostStarted.origin, `notes/${ghostDeletedId}/resolve`, {
        method: 'POST',
        body: { choice: 'local', token: lateDeletedPreview.syncToken, draftId: deletedDraft.draftId }
      });
      body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.item, null);
      assert.notEqual(body.copiedItem.id, ghostDeletedId);
      assert.equal(fs.existsSync(ghostDeletedMarkerPath), true);
      assert.deepEqual(fs.readFileSync(lateDeletedPath), lateDeletedBytes);

      response = await request(ghostStarted.origin, `notes/${ghostRestoreId}/resolve`, {
        method: 'POST',
        body: { choice: 'local', token: ghostRestorePreview.syncToken, draftId: restoreDraft.draftId }
      });
      body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.item, null);
      assert.notEqual(body.copiedItem.id, ghostRestoreId);
      const ghostRestoredId = body.copiedItem.id;
      fs.copyFileSync(
        path.join(ghostDir, 'conflict-drafts', 'notes', ghostRestoreId, restoreDraft.file),
        path.join(ghostDir, 'conflict-drafts', 'notes', ghostRestoreId, 'resolved-draft-synced-back.json')
      );
      response = await request(ghostStarted.origin, 'notes');
      body = await response.json();
      assert.equal(body.some(note => note.id === ghostRestoreId), false);
      assert.equal(body.some(note => note.id === ghostRestoredId), true);
    } finally {
      await closeServer(ghostServer);
      fs.rmSync(ghostDir, { recursive: true, force: true });
    }
    console.log('PASS missing/deleted drafts survive restart, supersede safely, and resolve to new IDs');

    const infoValue = [{ id: 'info-check', value: 1 }];
    response = await request(origin, 'info', { method: 'POST', body: infoValue });
    assert.equal(response.status, 200);
    response = await request(origin, 'info');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), infoValue);
    console.log('PASS atomic JSON write and read');
  } finally {
    await closeServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
