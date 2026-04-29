# WorkWeb 项目维护文档

这份文档用于在新的对话或新的开发上下文中快速接手 WorkWeb。优先阅读本文件，再按目标功能定位到具体源码，不需要每次重新通读整个项目。

## 1. 项目定位

WorkWeb 是一个完全本地化的个人工作面板，包含以下主要功能：

- TODO / 便笺：卡片式便笺，支持内联标题编辑、富文本/Markdown 内容编辑、拖拽排序、卡片宽度调整。
- 项目书架：按标签分组的项目书架，每个项目有简介和多页内容，项目页使用富文本编辑器，支持源码模式、页面切换、页面拖拽排序和当前本子内查找。
- 项目页图片：项目 Markdown/富文本编辑器支持插入和粘贴图片，图片文件复制到数据目录 `projects/figures/`，正文保存 `projects/figures/...` 相对路径。
- 常用个人信息：按标签分组的信息面板，字段可标记为加密显示，支持复制、折叠、拖拽排序。
- 回收站：删除 TODO 和项目时，服务端会把对应 JSON 移到数据目录根部 `trash/`，设置页提供恢复和清空回收站入口。

应用既可以作为普通本地 Web 服务运行，也可以通过 Electron 打包为桌面应用。数据默认写入本地 `data/` 目录，桌面打包版首次启动会要求确认或选择数据目录。

## 2. 技术栈与运行方式

主要技术：

- Node.js 原生 `http` 服务，见 `server.js`。
- 单页前端主要写在 `index.html` 中，包含 CSS、HTML 结构和大部分业务 JS。
- Electron 桌面壳，见 `electron/main.js` 和 `electron/preload.js`。
- React 19 + novel/Tiptap 富文本编辑器，源码在 `src/novel-project-editor.jsx`，通过 Vite 打包成 `vendor/novel-project-editor.js` 后被 `index.html` 引入。
- `@tiptap/extension-image` 用于项目页图片节点。
- `marked` 用于 Markdown 到 HTML 的解析，静态文件在 `vendor/marked.min.js`。

常用命令：

```bash
npm run start        # 启动本地 server.js，并打开浏览器 http://127.0.0.1:3000
npm run server       # 只启动本地 Web 服务
npm run desktop      # Electron 开发运行
npm run build:novel  # 重新打包 src/novel-project-editor.jsx 到 vendor/novel-project-editor.js
npm run pack:win     # Windows 打包
npm run pack:mac     # macOS DMG 打包
```

注意：如果修改 `src/novel-project-editor.jsx`，需要执行 `npm run build:novel`，否则 `index.html` 实际加载的 `vendor/novel-project-editor.js` 不会更新。`vendor/novel-project-editor.js` 是构建产物，通常不要手改。

## 3. 目录和文件职责

```text
.
├── index.html                      # 主前端：样式、布局、业务逻辑都集中在这里
├── server.js                       # 本地 HTTP 服务、数据读写、导入导出、数据目录迁移
├── package.json                    # npm 脚本、Electron Builder 配置
├── src/novel-project-editor.jsx    # React/Tiptap 富文本编辑器源码
├── vendor/
│   ├── novel-project-editor.js     # 富文本编辑器 IIFE 构建产物
│   ├── marked.min.js               # Markdown 解析库
│   └── workweb.css                 # 当前基本无实际内容
├── electron/
│   ├── main.js                     # Electron 主进程、窗口、数据目录选择、更新逻辑、IPC
│   └── preload.js                  # 暴露 window.workwebDesktop 给前端
├── scripts/
│   ├── launch.js                   # 源码版启动脚本，启动 server 并打开浏览器
│   └── build-win.js                # Windows 分阶段打包并修正 exe 图标/版本信息
├── build/installer.nsh             # NSIS 安装器自定义脚本
├── data/                           # 开发环境默认数据目录
├── image/                          # 图标和 README 截图
└── Start WorkWeb.*                 # macOS/Windows 双击启动脚本
```

## 4. 运行架构

源码 Web 模式：

1. `npm run start` 执行 `scripts/launch.js`。
2. `launch.js` 检查 `http://127.0.0.1:3000` 是否已有服务。
3. 如果没有服务，就后台运行 `node server.js`，日志写到 `runtime/workweb-server.log`。
4. 服务可用后用系统默认浏览器打开页面。

Electron 模式：

1. `electron/main.js` 在 `app.whenReady()` 后注册 IPC、配置自动更新、启动本地服务。
2. `ensureServer()` 调用 `startServer({ port: 0 })`，使用随机可用端口。
3. 桌面版数据目录由 `resolveDataDir()` 决定：开发环境固定为项目内 `data/`；打包版优先读用户设置，否则弹窗选择。
4. `BrowserWindow` 加载本地服务 URL，而不是直接打开文件。
5. `electron/preload.js` 通过 `contextBridge` 暴露 `window.workwebDesktop`，前端用它选择目录、选择导入文件、读写桌面设置、检查和下载更新。

## 5. 后端服务 `server.js`

`server.js` 是无框架 Node HTTP 服务，负责静态文件和 JSON API。

核心常量：

- `DEFAULT_PORT`：默认 `3000`，可用环境变量 `WORKWEB_PORT` 覆盖。
- `DEFAULT_HOST`：默认 `127.0.0.1`。
- `DEFAULT_DATA_DIR`：默认项目内 `data/`，可用 `WORKWEB_DATA_DIR` 覆盖。
- `INFO_FILE`：`info.json`。
- `EXPORT_FILE_NAME`：`WorkWeb_data.workweb`。

主要数据辅助函数：

- `initializeData(dataDir)`：确保数据目录、`info.json`、`notes/`、`projects/`、`trash/`、`projects/figures/` 存在，并迁移旧版集合文件。
- `readCollection(dataDir, key)`：读取 `notes/` 或 `projects/` 下的单项 JSON，按 `order`、`createdAt` 排序。
- `writeCollection(dataDir, key, items)`：将整个数组写回为一项一个 JSON 文件；不再存在的旧文件会移动到回收站。
- `migrateLegacyCollection(dataDir, key)`：如果新目录还没有分项文件，则从旧版 `notes.json` / `projects.json` 迁移。
- `createDataExport(dataDir, outputDir)`：把数据目录所有文件 base64 后 gzip 成 `.workweb` 文件。
- `importDataExport(dataDir, filePath)`：读取 `.workweb`，合并导入现有数据。
- `mergeDataDirs(sourceDir, targetDir)`：更改数据目录时，把旧目录数据合并到新目录。
- `saveProjectFigure(dataDir, body)`：保存项目页上传或粘贴的图片到 `projects/figures/`。
- `listTrash(dataDir)`：递归扫描 `trash/` 下所有 JSON，兼容 `trash/notes`、`trash/projects`、`trash/todo`、`trash/project` 和旧的散放文件。
- `restoreTrashFile(dataDir, file)`：按回收站文件内容或目录名推断恢复到 `notes/` 或 `projects/`。

API 路由：

- `GET /api/version`：返回 `package.json` 版本。
- `GET /api/data-dir`：返回当前数据目录。
- `POST /api/data-dir`：迁移并切换数据目录，请求体 `{ targetDir }`。
- `POST /api/export-data`：导出数据，请求体 `{ outputDir }`。
- `POST /api/import-data`：导入数据，请求体 `{ filePath }`。
- `GET /api/notes` / `POST /api/notes`：读取或覆盖便笺数组。
- `GET /api/info` / `POST /api/info`：读取或覆盖个人信息数组。
- `GET /api/projects` / `POST /api/projects`：读取或覆盖项目数组。
- `POST /api/project-figures`：保存项目图片，请求体 `{ name, dataUrl }`，返回 `{ path }`，其中 `path` 形如 `projects/figures/xxx.png`。
- `POST /api/clear-trash`：清空数据目录下 `trash/`。
- `GET /api/trash`：递归列出回收站里的 TODO 和项目，返回标题、类别、删除时间和恢复用文件路径。
- `POST /api/restore-trash`：恢复回收站项目，请求体 `{ file }`。
- `GET /projects/figures/...`：从当前数据目录的 `projects/figures/` 读取图片静态文件。
- 其他路径作为静态文件，从项目根目录读取。

安全和兼容点：

- 导入文件时会拒绝绝对路径和包含 `..` 的相对路径。
- `notes` 和 `projects` 现在是一项一个 JSON 文件；旧的 `notes.json` / `projects.json` 只作为迁移和导入兼容存在。
- `writeCollection()` 发现 `notes/` 或 `projects/` 下有不再属于当前数组的文件时，会移动到 `trash/notes` 或 `trash/projects`，并写入 `deletedAt`，而不是直接删除。
- `/api/trash` 读取时会递归扫描整个 `trash/`，不是只读固定两级目录。
- `info` 仍是单文件 `info.json`。
- `writeCollection` 是“覆盖式全量保存”，前端每次保存传整个数组，服务端按数组顺序更新 `order`。

## 6. 数据模型

便笺 `note`：

```js
{
  id: 'n_...',
  title: '',
  content: '',       // 现在可能是 Markdown，也可能是富文本 HTML
  span: 1,           // 卡片宽度，1 到 3
  createdAt: 0,
  updatedAt: 0,
  order: 0           // 服务端写入分项文件时补充
}
```

项目 `project`：

```js
{
  id: 'p_...',
  title: '',
  summary: '',
  tags: ['标签'],    // 前端会 normalize，旧字段 tag 也兼容
  pages: [''],       // 每页内容字符串，通常为 HTML
  createdAt: 0,
  updatedAt: 0,
  order: 0
}
```

信息面板 `infoPanel`：

```js
{
  id: 'i_...',
  title: '',
  tag: '',
  fields: [
    { label: '', value: '', encrypted: false }
  ],
  createdAt: 0,
  updatedAt: 0
}
```

前端离线回退：

- 如果 `loadData()` 访问 API 失败，会从 `localStorage` 读取 `wb_notes`、`wb_info`、`wb_projects`。
- `persistNotes()`、`persistInfo()`、`persistProjects()` 在 API 保存失败时也会写入 `localStorage`。
- 主题始终存在 `localStorage` 的 `wb_theme`。
- Markdown 字号设置优先通过桌面设置保存，同时也写 `localStorage` 的 `wb_markdown_size`。

## 7. 前端主文件 `index.html`

`index.html` 分三大部分：

1. `<style>`：主题变量、布局、便笺、项目书架、富文本编辑器、信息面板、设置和弹窗样式。
2. `<body>`：侧边栏、三个页面、多个弹窗、确认框、toast。
3. `<script>`：数据 API、全局状态、渲染函数、事件处理和快捷键。

### 7.1 样式区大致位置

- `:root` 和 `body[data-theme=...]`：主题变量，支持 `sage`、`sand`、`blue`、`stone`。
- 侧边栏：`.sidebar`、`.nav-item`、`.theme-panel`、`.sidebar-settings`。
- 工作区：`.workspace`、`.workspace-header`、`.workspace-body`、`.page`。
- 按钮：`.btn`、`.btn-primary`、`.btn-secondary`、`.btn-danger` 等。
- 便笺：`.notes-grid`、`.note-card`、`.note-content-editor-host`、`.note-save-status`。
- 通用拖拽：`.sortable-source`、`.sort-drag-proxy`、`.sortable-placeholder`。
- 项目书架和项目页：`.project-shelf`、`.project-book-card`、`.project-book-view`、`.project-page-editor`、`.novel-toolbar`。
- 信息面板：`.info-tag-group`、`.info-panel`、`.info-field`。
- 设置/更新：`.settings-modal`、`.update-modal`、`.update-progress`。
- 弹窗/确认框/toast：`.modal-overlay`、`.confirm-overlay`、`.toast`。

### 7.2 页面结构

侧边栏：

- 三个导航项调用 `switchPage('todo' | 'progress' | 'info')`。
- 设置按钮调用 `openSettings()`。
- 主题按钮调用 `setTheme(theme)`。

TODO 页面：

- 新建按钮调用 `createNote()`。
- 容器 `#notesGrid` 由 `renderNotes()` 填充。
- 空状态 `#emptyState`。

项目书架页面：

- 添加按钮调用 `openProjectEditor()`。
- `#projectShelfView` 中的 `#projectShelf` 由 `renderProjects()` 填充。
- `#projectBookView` 是打开项目后的双页书本视图。
- `#projectPageEditor` 挂载富文本编辑器。
- `#projectSourceEditor` 是源码模式 textarea。
- `#projectPageTabs` 渲染页码按钮和新增按钮。页码支持拖拽排序，拖拽插入位置会被限制在新增按钮左侧。
- `#projectFindBar` 是项目内查找条，用户在项目编辑区域按 `Ctrl+F` / `Cmd+F` 时显示；每次打开会清空输入。输入后只统计匹配数量，不自动切换页面；点击上/下按钮才跳到对应页面并选中结果。

常用个人信息页面：

- 添加按钮调用 `openInfoEditor()`。
- `#infoContainer` 由 `renderInfoPanels()` 填充。

弹窗：

- `#editorModal`：旧的便笺编辑弹窗，目前便笺主要是卡片内联编辑，但相关函数仍在。
- `#infoEditorModal`：信息面板编辑。
- `#projectEditorModal`：项目元信息编辑。
- `#settingsModal`：导入导出、数据目录、更新、Markdown 字号。
- 设置页数据文件卡片包含“恢复”和“清空回收站”。恢复打开 `#trashRestoreModal` 并调用 `/api/trash`、`/api/restore-trash`；清空会先走通用确认框再请求 `/api/clear-trash`。
- 设置页更改数据目录时，`changeDataDir()` 会先走通用确认框，确认后由 `migrateDataDir()` 请求 `/api/data-dir`。
- `#updateModal`：更新下载进度。
- `#confirmOverlay`：删除确认。

### 7.3 前端全局状态

主要数组：

- `notes`
- `infoPanels`
- `projects`

运行状态：

- `serverOnline`：API 是否可用。
- `currentAppVersion`：从 `/api/version` 读取。
- `selectedNextDataDir`：设置页中待切换的数据目录。
- `updateState`：桌面更新状态。

编辑和拖拽状态：

- `editingNoteId`、`editingInfoId`、`editingProjectId`
- `pendingAction`
- `draggedId`：便笺拖拽。
- `draggedProjectId`、`draggedProjectTag`
- `draggedInfoTag`、`draggedInfoPanelId`

便笺编辑器状态：

- `noteEditors`：每个便笺卡片挂载的富文本编辑器 API。
- `noteDraftTimers`：便笺防抖保存计时器。
- `noteSaveStates`：每个便笺保存状态徽标。

项目页状态：

- `activeProjectId`
- `activeProjectPageIndex`
- `projectPersistTimer`
- `projectCloseTimer`
- `projectEditor`
- `isSettingProjectEditor`
- `projectSourceMode`
- `projectSaveRevision`
- `projectSaveStatus`
- `projectFindResults`
- `projectFindIndex`
- `projectFindQuery`

### 7.4 数据加载和保存

入口在 `DOMContentLoaded`：

1. `loadTheme()`
2. `loadMarkdownFontSize()`
3. 注册 `window.workwebDesktop.onUpdateState`
4. `loadAppVersion()`
5. `loadData()`
6. `renderNotes()`
7. `renderProjects()`
8. `renderInfoPanels()`
9. `applyProjectEditorMode()`
10. `updateDateDisplay()` 并每分钟更新

API 封装：

- `apiGet(key)` -> `GET /api/${key}`
- `apiSave(key, data)` -> `POST /api/${key}`
- `apiPost(key, data)` -> `POST /api/${key}`，会读取后端错误信息

保存函数：

- `persistNotes()`：保存 `notes`。
- `persistInfo()`：保存 `infoPanels`。
- `persistProjects(revision)`：保存 `projects`，若传入 revision，会调用 `markProjectSaved(revision)`。

## 8. TODO / 便笺模块

主要函数：

- `createNote()`：创建空便笺，渲染后聚焦标题，立即保存。
- `renderNotes()`：完整重绘便笺网格，销毁并重建所有卡片编辑器。
- `bindInlineNoteEditor(card, note)`：绑定标题 input、内容富文本编辑器、内联编辑状态和防抖保存。
- `queueInlineNotePersist(noteId)`：300ms 防抖保存。
- `persistInlineNote(noteId)`：实际写入 `notes`，更新 `updatedAt`，保存后显示“已保存”。
- `reorderNotes(fromId, toId)`：拖拽排序。
- `askDeleteNote(id)`：删除确认。
- `updateNoteSaveBadge()` / `markNoteDirty()` / `markNoteSaved()`：保存状态徽标。

便笺卡片特性：

- 标题是普通 `<input>`。
- 内容通过 `window.mountNovelProjectEditor` 挂载，隐藏 toolbar，关闭源码切换。
- `note.content` 当前保存的是编辑器返回的 HTML；历史数据可能仍是 Markdown。
- `markdownToHtml()` 在富文本编辑器内会判断内容是否像 HTML，不是 HTML 时用 `marked` 转换。
- 便笺拖拽用 HTML5 drag/drop。
- 宽度调整通过 `.note-resize-handle`，最终写入 `note.span`，最大 3 列且受当前网格列数限制。

修改入口：

- 改便笺卡片 DOM：`renderNotes()`。
- 改便笺编辑行为：`bindInlineNoteEditor()`。
- 改自动保存节奏：`queueInlineNotePersist()` 的 300ms。
- 改便笺数据结构：同时改 `createNote()`、`renderNotes()`、`normalize/兼容逻辑` 和 `server.js` 的导入合并逻辑。

## 9. 项目书架模块

项目分两层：书架视图和打开后的书本编辑视图。

主要函数：

- `normalizeProject(project)` / `normalizeProjectList(list)`：兼容和标准化项目数据。
- `renderProjects()`：渲染按首个标签分组的书架，并在有活动项目时切换到书本视图。
- `bindProjectTagDrag()`：项目标签分组拖拽排序。
- `bindProjectShelfDrag()`：项目卡片拖拽排序。
- `reorderProjectTags(fromTag, toTag)`：调整标签组顺序，本质是重排 `projects` 数组。
- `reorderProjects(fromId, toId)`：调整项目顺序。
- `openProjectEditor(id)` / `saveProject()`：添加或编辑项目标题、标签、简介。
- `askDeleteProject(id)`：删除项目。
- `openProjectBook(id)` / `closeProjectBook()`：进入或退出书本视图。
- `renderProjectBook()`：把活动项目同步到左页简介、右页编辑器和页码。
- `ensureProjectEditor()`：第一次需要时挂载项目富文本编辑器。
- `setProjectEditorMarkdown(value)`：把当前页内容写进富文本编辑器。
- `handleProjectPageInput(value)`：编辑器内容变更后写入当前 `project.pages[activeProjectPageIndex]`，标记脏并防抖保存。
- `queuePersistProjects()` / `flushProjectPersist()`：项目页内容防抖保存和立即保存。
- `switchProjectPage(index)`：切页前强制保存。
- `addProjectPage()`：新增页面。
- `reorderProjectPages(fromIndex, toIndex)`：页码拖拽排序。
- `setProjectSourceMode(nextMode)` / `toggleProjectSourceMode()`：富文本和源码 textarea 之间切换。
- `openProjectFind()` / `updateProjectFind()` / `moveProjectFind()` / `goToProjectFindResult()`：当前项目全页查找。打开查找框会清空输入；输入后只统计匹配数量，不自动切换页面；点击上/下按钮才跳到对应页面并选中匹配文本。

项目内容保存细节：

- 富文本模式下 `src/novel-project-editor.jsx` 的编辑器返回 HTML。
- 源码模式直接编辑 `#projectSourceEditor.value`，通过 `handleProjectSourceInput(value)` 写回当前页。
- 从源码模式切回富文本时，会用源码 textarea 的值调用 `setProjectEditorMarkdown(nextValue)`。
- 切页、关闭项目、离开项目页、页面卸载前会调用 `flushProjectPersist()`，避免防抖保存丢失。
- `projectSaveRevision` 用于避免旧保存请求错误地显示“已保存”。

修改入口：

- 改书架卡片或标签分组：`renderProjects()`。
- 改打开项目后的左右页布局：HTML 中 `#projectBookView` 结构和 CSS `.project-book-*`。
- 改项目编辑器 toolbar/富文本能力：`src/novel-project-editor.jsx` 的 `NovelToolbar` 和 `extensions`。
- 改项目页保存逻辑：`handleProjectPageInput()`、`queuePersistProjects()`、`persistProjects()`。
- 改项目标签建议：`showProjectTagSuggestions()`、`selectProjectTagSuggestion()`。
- 改页码拖拽：`renderProjectPageTabs()`、`bindProjectPageDrag()`、通用 `bindPointerSortable()` 的 `maxIndex` 限制、`reorderProjectPages()`。
- 改项目内查找：`#projectFindBar` 结构、CSS `.project-page-find*`、JS 中 `openProjectFind()` / `updateProjectFind()` / `moveProjectFind()` / `goToProjectFindResult()`，以及编辑器 API `selectText()`。

## 10. 常用个人信息模块

主要函数：

- `renderInfoPanels()`：按 `panel.tag || '未分类'` 分组渲染信息面板。
- `bindInfoTagDrag(group)`：信息标签组拖拽排序。
- `bindInfoPanelDrag(panelEl)`：同标签内的信息面板拖拽排序。
- `reorderInfoTags(fromTag, toTag)`：重排标签组。
- `reorderInfoPanels(fromId, toId)`：同标签内重排面板。
- `copyField(btn, text)`：复制字段原文。
- `openInfoEditor(id)` / `closeInfoEditor()`：打开和关闭信息编辑弹窗。
- `renderInfoFieldRows()`：渲染编辑弹窗中的字段行。
- `addInfoFieldRow()` / `removeInfoFieldRow(idx)`：增删字段。
- `saveInfoPanel()`：保存新增或编辑。
- `askDeleteInfo(id)`：删除确认。
- `showInfoTagSuggestions()` / `selectInfoTagSuggestion(tag)`：标签建议。

信息字段加密说明：

- `encrypted: true` 只影响前端展示，`renderInfoPanels()` 会用 `maskValue(value)` 显示同长度星号。
- 原始 `value` 仍明文保存在 `info.json`，复制按钮也复制明文。
- 如果未来要做真正加密，需要改数据模型、导入导出、前端编辑和复制逻辑。

## 11. 富文本编辑器 `src/novel-project-editor.jsx`

这个文件导出到全局 `window.mountNovelProjectEditor`，不是通过模块系统被 `index.html` 直接 import。

核心组件和函数：

- `markdownToHtml(value)`：初始内容转换。若内容像 HTML，原样使用；否则用 `window.marked.parse()` 转 HTML，最后兜底为逐行 `<p>`。
- `ToolbarButton`：toolbar 按钮。
- `ToolbarDropdown`：toolbar 下拉菜单。
- `imageAttrsToHtml(attrs)`：把上传返回的图片属性转为可插入编辑器的 `<img>` HTML。
- `NovelToolbar`：标题、正文、粗体、斜体、删除线、列表、引用、代码块、图片、源码切换、保存状态。
- Tiptap `Image` 扩展：保存 `src`、`alt`、`width`；图片通过 `handleImagePointerDown()` 支持拖拽右下角等比例调整宽度。
- `EditorReadyBridge`：拿到 novel/Tiptap editor 实例并传回外层。
- `NovelProjectEditor`：实际 `EditorRoot` / `EditorContent`。
- `mountNovelProjectEditor(el, options)`：给普通 DOM 节点挂载 React 编辑器，并返回控制 API。

`mountNovelProjectEditor` 支持的主要 options：

```js
{
  value: '',
  onChange: html => {},
  placeholder: '',
  sourceMode: false,
  onToggleSourceMode: () => {},
  showToolbar: true,
  showSourceToggle: true,
  saveStatus: { text: '', visible: false, tone: '' },
  onImageUpload: file => Promise.resolve({ src: 'projects/figures/xxx.png', alt: '图片', width: '50%' })
}
```

返回的 API：

- `setValue(nextValue)`：重建编辑器并设置内容。
- `setSourceMode(nextMode)`：更新 toolbar 状态并重建。
- `setSaveStatus(nextStatus)`：更新保存状态。
- `focus()`：聚焦 contenteditable。
- `focusEnd()`：聚焦末尾。
- `selectText(query, occurrenceIndex)`：在当前编辑器页中选中第 N 个匹配文本，用于项目全书查找。
- `destroy()`：卸载 React root 和事件监听。

注意点：

- `setValue()` 和 `setSourceMode()` 通过增加 `state.version` 触发 React key 改变，相当于重建编辑器。
- `onUpdate` 返回 `editor.getHTML()`，所以新编辑内容主要是 HTML。
- 点击编辑器空白区域时有额外逻辑把光标移动到文末。
- 粘贴图片会触发 `handlePaste`，调用 `onImageUpload(file)` 后插入图片节点。
- 图片宽度调整通过宿主节点上的 `pointerdown` 捕获完成，最终调用 `editor.commands.updateAttributes('image', { width })`。
- 如果修改 toolbar 或 extensions，记得 `npm run build:novel`。

## 12. Electron 主进程

`electron/main.js` 负责桌面能力。

窗口：

- `BrowserWindow` 宽 1480、高 940，最小 1180 x 760。
- `contextIsolation: true`，`nodeIntegration: false`。
- 预加载脚本是 `electron/preload.js`。
- 菜单被隐藏。

数据目录：

- 开发环境：`app.getAppPath()/data`。
- 打包版：先读用户目录下 `desktop-settings.json` 的 `dataDir` 和 `dataDirConfirmed`。
- 如果没有已确认且可写的数据目录，会弹窗让用户选择默认路径或其他位置。
- `saveDataDirSetting(dataDir)` 在前端通过 `/api/data-dir` 切换目录后由 server 回调调用。

IPC：

- `workweb:selectDirectory`：选择文件夹。
- `workweb:selectImportFile`：选择 `.workweb` 文件。
- `workweb:getSetting` / `workweb:setSetting`：读写白名单设置，目前只有 `wb_markdown_size`。
- `workweb:getUpdateState`
- `workweb:checkForUpdates`
- `workweb:downloadUpdate`
- `workweb:updateState`：主进程推送更新状态给前端。

自动更新：

- 使用 `electron-updater`。
- 仅支持 Windows 安装版：`app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR`。
- GitHub 仓库配置：`SeanNg997/WorkWeb`。
- 检查更新前会请求 GitHub latest release，比较版本并确认 release assets 中有 `latest.yml`。
- 下载完成后自动调用 `quitAndInstall(false, true)`。

## 13. Preload 暴露给前端的 API

`electron/preload.js` 在 `window.workwebDesktop` 上暴露：

```js
{
  selectDirectory(options),
  selectImportFile(),
  getSetting(key),
  setSetting(key, value),
  getUpdateState(),
  checkForUpdates(),
  downloadUpdate(),
  onUpdateState(callback)
}
```

前端必须始终判空，例如 `window.workwebDesktop?.selectDirectory`，因为浏览器源码版没有这些桌面能力。

## 14. 打包和发布

`package.json` 的 `build` 字段配置 Electron Builder：

- `appId`: `com.xiaoran.workweb`
- `productName`: `WorkWeb`
- 输出目录：`release`
- 打包文件包括 `electron/`、`image/`、`index.html`、`server.js`、`vendor/`、`README.md`
- Windows 图标：`image/icon.ico`
- macOS 图标：`image/icon.icns`
- Windows 发布配置指向 GitHub `SeanNg997/WorkWeb`
- Windows target：`nsis`
- macOS target：`dmg`
- Windows NSIS 和 macOS DMG 的安装包命名模板都配置为 `${productName}_Setup_${version}.${ext}`，例如 `WorkWeb_Setup_1.0.5.exe` / `WorkWeb_Setup_1.0.5.dmg`；Windows 的 `latest.yml` 会跟随 NSIS 产物名写入同样的下划线文件名。

`scripts/build-win.js` 的流程：

1. `electron-builder --win dir` 生成 `release/win-unpacked`。
2. 用 `rcedit` 修正 `WorkWeb.exe` 的图标和版本信息。
3. `electron-builder --prepackaged ... --win nsis` 生成安装包。

## 15. 常见修改任务定位

新增或修改 API：

- 后端：`server.js` 的 `createServer()` 路由分支。
- 前端：`index.html` 的 `apiGet` / `apiSave` / `apiPost` 调用处。
- 桌面文件选择能力：`electron/main.js` 注册 IPC，`electron/preload.js` 暴露方法，`index.html` 判空调用。

改便笺 UI 或行为：

- DOM 和卡片：`index.html` 的 `renderNotes()`。
- 内联编辑和保存：`bindInlineNoteEditor()`、`queueInlineNotePersist()`、`persistInlineNote()`。
- 富文本编辑器：`src/novel-project-editor.jsx`。
- 样式：`index.html` 样式区 `.note-*` 和 `.note-content-editor-host`。

改项目书架：

- 书架卡片/标签分组：`renderProjects()`。
- 项目元信息弹窗：HTML 中 `#projectEditorModal`，JS 中 `openProjectEditor()` / `saveProject()`。
- 打开后的项目页：HTML 中 `#projectBookView`，JS 中 `renderProjectBook()`。
- 项目页编辑保存：`handleProjectPageInput()`、`queuePersistProjects()`、`persistProjects()`。
- 页码拖拽：`bindProjectPageDrag()`、`reorderProjectPages()`。

改信息面板：

- 列表渲染：`renderInfoPanels()`。
- 编辑弹窗字段：`renderInfoFieldRows()`、`saveInfoPanel()`。
- 加密展示：`maskValue()` 和 `renderInfoPanels()` 中字段 HTML。
- 复制：`copyField()`。

改设置页：

- HTML：`#settingsModal`。
- 数据导入导出：前端 `exportDataFile()` / `importDataFile()`，后端 `/api/export-data` / `/api/import-data`。
- 数据目录：前端 `chooseNextDataDir()` / `changeDataDir()` / `migrateDataDir()`，后端 `/api/data-dir`，Electron `saveDataDirSetting()`。`changeDataDir()` 只负责二次确认，确认后才调用 `migrateDataDir()`。
- 回收站：前端 `openTrashRestore()` / `restoreTrashItem()` / `askClearTrash()`，后端 `/api/trash` / `/api/restore-trash` / `/api/clear-trash`。
- 更新：前端 `checkUpdateFromSettings()` / `startUpdateDownload()` / `applyUpdateState()`，Electron 自动更新相关函数。
- Markdown 字号：`MARKDOWN_FONT_SIZE_KEY`、`setMarkdownFontSize()`、CSS `body[data-markdown-size=...]`。

改主题：

- CSS 变量：`:root` 和 `body[data-theme=...]`。
- 侧边栏按钮：HTML `.theme-btn`。
- JS 白名单：`setTheme()`。

## 16. 易踩坑

- `src/novel-project-editor.jsx` 不是运行时直接加载文件，改完必须构建到 `vendor/novel-project-editor.js`。
- `index.html` 很大，业务 JS 从约 `2100` 行开始。搜索函数名比滚动阅读更快。
- 便笺和项目内容可能混有 Markdown 与 HTML。编辑器初始化会转换 Markdown，但保存后通常变成 HTML。
- `notes` / `projects` 的服务端保存是全量覆盖并按数组顺序写 `order`，不要在后端只局部改一个文件后期待前端数组自动同步。
- `info` 没有分项文件，仍是整个 `info.json`。
- 回收站列表由 `/api/trash` 递归扫描当前数据目录下的 `trash/`，如果桌面版看不到预期数据，先通过设置页或 `/api/data-dir` 确认当前数据目录。
- 信息字段“加密”不是安全加密，只是遮罩显示。
- `localStorage` 离线回退可能导致浏览器模式下出现和 `data/` 不一致的数据，排查数据问题时要确认 `serverOnline` 和 API 是否可用。
- Electron 打包版的数据目录不一定是项目内 `data/`，要通过设置页或 `/api/data-dir` 确认。
- 自动更新仅 Windows 安装版支持，macOS 会显示不支持；如果未来重新启用 portable 产物，也会按便携环境显示不支持。
- 前端很多事件处理写在 HTML `onclick` 属性中，重命名函数时要同时搜索 HTML 字符串引用。
- `renderNotes()` 会销毁并重建所有便笺编辑器，改便笺相关状态时要注意重渲染后的 DOM 和编辑器 API 是否还有效。
- `projectSourceMode` 切换会重建编辑器；避免在 `isSettingProjectEditor` 为 true 时触发保存循环。

## 17. 建议验证清单

普通前端/业务修改后：

1. `npm run server`
2. 打开 `http://127.0.0.1:3000`
3. 验证三个页面可以切换。
4. 新建/编辑/删除便笺、项目、信息面板。
5. 刷新页面后确认数据仍在。

富文本编辑器修改后：

1. `npm run build:novel`
2. `npm run server`
3. 验证便笺内联编辑和项目页编辑。
4. 验证 toolbar、源码模式、保存状态。
5. 验证图片按钮、粘贴图片、图片宽度调整，并确认图片落在数据目录 `projects/figures/`。

Electron 能力修改后：

1. `npm run desktop`
2. 验证设置页目录选择、导入导出、字号设置。
3. 检查 DevTools 或终端是否有主进程/渲染进程错误。

数据导入导出或目录迁移修改后：

1. 准备一个临时数据目录。
2. 导出 `.workweb`。
3. 导入到另一个目录。
4. 确认 `notes/`、`projects/`、`info.json` 都合并正确，重复 ID 会被重命名。
5. 更改数据目录前应出现二次确认；确认后再迁移。

回收站修改后：

1. 删除一个 TODO 和一个项目。
2. 确认数据目录 `trash/` 下出现对应 JSON，文件含 `deletedAt`。
3. 在设置页点“恢复”，确认弹窗显示标题、类型、删除时间和总数。
4. 恢复一项后确认回到原列表。
5. 清空回收站时确认有二次确认。

打包相关修改后：

1. `npm run build:novel`
2. `npm run pack:win` 或 `npm run pack:mac`
3. 验证安装包能启动，数据目录弹窗逻辑正常。
