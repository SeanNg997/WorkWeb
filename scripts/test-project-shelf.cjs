'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('../server');

const rootDir = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const electronTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workweb-electron-test-'));
let reportPath = '';
app.setPath('userData', electronTestDir);
app.disableHardwareAcceleration();
const desktopMainSource = fs.readFileSync(path.join(rootDir, 'electron', 'main.js'), 'utf8');
const allowedDesktopSettings = new Set([
  ...[...(desktopMainSource.match(/const ALLOWED_DESKTOP_SETTING_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '')
    .matchAll(/'([^']+)'/g)].map(([, key]) => key)
]);
const desktopSettingsPath = path.join(electronTestDir, 'desktop-settings.json');
let lastDesktopThemeRead;
const readTestDesktopSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(desktopSettingsPath, 'utf8'));
  } catch {
    return {};
  }
};
ipcMain.handle('workweb:getSetting', (_event, key) => {
  const value = allowedDesktopSettings.has(key) ? readTestDesktopSettings()[key] : undefined;
  if (key === 'wb_theme') lastDesktopThemeRead = value;
  return value;
});
ipcMain.handle('workweb:setSetting', (_event, key, value) => {
  if (!allowedDesktopSettings.has(key)) return undefined;
  fs.writeFileSync(desktopSettingsPath, JSON.stringify({ ...readTestDesktopSettings(), [key]: value }));
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

async function sendMouseClick(window, x, y) {
  const event = { x, y, button: 'left', clickCount: 1 };
  window.webContents.sendInputEvent({ ...event, type: 'mouseDown' });
  window.webContents.sendInputEvent({ ...event, type: 'mouseUp' });
  await wait(40);
}

async function sendMouseMove(window, x, y) {
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(40);
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
  let additionalHttpServer;
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
      webPreferences: {
        backgroundThrottling: false,
        offscreen: true,
        preload: path.join(rootDir, 'electron', 'preload.js')
      }
    });
    log('START hidden shelf window');
    await withTimeout(window.loadURL(origin), 15000, 'Window load timed out');
    await window.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    window.webContents.on('console-message', details => {
      if (Number(details.level) >= 3) {
        log('RENDERER console[' + details.level + '] ' + details.message + ' (' + details.sourceId + ':' + details.lineNumber + ')');
      }
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      log('RENDERER process gone ' + JSON.stringify(details));
    });
    await waitFor(async () => evaluate(window,
      "document.querySelectorAll('#projectShelf .project-book-card').length === 2"
    ), 'project shelf render');

    assert.ok(allowedDesktopSettings.has('wb_theme'), 'desktop setting allowlist must include theme');
    for (const theme of ['light', 'paper', 'mist', 'dark']) {
      await evaluate(window, `setTheme(${JSON.stringify(theme)})`);
      await waitFor(async () => readTestDesktopSettings().wb_theme === theme, `desktop ${theme} theme setting write`);
      const previousOrigin = origin;
      const previousServer = httpServer;
      const nextServer = await startServer(dataDir);
      additionalHttpServer = nextServer.server;
      assert.notEqual(nextServer.origin, previousOrigin, 'server restart should use a new origin');
      await window.loadURL('about:blank');
      await closeServer(previousServer);
      httpServer = additionalHttpServer;
      additionalHttpServer = null;
      origin = nextServer.origin;
      await withTimeout(window.loadURL(origin), 15000, 'Window reload timed out');
      await window.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
      await waitFor(async () => lastDesktopThemeRead === theme && await evaluate(window,
        `document.querySelectorAll('#projectShelf .project-book-card').length === 2 && document.body.dataset.theme === ${JSON.stringify(theme)}`
      ), `${theme} theme restored from desktop settings at new origin`);
    }
    log('PASS all themes persist through desktop settings across separate new origins');
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
    window.setSize(1380, 900);
    await evaluate(window, "openProjectBook('p_beta')");
    await waitFor(async () => evaluate(window,
      "document.querySelector('#projectPageTabs .project-page-tab') && document.getElementById('projectBookView').classList.contains('active')"
    ), 'project page tab render');
    await wait(700);
    const pageTabState = await evaluate(window, `(() => {
      const tab = document.querySelector('#projectPageTabs .project-page-tab');
      const panel = document.querySelector('.project-left-page');
      const manager = document.querySelector('.project-page-manager');
      const outline = document.querySelector('.project-outline');
      const managerTitle = document.querySelector('.project-panel-heading > span');
      const outlineTitle = document.querySelector('.project-outline-title');
      const managerTitleStyle = getComputedStyle(managerTitle);
      const outlineTitleStyle = getComputedStyle(outlineTitle);
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
        panelFontFamily: getComputedStyle(panel).fontFamily,
        title: managerTitle.textContent,
        headingStyles: ['fontSize', 'fontWeight', 'fontFamily', 'letterSpacing'].map(key => managerTitleStyle[key]),
        outlineStyles: ['fontSize', 'fontWeight', 'fontFamily', 'letterSpacing'].map(key => outlineTitleStyle[key]),
        managerHeight: manager.getBoundingClientRect().height,
        outlineHeight: outline.getBoundingClientRect().height
      };
    })()`);
    assert.equal(pageTabState.willChange, 'auto');
    assert.equal(pageTabState.transform, 'none');
    assert.ok(pageTabState.parentTransforms.every(value => value === 'none'), JSON.stringify(pageTabState.parentTransforms));
    assert.equal(pageTabState.fontFamily, pageTabState.panelFontFamily);
    assert.equal(pageTabState.title, '页面');
    assert.equal(await evaluate(window, "document.querySelector('.project-outline-title').textContent"), '大纲');
    assert.deepEqual(pageTabState.headingStyles, pageTabState.outlineStyles);
    assert.ok(Math.abs(pageTabState.managerHeight / (pageTabState.managerHeight + pageTabState.outlineHeight) - 0.75) < 0.05,
      `page manager should use about 75% of available height: ${JSON.stringify(pageTabState)}`);
    log(`PASS project page tab stable styles ${JSON.stringify(pageTabState)}`);
    log('START page management draft, drag, and deletion');
    const managedFixture = await api(origin, 'projects/p_page_manager_test', {
      method: 'PUT', body: { item: {
        id: 'p_page_manager_test', title: 'Page manager test',
        pages: ['# First', '# Second', '# Third'], pageIds: ['pg_manage_1', 'pg_manage_2', 'pg_manage_3']
      } }
    });
    await evaluate(window, `projects.push(normalizeProject(${JSON.stringify(managedFixture.item)})); openProjectBook('p_page_manager_test'); switchProjectPage(1); document.getElementById('projectPagesManageButton').click()`);
    await wait(250);
    assert.equal(await evaluate(window, 'document.getElementById("projectPagesDeleteBtn").disabled'), true);
    assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#projectPagesManagerList .project-page-title')].map(el => el.textContent)`), ['First', 'Second', 'Third']);
    const dragPoints = await evaluate(window, `(() => {
      const handle = document.querySelector('#projectPagesManagerList .project-page-drag-handle').getBoundingClientRect();
      const row = document.querySelectorAll('#projectPagesManagerList .project-page-management-row')[2].getBoundingClientRect();
      return { x: Math.round(handle.left + handle.width / 2), y: Math.round(handle.top + handle.height / 2), targetY: Math.round(row.bottom + 12) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: dragPoints.x, y: dragPoints.y });
    await sendMouseMove(window, dragPoints.x, dragPoints.targetY);
    assert.equal(await evaluate(window, "!!document.querySelector('.project-page-management-row.sort-drag-proxy') && !!document.querySelector('#projectPagesManagerList .sortable-placeholder')"), true, 'drag uses floating proxy and moving placeholder');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: dragPoints.x, y: dragPoints.targetY });
    await waitFor(async () => evaluate(window, "projectPagesDraft.ids[2] === 'pg_manage_1'"), 'page manager drag reorder');
    assert.deepEqual((await api(origin, 'projects')).find(project => project.id === 'p_page_manager_test').pageIds, ['pg_manage_1', 'pg_manage_2', 'pg_manage_3'], 'drag is staged');
    await evaluate(window, 'closeProjectPagesManager(); openProjectPagesManager()');
    assert.deepEqual(await evaluate(window, 'projectPagesDraft.ids'), ['pg_manage_1', 'pg_manage_2', 'pg_manage_3'], 'cancel discards sorting');
    await evaluate(window, `document.querySelector('#projectPagesManagerList input').click(); deleteSelectedProjectPages()`);
    assert.match(await evaluate(window, 'document.getElementById("confirmText").textContent'), /项目内的页面删除后不可恢复/);
    assert.equal(await evaluate(window, 'projectPagesDraft.ids.length'), 3, 'deletion waits for confirmation');
    await evaluate(window, 'closeConfirm()');
    assert.equal(await evaluate(window, 'projectPagesDraft.ids.length'), 3, 'cancel deletion retains rows');
    await evaluate(window, 'deleteSelectedProjectPages(); confirmAction()');
    assert.equal(await evaluate(window, 'projectPagesDraft.ids.length'), 2);
    await evaluate(window, 'closeProjectPagesManager(); openProjectPagesManager()');
    assert.equal(await evaluate(window, 'projectPagesDraft.ids.length'), 3, 'cancel manager discards deletion');
    await evaluate(window, `reorderProjectManagedPages('pg_manage_1', 2); selectProjectManagedPage('pg_manage_3', true); deleteSelectedProjectPages(); confirmAction();`);
    await evaluate(window, `(async () => {
      const persist = persistProject;
      persistProject = async () => { throw new Error('simulated save failure'); };
      try { await saveProjectPagesManager(); } finally { persistProject = persist; }
    })()`);
    assert.equal(await evaluate(window, "document.getElementById('projectPagesManagerModal').classList.contains('active') && !document.getElementById('projectPagesManagerModal').inert"), true, 'failed save retains an editable draft');
    assert.deepEqual(await evaluate(window, "getProjectById(activeProjectId).pageIds"), ['pg_manage_1', 'pg_manage_2', 'pg_manage_3'], 'failed save retains original pages');
    await evaluate(window, 'saveProjectPagesManager()');
    let managedSaved = (await api(origin, 'projects')).find(project => project.id === 'p_page_manager_test');
    assert.deepEqual(managedSaved.pageIds, ['pg_manage_2', 'pg_manage_1']);
    assert.deepEqual(managedSaved.pages, ['# Second', '# First']);
    assert.equal(await evaluate(window, 'activeProjectPageIndex'), 0, 'active page follows stable ID');
    await evaluate(window, `openProjectPagesManager(); reorderProjectManagedPages('pg_manage_1', 0); serverOnline = false;`);
    await evaluate(window, 'saveProjectPagesManager()');
    assert.deepEqual(await evaluate(window, "JSON.parse(localStorage.getItem('wb_projects')).find(project => project.id === activeProjectId).pageIds"), ['pg_manage_1', 'pg_manage_2'], 'offline ordering is cached after applying the draft');
    await evaluate(window, 'serverOnline = true');
    await evaluate(window, `openProjectPagesManager(); projectPagesDraft.ids.forEach(id => selectProjectManagedPage(id, true)); deleteSelectedProjectPages(); confirmAction();`);
    await evaluate(window, 'saveProjectPagesManager()');
    managedSaved = (await api(origin, 'projects')).find(project => project.id === 'p_page_manager_test');
    assert.deepEqual(managedSaved.pages, [''], 'deleting all pages retains a persisted blank page');
    assert.equal(managedSaved.pageIds.length, 1);
    await evaluate(window, `openProjectPagesManager(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate(window, 'activeProjectId'), 'p_page_manager_test', 'Escape closes manager without closing project');
    assert.equal(await evaluate(window, 'projectPagesDraft'), null);
    await evaluate(window, "closeProjectBook(); projects = projects.filter(project => project.id !== 'p_page_manager_test'); renderProjects(); openProjectBook('p_beta')");
    await api(origin, 'projects/p_page_manager_test', { method: 'DELETE' });
    // This fixture must not change the later trash-restore assertions.
    const fixtureTrashDir = path.join(dataDir, 'trash', 'projects');
    for (const file of fs.readdirSync(fixtureTrashDir)) {
      const filePath = path.join(fixtureTrashDir, file);
      if (fs.readFileSync(filePath, 'utf8').includes('p_page_manager_test')) fs.unlinkSync(filePath);
    }
    log('PASS page management drag, cancel, confirmation, batch delete, active page, and empty fallback');
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

    log('START formula, table, and page resume integration');
    const formulaMarkdown = [
      '$1$ $abc$ $a_b_c$ $\\{x\\}$ $\\notacommand$ $\\text{\\$5}$',
      '$5 and $10',
      '\\$x',
      '`$code$`',
      '```js',
      '$fenced$',
      '```',
      '',
      '    $indented$',
      '',
      '$$',
      '\\frac{1}{2}',
      '$$'
    ].join('\n');
    const betaFixture = (await api(origin, 'projects')).find(project => project.id === 'p_beta');
    betaFixture.pages = [formulaMarkdown, '| A | B |\n| --- | --- |\n| C | D |', '第三页'];
    betaFixture.pageIds = ['pg_page_a', 'pg_page_b', 'pg_page_c'];
    betaFixture.pageRevisions = {};
    await api(origin, 'projects/p_beta', {
      method: 'PUT', body: { item: betaFixture, baseRevision: betaFixture.revision }
    });
    const existingEditorState = await api(origin, 'projects/editor-state');
    await api(origin, 'projects/editor-state', {
      method: 'POST',
      body: {
        projectId: 'p_beta', pageId: 'pg_page_c', pageIndex: 2,
        updatedAt: Math.max(Date.now(), Number(existingEditorState.p_beta?.updatedAt || 0) + 1)
      }
    });
    await withTimeout(window.loadURL(origin), 15000, 'Feature test window reload timed out');
    await window.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    await evaluate(window, 'window.addEventListener(\"error\", event => console.error(\"window error\", event.message, event.filename, event.lineno)); window.addEventListener(\"unhandledrejection\", event => console.error(\"unhandled rejection\", event.reason));');
    await waitFor(async () => evaluate(window,
      "document.querySelectorAll('#projectShelf .project-book-card').length === 2"
    ), 'feature shelf render');
    await evaluate(window, "switchPage('progress')");
    await waitFor(async () => evaluate(window, 'projectEditorStateRequest === null'), 'shelf page state refresh');
    await evaluate(window, `(() => {
      window.__editorStateFetches = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        if (String(input).includes('/api/projects/editor-state')) window.__editorStateFetches += 1;
        return originalFetch(input, options);
      };
    })()`);
    await evaluate(window, "openProjectBook('p_beta')");
    await waitFor(async () => evaluate(window,
      "document.querySelector('.novel-project-editor-prose')?.textContent.includes('第三页')"
    ), 'restored third page');
    assert.equal(await evaluate(window, 'activeProjectPageIndex'), 2, 'saved page is restored before editor opens');
    assert.equal(await evaluate(window, 'window.__editorStateFetches'), 0, 'opening a project does not request page state');
    await evaluate(window, "openProjectBook('legacy-project'); openProjectBook('p_beta')");
    assert.equal(await evaluate(window, 'activeProjectPageIndex'), 2, 'switching projects preserves each project position');
    log('PASS saved page restore does not wait for an open-time request');

    await evaluate(window, 'switchProjectPage(0)');
    await waitFor(async () => {
      const state = await api(origin, 'projects/editor-state');
      return state.p_beta?.pageId === 'pg_page_a' && state.p_beta?.pageIndex === 0;
    }, 'page state write after selection');
    const parsedFormulas = await waitFor(async () => evaluate(window, `(() => {
      const prose = document.querySelector('.novel-project-editor-prose');
      if (!prose) return null;
      const formulas = [...prose.querySelectorAll('[data-workweb-math]')].map(node => ({
        type: node.dataset.workwebMath,
        latex: node.dataset.latex
      }));
      return formulas.length >= 7 ? formulas : null;
    })()`), 'formula parsing');
    assert.deepEqual(parsedFormulas.map(item => item.latex), ['1', 'abc', 'a_b_c', '\\{x\\}', '\\notacommand', '\\text{\\$5}', '\\frac{1}{2}']);
    assert.equal(parsedFormulas.filter(item => item.latex === '5 and ' || /^(code|fenced|indented|x)$/.test(item.latex)).length, 0);
    log('PASS formulas preserve LaTeX and ignore amounts, escaped dollars, and code');
    const formulaScreenshotPath = screenshotPath.replace('.png', '-formula.png');
    fs.writeFileSync(formulaScreenshotPath, (await window.webContents.capturePage()).toPNG());
    log('SCREENSHOT ' + formulaScreenshotPath);

    await evaluate(window, `(() => {
      const formula = [...document.querySelectorAll('.novel-math-inline')].find(node => node.dataset.latex === 'a_b_c');
      formula.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const dialog = document.querySelector('.novel-math-dialog');
      if (!dialog?.open) throw new Error('formula edit dialog did not open');
    })()`);
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-math-dialog[open]') !== null"), 'formula edit dialog opens');
    const formulaDialogScreenshotPath = screenshotPath.replace('.png', '-formula-dialog.png');
    fs.writeFileSync(formulaDialogScreenshotPath, (await window.webContents.capturePage()).toPNG());
    log('SCREENSHOT ' + formulaDialogScreenshotPath);
    await evaluate(window, `(() => {
      const dialog = document.querySelector('.novel-math-dialog[open]');
      dialog.querySelector('textarea').value = 'x^2';
      dialog.querySelector('button[type=submit]').click();
    })()`);
    await waitFor(async () => evaluate(window,
      "document.querySelector('.novel-math-inline[data-latex=\"x^2\"]') !== null"
    ), 'formula editor save');
    await evaluate(window, 'toggleProjectSourceMode()');
    const sourceRoundTrip = await evaluate(window, `(() => {
      const source = document.getElementById('projectSourceEditor').value;
      return {
        inline: source.includes('$x^2$'),
        display: source.includes('$$\\n\\\\frac{1}{2}\\n$$'),
        literalDollar: source.includes('\\\\$5 and \\\\$10'),
        escapedDollar: source.includes('\\\\$x')
      };
    })()`);
    assert.deepEqual(sourceRoundTrip, { inline: true, display: true, literalDollar: true, escapedDollar: true });
    log('PASS formula edit and HTML-to-Markdown round trip');
    await evaluate(window, `(() => {
      const host = document.createElement('div');
      host.id = 'formulaPlaceholderTest';
      document.body.append(host);
      window.__placeholderEditor = window.mountNovelProjectEditor(host, { value: '<p></p>' });
    })()`);
    await waitFor(async () => evaluate(window, "!!document.querySelector('#formulaPlaceholderTest .novel-toolbar')"), 'formula placeholder toolbar');
    const formulaPlaceholders = await evaluate(window, `(() => {
      const host = document.getElementById('formulaPlaceholderTest');
      for (const title of ['行内公式', '公式块']) {
        host.querySelector('[title="' + title + '"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      }
      const formulas = [...host.querySelectorAll('[data-workweb-math]')].map(node => ({
        type: node.dataset.workwebMath, latex: node.dataset.latex,
        rendered: !!node.querySelector('.katex') && !node.querySelector('.katex-error')
          && node.textContent.includes('点击写入LaTeX公式')
      }));
      window.__placeholderEditor.destroy();
      delete window.__placeholderEditor;
      host.remove();
      return formulas;
    })()`);
    assert.deepEqual(formulaPlaceholders, ['inline', 'display'].map(type => ({
      type, latex: String.raw`\text{点击写入LaTeX公式}`, rendered: true
    })));
    log('PASS inline and display formulas show the LaTeX input prompt');


    const originalSourceTheme = await evaluate(window, 'document.body.dataset.theme');
    for (const theme of ['light', 'dark']) {
      await evaluate(window, `setTheme(${JSON.stringify(theme)})`);
      const sourceFocusStyle = await evaluate(window, `(() => {
        const source = document.getElementById('projectSourceEditor');
        source.focus({ focusVisible: true });
        const style = getComputedStyle(source);
        return { outline: style.outlineStyle, boxShadow: style.boxShadow };
      })()`);
      assert.deepEqual(sourceFocusStyle, { outline: 'none', boxShadow: 'none' }, `${theme} source focus highlight`);
    }
    await evaluate(window, `setTheme(${JSON.stringify(originalSourceTheme)})`);
    const toolbarPoint = async label => evaluate(window, `(() => {
      const group = [...document.querySelectorAll('.novel-toolbar-group')]
        .find(item => item.querySelector('.novel-toolbar-trigger span')?.textContent.trim() === ${JSON.stringify(label)});
      if (!group) throw new Error('missing toolbar: ' + ${JSON.stringify(label)});
      const rect = group.querySelector('.novel-toolbar-trigger').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await sendMouseMove(window, ...(Object.values(await toolbarPoint('表格'))));
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-table-menu.open') !== null"), 'table menu opens on hover in source mode');
    const tableInputPoint = await evaluate(window, `(() => {
      const input = document.querySelector('.novel-table-menu input[aria-label="行数"]');
      const rect = input.getBoundingClientRect();
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      return { ...point, hit: document.elementFromPoint(point.x, point.y) === input };
    })()`);
    assert.equal(tableInputPoint.hit, true, 'table menu input is visible and hit-testable');
    await sendMouseMove(window, tableInputPoint.x, tableInputPoint.y);
    await wait(350);
    await evaluate(window, `(() => {
      const input = document.querySelector('.novel-table-menu input[aria-label="行数"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(async () => evaluate(window,
      "document.querySelector('.novel-table-menu input[aria-label=\"行数\"]').value === '4'"
    ), 'table menu remains open for input');
    const sourcePoint = await evaluate(window, `(() => {
      const rect = document.getElementById('projectSourceEditor').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await sendMouseMove(window, sourcePoint.x, sourcePoint.y);
    await wait(350);
    assert.equal(await evaluate(window, "document.querySelector('.novel-table-menu.open') === null"), true, 'table menu closes after leaving');

    await sendMouseMove(window, ...(Object.values(await toolbarPoint('列表'))));
    await waitFor(async () => evaluate(window,
      "[...document.querySelectorAll('.novel-toolbar-group')].some(group => group.querySelector('.novel-toolbar-trigger span')?.textContent.trim() === '列表' && group.querySelector('.novel-toolbar-menu.open'))"
    ), 'list menu opens on hover in source mode');
    const listMenuPoint = await evaluate(window, `(() => {
      const group = [...document.querySelectorAll('.novel-toolbar-group')]
        .find(item => item.querySelector('.novel-toolbar-trigger span')?.textContent.trim() === '列表');
      const button = group.querySelector('.novel-toolbar-menu.open .novel-toolbar-button');
      const rect = button.getBoundingClientRect();
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      return { ...point, hit: document.elementFromPoint(point.x, point.y) === button };
    })()`);
    assert.equal(listMenuPoint.hit, true, 'list menu item is visible and hit-testable');
    await sendMouseMove(window, listMenuPoint.x, listMenuPoint.y);
    await wait(350);
    assert.equal(await evaluate(window,
      "[...document.querySelectorAll('.novel-toolbar-group')].some(group => group.querySelector('.novel-toolbar-trigger span')?.textContent.trim() === '列表' && group.querySelector('.novel-toolbar-menu.open'))"
    ), true, 'list menu stays open when pointer enters');
    await sendMouseMove(window, sourcePoint.x, sourcePoint.y);
    await wait(350);

    await sendMouseMove(window, ...(Object.values(await toolbarPoint('更多'))));
    await waitFor(async () => evaluate(window,
      "[...document.querySelectorAll('.novel-toolbar-group')].some(group => group.querySelector('.novel-toolbar-trigger span')?.textContent.trim() === '更多' && group.querySelector('.novel-toolbar-menu.open'))"
    ), 'more menu opens on hover in source mode');
    const sourceTogglePoint = await evaluate(window, `(() => {
      const button = document.querySelector('.novel-toolbar-menu.open [title="返回可视编辑"]');
      if (!button) throw new Error('missing return to visual editor action');
      const rect = button.getBoundingClientRect();
      const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      return { ...point, hit: document.elementFromPoint(point.x, point.y) === button };
    })()`);
    assert.equal(sourceTogglePoint.hit, true, 'source mode toggle is visible and hit-testable');
    await sendMouseClick(window, sourceTogglePoint.x, sourceTogglePoint.y);
    await waitFor(async () => evaluate(window,
      "!document.querySelector('.project-editor-wrap').classList.contains('source-mode')"
    ), 'source mode exits from the more menu');
    log('PASS source mode toolbar hover, visibility, input, focus, and return controls');

    await evaluate(window, 'setProjectSourceMode(false); switchProjectPage(1)');
    await waitFor(async () => evaluate(window,
      "document.querySelector('.novel-project-editor-prose table tr:first-child th') !== null"
    ), 'table page render');
    const cellPoint = await evaluate(window, `(() => {
      const rect = document.querySelector('.novel-project-editor-prose table tbody td').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await sendMouseClick(window, cellPoint.x, cellPoint.y);
    await evaluate(window, "document.querySelector('.novel-toolbar-button[title=\"插入表格\"]').click()");
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-table-menu.open') !== null"), 'table menu opens');
    await waitFor(async () => evaluate(window, `['标题等级', '列表', '下划线', '插入图片', '引用', '代码块', '行内公式', '公式块']
      .every(title => document.querySelector('.novel-toolbar [title="' + title + '"]'))
      && document.querySelector('.novel-table-menu [title="请在表格外创建新表格"]').disabled`), 'full editor toolbar remains available inside tables');
    assert.equal(await evaluate(window, "document.querySelector('.novel-table-menu').textContent.includes('旧表转换')"), false);


    const clickTableAction = async (title, condition, message) => {
      await evaluate(window, '(() => { const title = ' + JSON.stringify(title) + '; const button = [...document.querySelectorAll(".novel-table-menu button")].find(item => item.title === title); if (!button) throw new Error("missing table action: " + title); button.click(); })()');
      await waitFor(async () => evaluate(window, condition), message);
    };
    assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.novel-table-menu button')]
      .filter(button => /切换表头|合并单元格|拆分单元格|选择当前行|选择当前列|全选表格|删除表格/.test(button.textContent)).map(button => button.textContent)`), []);
    const tableTriggerPoint = await evaluate(window, `(() => {
      const rect = document.querySelector('.novel-toolbar-button[title="插入表格"]').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await sendMouseMove(window, tableTriggerPoint.x, tableTriggerPoint.y);
    await waitFor(async () => evaluate(window, "!!document.querySelector('.novel-table-menu.open')"), 'table menu stays open during layout checks');
    const tableMenuLayout = await evaluate(window, `(() => {
      const menu = document.querySelector('.novel-table-menu');
      const modules = [...menu.querySelectorAll('.novel-table-module')];
      const additions = [...menu.querySelectorAll('.novel-table-add-actions button')];
      const rects = additions.map(button => button.getBoundingClientRect());
      return {
        modules: modules.map(module => module.getAttribute('aria-label')),
        labels: [...menu.querySelectorAll('.novel-table-create label')].map(label => label.textContent),
        additions: additions.map(button => button.textContent),
        deletions: [...menu.querySelectorAll('.novel-table-delete-actions button')].map(button => button.textContent),
        equalWidths: rects.every(rect => Math.abs(rect.width - rects[0].width) < 1),
        threeRows: rects[0].top < rects[1].top && Math.abs(rects[1].top - rects[2].top) < 1 && rects[2].top < rects[3].top,
        separators: modules.slice(1).every(module => {
          const style = getComputedStyle(module);
          return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle === 'solid';
        }),
        deletionRows: (() => {
          const buttons = menu.querySelectorAll('.novel-table-delete-actions button');
          return buttons[0].getBoundingClientRect().bottom < buttons[1].getBoundingClientRect().top;
        })()
      };
    })()`);
    assert.deepEqual(tableMenuLayout, {
      modules: ['创建表格', '新增行列', '删减行列'], labels: ['行', '列'],
      additions: ['上方加行', '左侧加列', '右侧加列', '下方加行'], deletions: ['删除行', '删除列'],
      equalWidths: true, threeRows: true, separators: true, deletionRows: true
    });
    fs.writeFileSync(screenshotPath.replace('.png', '-table-menu.png'), (await window.webContents.capturePage()).toPNG());
    await clickTableAction('上方加行', "document.querySelectorAll('.novel-project-editor-prose table tr').length === 3", 'table row insertion');
    await clickTableAction('删除列', "document.querySelectorAll('.novel-project-editor-prose table tr:first-child > *').length === 1", 'table column deletion');
    await clickTableAction('左侧加列', "document.querySelectorAll('.novel-project-editor-prose table tr:first-child > *').length === 2", 'table column insertion');
    await clickTableAction('右侧加列', "document.querySelectorAll('.novel-project-editor-prose table tr:first-child > *').length === 3", 'right column insertion');
    await clickTableAction('下方加行', "document.querySelectorAll('.novel-project-editor-prose table tr').length === 4", 'lower row insertion');
    await clickTableAction('删除行', "document.querySelectorAll('.novel-project-editor-prose table tr').length === 3", 'row deletion');
    await evaluate(window, "document.querySelector('.novel-project-editor-prose').editor.commands.deleteTable()");
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-project-editor-prose table') === null"), 'table reset through editor command');
    log('PASS modular table menu, equal-width insertion controls, row/column actions, and removed buttons');

    await evaluate(window, "[...document.querySelectorAll('.novel-table-menu button')].find(button => button.textContent === '创建表格').click()");
    await waitFor(async () => evaluate(window, "!!document.querySelector('.novel-project-editor-prose table tr:first-child th')"), 'table creation');
    const tableCheckError = await evaluate(window, `(() => {
      try {
      const editor = document.querySelector('.novel-project-editor-prose').editor;
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const table = () => editor.state.doc.firstChild;
      const cellPos = (rowIndex, columnIndex) => {
        let result;
        table().forEach((row, rowOffset, r) => row.forEach((_cell, offset, c) => {
          if (r === rowIndex && c === columnIndex) result = 2 + rowOffset + offset;
        }));
        return result;
      };
      const select = (r, c) => editor.commands.setTextSelection(cellPos(r, c) + 2);
      const headers = () => table().forEach((row, _offset, r) => row.forEach(cell => {
        check(cell.type.name === (r === 0 ? 'tableHeader' : 'tableCell'), 'only the first row is header');
        check(cell.attrs.colspan === 1 && cell.attrs.rowspan === 1 && !cell.attrs.colwidth, 'plain table cell attributes');
      }));
      editor.commands.setContent('<table><tr><td rowspan="2"><p>One</p><p>Two</p></td><td>Three</td></tr><tr><td>Four</td></tr></table>');
      headers();
      check(table().firstChild.firstChild.textContent === 'One Two', 'live imported paragraphs flatten without losing text');
      check(table().child(1).firstChild.textContent === '', 'live imported merged coverage is empty');
      editor.chain().setContent('<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table><p></p>')
        .command(({ tr }) => { tr.setTime(0); return true; }).run();
      select(0, 0);
      editor.commands.addRowBefore();
      headers();
      check(table().child(1).firstChild.textContent === 'A', 'old header becomes body');
      editor.commands.undo();
      headers();
      check(table().childCount === 2, 'undo header insertion');
      editor.commands.redo();
      headers();
      check(table().childCount === 3, 'redo header insertion');
      select(0, 0);
      editor.commands.deleteRow();
      headers();
      check(table().firstChild.firstChild.textContent === 'A', 'new first row becomes header');
      select(0, 0);
      editor.commands.deleteRow();
      headers();
      check(table().firstChild.firstChild.textContent === 'C', 'deleting original header promotes body');
      editor.commands.addRowAfter();
      select(1, 0);
      editor.commands.addColumnBefore();
      headers();
      check(table().firstChild.childCount === 3, 'column insertion');
      editor.commands.deleteColumn();
      headers();
      check(table().firstChild.childCount === 2, 'column deletion');
      editor.commands.setCellSelection({ anchorCell: cellPos(0, 0), headCell: cellPos(1, 1) });
      check(editor.state.selection.isCellSelection || document.querySelectorAll('.novel-project-editor-prose .selectedCell').length === 4, 'rectangular cell selection');
      check(!editor.commands.mergeCells() && !editor.commands.splitCell(), 'merge and split disabled');
      select(0, 0);
      headers();
      return null;
      } catch (error) { return error.stack || String(error); }
    })()`);
    assert.equal(tableCheckError, null);
    const dragCells = await evaluate(window, `(() => {
      const rows = document.querySelector('.novel-project-editor-prose table').rows;
      return [rows[0].cells[0], rows[1].cells[1]].map(cell => {
        const rect = cell.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      });
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...dragCells[0], button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', ...dragCells[1], modifiers: ['leftButtonDown'] });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...dragCells[1], button: 'left', clickCount: 1 });
    await waitFor(async () => evaluate(window, "document.querySelectorAll('.novel-project-editor-prose .selectedCell').length === 4"), 'mouse drag rectangle selection');
    await sendMouseClick(window, dragCells[0].x, dragCells[0].y);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitFor(async () => evaluate(window, `(() => {
      const editor = document.querySelector('.novel-project-editor-prose').editor;
      return editor.state.selection.$from.parent.textContent.includes(' ')
        && editor.state.selection.$from.parent.type.name === 'paragraph'
        && document.querySelectorAll('.novel-project-editor-prose table tr').length === 2;
    })()`), 'Enter flattens cell line breaks without adding paragraphs');
    const legacyTable = String.raw`<table style="width:900px" data-workweb-header-column="true"><caption>Legacy caption</caption>
      <tr><td colspan="2" rowspan="2" colwidth="200,200"><p>Alpha | slash \</p><p>Beta <strong>Bold</strong></p><code>code\|pipe</code></td><th>Tail</th></tr>
      <tr><th>Last<br>line</th></tr><tr><th>E</th><td>F</td><td><img src="/figure.png" alt="Figure text"></td></tr></table>`;
    await evaluate(window, 'handleProjectPageInput(' + JSON.stringify(legacyTable) + '); setProjectEditorMarkdown(getActiveProjectPageContent())');
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-project-editor-prose table')?.textContent.includes('Alpha')"), 'legacy HTML table conversion');
    const convertedCells = await evaluate(window, `[...document.querySelectorAll('.novel-project-editor-prose table tr')]
      .map(row => [...row.cells].map(cell => cell.textContent))`);
    assert.deepEqual(convertedCells, [
      [String.raw`Alpha | slash \ Beta Bold code\|pipe`, '', 'Tail'],
      ['', '', 'Last line'], ['E', 'F', 'Figure text']
    ]);
    await evaluate(window, 'setProjectSourceMode(true)');
    const tableSource = await evaluate(window, "document.getElementById('projectSourceEditor').value");
    assert.doesNotMatch(tableSource, /<\/?(?:table|tr|td|th|img|p|br)\b|colspan|rowspan|colwidth|data-workweb-header|style=/i);
    assert.match(tableSource, /\| --- \| --- \| --- \|/);
    assert.match(tableSource, /Legacy caption/);
    assert.match(tableSource, /\*\*Bold\*\*/);
    const mixedSource = await evaluate(window, 'projectHtmlToMarkdown(' + JSON.stringify('# Heading\n\n' + legacyTable + '\n\n`<table>literal</table>`') + ')');
    assert.match(mixedSource, /^# Heading/);
    assert.match(mixedSource, /`<table>literal<\/table>`/);
    assert.doesNotMatch(mixedSource, /colspan|rowspan|colwidth|data-workweb-header/);

    await evaluate(window, 'window.__tableEditorBeforeExit = document.querySelector(".novel-project-editor-prose"); setProjectSourceMode(false)');
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-project-editor-prose') !== window.__tableEditorBeforeExit && document.querySelector('.novel-project-editor-prose table')?.textContent.includes('Alpha')"), 'table source round trip');
    assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.novel-project-editor-prose table tr')]
      .map(row => [...row.cells].map(cell => cell.textContent))`), convertedCells);
    await waitFor(async () => (await api(origin, 'projects')).find(project => project.id === 'p_beta')?.pages[1] === tableSource, 'pipe table persisted through API');
    log('PASS fixed first-row headers, undo/redo, rectangle selection, legacy spans/text, and Markdown persistence');

    await evaluate(window, `(() => {
      const editor = document.querySelector('.novel-project-editor-prose').editor;
      editor.commands.insertContentAt(editor.state.doc.content.size, '<p></p>');
      editor.commands.focus('end');
      editor.view.focus();
    })()`);
    await waitFor(async () => evaluate(window, "document.activeElement === document.querySelector('.novel-project-editor-prose')"), 'focus paragraph after table');
    for (const character of '$x^2$') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: character });
      await wait(10);
    }
    await waitFor(async () => evaluate(window, "!!document.querySelector('.novel-project-editor-prose .novel-math-inline[data-latex=\"x^2\"]')"), 'typed inline formula');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    for (const character of '$$x^2$$') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: character });
      await wait(10);
    }
    await waitFor(async () => evaluate(window, "!!document.querySelector('.novel-project-editor-prose .novel-math-display[data-latex=\"x^2\"]')"), 'typed display formula');
    log('PASS typed inline and display formulas');

    await evaluate(window, 'switchProjectPage(2)');
    await waitFor(async () => {
      const state = await api(origin, 'projects/editor-state');
      return state.p_beta?.pageId === 'pg_page_c' && state.p_beta?.pageIndex === 2;
    }, 'page state writes selected page ID');
    await evaluate(window, 'reorderProjectPages(2, 0)');
    await waitFor(async () => {
      const state = await api(origin, 'projects/editor-state');
      return state.p_beta?.pageId === 'pg_page_c' && state.p_beta?.pageIndex === 0;
    }, 'page state follows reordered page ID');
    await evaluate(window, "deleteProjectPage(0, { projectId: 'p_beta', pageId: 'pg_page_c' })");
    await waitFor(async () => {
      const state = await api(origin, 'projects/editor-state');
      return state.p_beta?.pageId === 'pg_page_a' && state.p_beta?.pageIndex === 0;
    }, 'deleted page state falls back to adjacent page');
    await evaluate(window, 'closeProjectBook()');
    await waitFor(async () => evaluate(window, 'activeProjectId === null'), 'feature book close');
    await waitFor(async () => (await api(origin, 'projects/editor-state')).p_beta?.pageId === 'pg_page_a', 'close state persistence');
    await window.loadURL('about:blank');
    await closeServer(httpServer);
    ({ server: httpServer, origin } = await startServer(dataDir));
    await withTimeout(window.loadURL(origin), 15000, 'Page resume restart reload timed out');
    await window.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    await waitFor(async () => evaluate(window,
      "document.querySelectorAll('#projectShelf .project-book-card').length === 2"
    ), 'reloaded shelf render');
    await evaluate(window, "switchPage('progress'); openProjectBook('p_beta')");
    await waitFor(async () => evaluate(window, "activeProjectId === 'p_beta' && document.querySelectorAll('#projectPageTabs [data-page-index]').length === 2"), 'reopened project after server restart');
    assert.equal(await evaluate(window, 'activeProjectPageIndex'), 0, 'page state survives app and server restart with stable IDs');
    await waitFor(async () => evaluate(window, "!!document.querySelector('.novel-project-editor-prose .novel-math-inline[data-latex=\"x^2\"]')"), 'edited formula survives server restart');
    assert.ok(fs.existsSync(path.join(dataDir, 'project-editor-state.json')));
    await evaluate(window, 'switchProjectPage(1)');
    await waitFor(async () => evaluate(window, "document.querySelector('.novel-project-editor-prose table')?.textContent.includes('Alpha')"), 'pipe table survives app and server restart');
    assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.novel-project-editor-prose table tr')]
      .map(row => [...row.cells].map(cell => cell.textContent))`), convertedCells);
    const reopenedTableSource = await evaluate(window, 'projectHtmlToMarkdown(document.querySelector(".novel-project-editor-prose").innerHTML)');
    assert.doesNotMatch(reopenedTableSource, /<table|colwidth|data-workweb-header/i);
    log('PASS table structure and text survive source round trip and server restart');
    log('PASS page resume survives sort, delete, close, and server restart');

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
    await closeServer(additionalHttpServer);
    await closeServer(httpServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

app.whenReady().then(run).then(() => app.quit()).catch(error => {
  if (reportPath) fs.appendFileSync(reportPath, `FAIL ${error.stack || error}\n`);
  console.error(error.stack || error);
  app.exit(1);
});
