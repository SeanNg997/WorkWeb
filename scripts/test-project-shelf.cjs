'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server');

const rootDir = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const electronTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-electron-test-'));
let reportPath = '';
app.setPath('userData', electronTestDir);
app.disableHardwareAcceleration();

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

async function api(origin, route, options = {}) {
  const response = await fetch(`${origin}/api/${route}`, {
    method: options.method || 'GET',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json();
  assert.ok(response.ok, `${options.method || 'GET'} ${route}: ${body.error || response.status}`);
  return body;
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`Timed out: ${message}`);
}

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
  return withTimeout(window.webContents.executeJavaScript(script), 10000, 'Renderer JavaScript timed out');
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-project-shelf-'));
  const screenshotDir = path.join(rootDir, 'temp');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `project-shelf-preview-${Date.now()}.png`);
  const logPath = screenshotPath.replace('.png', '.log');
  reportPath = logPath;
  const log = message => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };
  log(`USERDATA ${electronTestDir}`);
  let httpServer;
  let window;
  let origin;

  try {
    log('START temp migration server');
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{
      id: 'legacy-project',
      title: '旧项目',
      summary: '迁移正文应保留',
      tag: '学习',
      pages: ['项目正文保留'],
      createdAt: 1,
      updatedAt: 2,
      order: 0
    }]), 'utf8');

    ({ server: httpServer, origin } = await startServer(dataDir));
    await api(origin, 'storage-migrate', { method: 'POST' });
    await waitFor(async () => {
      const status = await api(origin, 'storage-status');
      return status.state === 'complete' || status.state === 'ready';
    }, 'legacy project migration');
    log('PASS migration complete');

    let projects = await api(origin, 'projects');
    assert.equal(projects.length, 1);
    assert.deepEqual(projects[0].tags, ['学习']);
    assert.equal(projects[0].coverIndex, 0);
    assert.deepEqual(projects[0].pages, ['项目正文保留']);

    const beta = {
      id: 'p_beta', title: '工具项目', summary: '筛选项目', tags: ['工具'], coverIndex: 4,
      pages: ['第二本书的正文'], pageIds: ['pg_beta'], createdAt: 3, updatedAt: 4, order: 1
    };
    await api(origin, 'projects/p_beta', {
      method: 'PUT', body: { item: beta, baseRevision: null }
    });
    log('PASS multi-tag project stored');
    const coverResponse = await fetch(`${origin}/image/project-covers.png`);
    assert.equal(coverResponse.status, 200);
    assert.match(coverResponse.headers.get('content-type') || '', /image\/png/);

    window = new BrowserWindow({
      show: false,
      width: 1380,
      height: 900,
      webPreferences: { backgroundThrottling: false, offscreen: true }
    });
    log('START hidden shelf window');
    await withTimeout(window.loadURL(origin), 15000, 'Window load timed out');
    await window.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    await waitFor(async () => evaluate(window,
      "document.querySelectorAll('#projectShelf .project-book-card').length === 2"
    ), 'project shelf render');
    await evaluate(window, "setTheme('light'); switchPage('progress')");
    log('PASS shelf rendered');

    log('START shelf DOM assertions');
    const shelfState = await evaluate(window, `(() => {
      const cards = [...document.querySelectorAll('#projectShelf .project-book-card')];
      const cover = cards[0]?.querySelector('.project-book-cover');
      return {
        count: cards.length,
        labelsShown: cards.some(card => card.textContent.trim() !== card.querySelector('.project-list-title')?.textContent.trim()),
        coverImage: getComputedStyle(cover).backgroundImage
      };
    })()`);
    assert.equal(shelfState.count, 2);
    assert.equal(shelfState.labelsShown, false);
    assert.match(shelfState.coverImage, /project-covers\.png/);

    log('PASS covers render without tags');
    log('START single-tag filter assertions');
    const filterState = await evaluate(window, `(() => {
      const cards = () => [...document.querySelectorAll('#projectShelf .project-book-card')].map(card => card.dataset.id);
      const pressed = () => [...document.querySelectorAll('#projectTagFilters button[aria-pressed="true"]')]
        .map(button => button.dataset.tag || button.textContent.trim());
      toggleProjectShelfTag('学习');
      const learningIds = cards();
      const learningPressed = pressed();
      toggleProjectShelfTag('工具');
      const toolIds = cards();
      const toolPressed = pressed();
      toggleProjectShelfTag('工具');
      const retainedToolIds = cards();
      const retainedToolPressed = pressed();
      clearProjectShelfTags();
      const clearedIds = cards();
      const clearedPressed = pressed();
      setProjectShelfSearch('旧项目');
      const search = document.querySelectorAll('#projectShelf .project-book-card').length;
      setProjectShelfSearch('');
      return { learningIds, learningPressed, toolIds, toolPressed, retainedToolIds, retainedToolPressed, clearedIds, clearedPressed, search };
    })()`);
    assert.deepEqual(filterState, {
      learningIds: ['legacy-project'], learningPressed: ['学习'],
      toolIds: ['p_beta'], toolPressed: ['工具'],
      retainedToolIds: ['p_beta'], retainedToolPressed: ['工具'],
      clearedIds: ['legacy-project', 'p_beta'], clearedPressed: ['全部'], search: 1
    });
    log('PASS single-tag filter and search');

    await evaluate(window, "document.getElementById('projectManagerButton').click()");
    assert.equal(await evaluate(window,
      "document.querySelectorAll('#projectManagerList .project-manager-row').length"
    ), 2);
    await evaluate(window, "editProjectFromManager('p_beta')");
    window.setSize(720, 590);
    const editorState = await evaluate(window, `(() => {
      const body = document.querySelector('#projectEditorModal .modal-body');
      const cover = document.querySelector('#projectCoverPicker .project-cover-option');
      const coverPreview = getComputedStyle(cover, '::before');
      return {
        coverCount: document.querySelectorAll('#projectCoverPicker .project-cover-option').length,
        coverPreviewImage: coverPreview.backgroundImage,
        coverPreviewSize: coverPreview.backgroundSize,
        coverPreviewTop: coverPreview.top,
        coverPreviewLeft: coverPreview.left,
        canScroll: body.scrollHeight > body.clientHeight,
        footerVisible: document.querySelector('#projectEditorModal .modal-footer').getBoundingClientRect().bottom <= innerHeight
      };
    })()`);
    assert.equal(editorState.coverCount, 20);
    assert.match(editorState.coverPreviewImage, /project-covers\.png/);
    assert.equal(editorState.coverPreviewSize, '400% 500%');
    assert.ok(parseFloat(editorState.coverPreviewTop) < 0);
    assert.ok(parseFloat(editorState.coverPreviewLeft) < 0);
    assert.equal(editorState.canScroll, true);
    assert.equal(editorState.footerVisible, true);
    log('PASS cover editor scroll');
    await wait(500);
    const editorShot = await window.webContents.capturePage();
    fs.writeFileSync(screenshotPath.replace('.png', '-editor.png'), editorShot.toPNG());

    await evaluate(window, `(async () => {
      document.getElementById('projectTitle').value = '工具项目修改';
      selectProjectCover(17);
      toggleProjectEditorTag('学习');
      await saveProject();
    })()`);
    let updated = (await api(origin, 'projects')).find(project => project.id === 'p_beta');
    assert.equal(updated.title, '工具项目修改');
    assert.equal(updated.coverIndex, 17);
    assert.deepEqual(updated.tags, ['工具', '学习']);
    assert.deepEqual(updated.pages, ['第二本书的正文']);
    log('PASS metadata edit retained page body');

    log('START project page tab stable styles');
    await evaluate(window, "openProjectBook('p_beta')");
    await waitFor(async () => evaluate(window,
      "document.querySelector('#projectPageTabs .project-page-tab') && document.getElementById('projectBookView').classList.contains('active')"
    ), 'project page tab render');
    await wait(700);
    const pageTabState = await evaluate(window, `(() => {
      const tab = document.querySelector('#projectPageTabs .project-page-tab');
      const panel = document.querySelector('.project-left-page');
      const ancestors = [
        document.getElementById('projectBookView'),
        document.querySelector('.project-book-spread'),
        panel,
        document.querySelector('.project-page-manager'),
        document.querySelector('.project-page-tabs')
      ];
      return {
        willChange: getComputedStyle(tab).willChange,
        transform: getComputedStyle(tab).transform,
        parentTransforms: ancestors.map(element => getComputedStyle(element).transform),
        fontFamily: getComputedStyle(tab).fontFamily,
        panelFontFamily: getComputedStyle(panel).fontFamily
      };
    })()`);
    assert.equal(pageTabState.willChange, 'auto');
    assert.equal(pageTabState.transform, 'none');
    assert.ok(pageTabState.parentTransforms.every(value => value === 'none'), JSON.stringify(pageTabState.parentTransforms));
    assert.equal(pageTabState.fontFamily, pageTabState.panelFontFamily);
    log(`PASS project page tab stable styles ${JSON.stringify(pageTabState)}`);
    await evaluate(window, 'closeProjectBook()');
    await waitFor(async () => evaluate(window, 'activeProjectId === null'), 'project book close');

    await evaluate(window, "switchPage('progress')");
    window.setSize(1380, 900);
    await wait(500);
    const homeShot = await window.webContents.capturePage();
    fs.writeFileSync(screenshotPath, homeShot.toPNG());
    assert.ok(homeShot.toPNG().length > 10000, 'home screenshot should contain rendered page content');

    await evaluate(window, "openProjectManager(); document.querySelector('[data-id=\\\"legacy-project\\\"] .project-manager-action-danger').click()");
    assert.equal(await evaluate(window,
      "document.getElementById('confirmOverlay').classList.contains('active')"
    ), true);
    assert.equal((await api(origin, 'projects')).length, 2, 'project remains until confirmation');
    await evaluate(window, "document.querySelector('#confirmOverlay .btn-danger-solid').click()");
    await waitFor(async () => (await api(origin, 'projects')).length === 1, 'confirmed project deletion');
    log('PASS delete confirmation');

    log('START trash restore');
    const trashedFiles = fs.readdirSync(path.join(dataDir, 'trash', 'projects'));
    assert.equal(trashedFiles.length, 1);
    log(`Found trash file: ${trashedFiles[0]}`);
    await api(origin, 'restore-trash', {
      method: 'POST', body: { file: `trash/projects/${trashedFiles[0]}` }
    });
    log('PASS trash restore request');
    const restored = (await api(origin, 'projects')).find(project => project.id === 'legacy-project');
    assert.deepEqual(restored.tags, ['学习']);
    assert.equal(restored.coverIndex, 0);

    await window.loadURL('about:blank');
    await closeServer(httpServer);
    ({ server: httpServer, origin } = await startServer(dataDir));
    projects = await api(origin, 'projects');
    log('PASS restarted API read');
    updated = projects.find(project => project.id === 'p_beta');
    assert.equal(projects.length, 2);
    assert.equal(updated.coverIndex, 17);
    assert.deepEqual(updated.tags, ['工具', '学习']);
    assert.deepEqual(updated.pages, ['第二本书的正文']);
    log('PASS restart persistence');

    log('PASS legacy tags migrate; cover and tags persist through edits, trash restore, and server restart');
    log('PASS shelf hides tags, supports single-tag filtering and search, and exposes 20 covers in a scrollable editor');
    log('PASS project deletion waits for confirmation');
    log(`SCREENSHOT ${screenshotPath}`);
    log(`SCREENSHOT ${screenshotPath.replace('.png', '-editor.png')}`);
  } catch (error) {
    log(`FAIL ${error.stack || error}`);
    throw error;
  } finally {
    window?.destroy();
    await closeServer(httpServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(() => app.quit()).catch(error => {
  if (reportPath) fs.appendFileSync(reportPath, `FAIL ${error.stack || error}\n`);
  console.error(error.stack || error);
  app.exit(1);
});
