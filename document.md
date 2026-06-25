# WorkWeb 项目维护文档

本文档用于在新的对话、机器或开发上下文中快速接手 WorkWeb。内容已按当前仓库实际状态更新。

- 当前源码版本：`2.0.3`，见 `package.json`。
- 当前主要入口：`server.js`、`index.html`、`electron/main.js`、`src/novel-project-editor.jsx`。
- 当前存储 schema：`2`，由数据目录中的 `storage-meta.json` 标记。
- 更新日期：2026-06-25。

## 1. 项目定位

WorkWeb 是一个完全本地化的个人工作面板，可作为本地 Web 服务运行，也可通过 Electron 打包成桌面应用。核心功能包括：

- TODO / 便笺：卡片式便笺，支持标题内联编辑、富文本正文、拖拽排序、卡片宽度调整、保存状态提示。
- 项目书架：按标签分组展示项目，支持项目标签和项目卡片排序。
- 项目书本视图：每个项目包含简介、标题大纲、多页内容、富文本编辑、源码模式、项目内查找、页码排序和页面删除。
- 项目页图片：支持插入和粘贴图片，图片保存到当前数据目录的 `projects/figures/`。
- 常用个人信息：按标签分组的信息面板，字段可遮罩显示，支持复制、折叠、拖拽排序。
- 设置中心：支持 Markdown 字号、AI 写作助手、数据导入导出、数据目录迁移、回收站恢复和自动更新检查。
- 数据升级：旧版数据会在前端启动时触发 schema v2 迁移，迁移前自动备份。

注意：信息字段的“加密”目前只是前端遮罩，不是真正加密。AI API Key 也会保存到桌面设置或浏览器 `localStorage`，属于本机明文配置。

## 2. 技术栈与运行方式

主要技术：

- Node.js 原生 `http` 服务：`server.js`。
- 单页前端：`index.html`，包含主样式、HTML 结构和大部分业务 JS。
- Electron 桌面壳：`electron/main.js`、`electron/preload.js`。
- React 19 + novel/Tiptap 富文本编辑器：源码在 `src/novel-project-editor.jsx`。
- Vite IIFE 构建：把富文本编辑器打包到 `vendor/novel-project-editor.js`。
- `marked`：Markdown 到 HTML 解析，静态文件在 `vendor/marked.min.js`。
- `electron-updater`：Windows 安装版自动更新。

常用 PowerShell 命令：

```powershell
npm run start        # 启动本地 server.js，并打开 http://127.0.0.1:3000
npm run server       # 只启动本地 Web 服务
npm run desktop      # Electron 开发运行
npm run build:novel  # 构建 src/novel-project-editor.jsx 到 vendor/novel-project-editor.js
npm run pack:win     # Windows NSIS 打包
npm run pack:mac     # macOS DMG 打包
```

修改 `src/novel-project-editor.jsx` 后必须运行 `npm run build:novel`，否则运行时仍加载旧的 `vendor/novel-project-editor.js`。

## 3. 目录和文件职责

```text
.
├── index.html                      # 主前端：样式、布局、业务逻辑和设置弹窗
├── server.js                       # 本地 HTTP 服务、数据读写、导入导出、迁移、AI 代理
├── package.json                    # npm 脚本、依赖、Electron Builder 配置
├── package-lock.json               # npm 锁定文件
├── README.md                       # 面向用户的简要说明
├── document.md                     # 当前维护文档
├── src/
│   └── novel-project-editor.jsx    # React/Tiptap 富文本编辑器源码
├── vendor/
│   ├── novel-project-editor.js     # 富文本编辑器 IIFE 构建产物
│   ├── marked.min.js               # Markdown 解析库
│   └── workweb.css                 # 预留样式文件，当前核心样式仍在 index.html
├── electron/
│   ├── main.js                     # Electron 主进程、窗口、数据目录、更新、IPC
│   └── preload.js                  # 暴露 window.workwebDesktop
├── scripts/
│   ├── launch.js                   # 源码版启动脚本，后台启动 server 并打开浏览器
│   └── build-win.js                # Windows 分阶段打包并修正 exe 元信息
├── build/
│   └── installer.nsh               # NSIS 安装器自定义脚本
├── data/                           # 开发默认数据目录，已被 .gitignore 忽略
├── runtime/                        # 源码启动日志目录，已被 .gitignore 忽略
├── release/                        # Electron Builder 输出目录，已被 .gitignore 忽略
├── image/                          # 图标和 README 截图
└── Start WorkWeb.*                 # 双击启动脚本
```

`.gitignore` 已忽略 `data/`、`node_modules/`、`release/`、`runtime/` 等目录。当前仓库历史上仍跟踪了部分 `node_modules` 文件，维护时不要手动改这些依赖文件。

## 4. 运行架构

源码 Web 模式：

1. `npm run start` 执行 `scripts/launch.js`。
2. 启动脚本检测 `http://127.0.0.1:3000` 是否已有服务。
3. 若无服务，后台运行 `node server.js`，日志写入 `runtime/workweb-server.log`。
4. 服务就绪后打开系统默认浏览器。

Electron 模式：

1. `electron/main.js` 在 `app.whenReady()` 后注册 IPC、配置自动更新并打开应用。
2. `ensureServer()` 调用 `startServer({ host: '127.0.0.1', port: 0 })`，使用随机可用端口。
3. 开发环境数据目录固定为项目内 `data/`。
4. 打包版先读 `desktop-settings.json`，若无已确认且可写的数据目录，则弹窗要求用户选择。
5. `BrowserWindow` 加载本地服务 URL，不直接打开 `index.html` 文件。
6. 应用使用单实例锁，第二次启动会聚焦已有窗口。
7. 退出前会关闭本地 HTTP 服务。

## 5. 数据目录与 schema v2

当前数据目录的目标布局：

```text
data/
├── storage-meta.json
├── info.json
├── notes/
│   └── {noteId}.json
├── projects/
│   ├── figures/
│   │   └── {imageFile}
│   └── items/
│       └── {projectId}/
│           ├── project.json
│           └── pages/
│               └── {pageId}.json
├── trash/
│   ├── notes/
│   └── projects/
└── backups/
    └── pre-schema-v2-{timestamp}/
```

重要规则：

- `storage-meta.json` 写入 `schemaVersion: 2`，表示已经升级到按项/按页存储。
- `notes/` 是一条便笺一个 JSON 文件。
- `projects/items/{projectId}/project.json` 保存项目元信息和 `pageOrder`。
- `projects/items/{projectId}/pages/{pageId}.json` 保存单页内容、顺序和 revision。
- `info.json` 仍是一个数组文件，没有拆分成单项文件。
- `projects/figures/` 保存项目页图片，正文中使用 `projects/figures/...` 相对路径。
- 删除便笺或项目会进入 `trash/notes` 或 `trash/projects`，并写入 `deletedAt`。
- 旧数据迁移前会复制到 `backups/pre-schema-v2-*`。

旧版兼容：

- 旧的 `notes.json`、`projects.json`、`projects/*.json` 和早期分项数据会被识别为需要迁移。
- 前端启动时先调用 `/api/storage-status`，必要时调用 `/api/storage-migrate`。
- 迁移过程会显示 `#storageMigrationModal`，轮询迁移进度。
- 迁移完成后会清理旧格式文件，并写入新的 `storage-meta.json`。

## 6. 后端服务 `server.js`

核心常量：

- `DEFAULT_PORT`：默认 `3000`，可由 `WORKWEB_PORT` 覆盖。
- `DEFAULT_HOST`：默认 `127.0.0.1`，可由 `WORKWEB_HOST` 覆盖。
- `DEFAULT_DATA_DIR`：默认项目内 `data/`，可由 `WORKWEB_DATA_DIR` 覆盖。
- `STORAGE_SCHEMA_VERSION`：当前为 `2`。
- `EXPORT_FILE_NAME`：`WorkWeb_data.workweb`。
- `PROJECT_ITEMS_DIR`：`projects/items`。
- `FIGURES_DIR`：`projects/figures`。
- `AI_REQUEST_TIMEOUT_MS`：AI 代理请求超时 15 秒。

主要数据函数：

- `initializeData(dataDir)`：检查存储结构，必要时准备迁移状态。
- `inspectStorage(dataDir)`：判断 schema、旧数据和迁移需求。
- `runStorageMigration(context)`：备份旧数据并升级到 schema v2。
- `readNotes()` / `writeNote()`：读取和单项保存便笺。
- `readProject()` / `saveProjectMeta()` / `saveProjectPage()`：读取项目、保存项目元信息、保存单页内容。
- `writeCollection()`：兼容旧的全量保存接口；项目会写入 schema v2 目录。
- `updateCollectionOrder()`：只更新 notes 或 projects 的顺序。
- `moveNoteToTrash()` / `moveProjectToTrash()`：移动删除项到回收站。
- `createDataExport()` / `importDataExport()`：导出和导入 `.workweb`。
- `mergeDataDirs()`：更改数据目录时合并旧目录到新目录。
- `saveProjectFigure()`：保存上传或粘贴图片。
- `buildAIRequestPayload()`：按 OpenAI 或 Anthropic 协议构造请求体。

当前 API 路由：

```text
GET    /api/version
GET    /api/storage-status
POST   /api/storage-migrate
GET    /api/data-dir
POST   /api/data-dir
POST   /api/export-data
POST   /api/import-data

GET    /api/notes
POST   /api/notes
POST   /api/notes/order
PUT    /api/notes/:id
DELETE /api/notes/:id

GET    /api/info
POST   /api/info

GET    /api/projects
POST   /api/projects
POST   /api/projects/order
PUT    /api/projects/:id
DELETE /api/projects/:id
PUT    /api/projects/:projectId/pages/:pageId

POST   /api/project-figures
GET    /api/trash
POST   /api/restore-trash
POST   /api/clear-trash
POST   /api/ai/complete

GET    /projects/figures/...
```

并发和冲突：

- 便笺、项目元信息和项目页都带 `revision`。
- 前端保存时传 `baseRevision`。
- 后端检测到 revision 不一致会抛 `ConflictError` 并返回 `409`。
- 前端收到 `409` 后显示“保存冲突”，不会继续覆盖。

安全和边界：

- 静态文件路径会限制在项目根目录内。
- 图片静态路径必须位于当前数据目录的 `projects/figures/`。
- 导入数据时会拒绝绝对路径和包含 `..` 的相对路径。
- AI 代理只转发到用户配置的 `baseUrl`，不在服务端保存 API Key。

## 7. 数据模型

便笺 `note`：

```js
{
  id: 'n_...',
  title: '',
  content: '',       // 通常是 HTML，历史数据可能是 Markdown
  span: 1,           // 卡片宽度，1 到 3
  createdAt: 0,
  updatedAt: 0,
  order: 0,
  revision: 0
}
```

项目 API 返回的 `project`：

```js
{
  id: 'p_...',
  title: '',
  summary: '',
  tags: ['标签'],
  pages: [''],           // 页面内容数组，通常是 HTML
  pageIds: ['pg_...'],   // 与 pages 一一对应
  pageRevisions: {
    'pg_...': 0
  },
  createdAt: 0,
  updatedAt: 0,
  order: 0,
  revision: 0
}
```

项目元信息文件 `project.json`：

```js
{
  id: 'p_...',
  title: '',
  summary: '',
  tags: [],
  pageOrder: ['pg_...'],
  createdAt: 0,
  updatedAt: 0,
  order: 0,
  revision: 0
}
```

项目页文件 `pages/{pageId}.json`：

```js
{
  id: 'pg_...',
  projectId: 'p_...',
  content: '',
  createdAt: 0,
  updatedAt: 0,
  order: 0,
  revision: 0
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

离线回退：

- `loadData()` 访问 API 失败时从 `localStorage` 读取 `wb_notes`、`wb_info`、`wb_projects`。
- 保存失败时也会临时写入这些 `localStorage` key。
- 主题保存在 `wb_theme`。
- 侧边栏折叠状态保存在 `wb_sidebar_collapsed`。
- Markdown 字号和 AI 设置优先写桌面设置，同时也写 `localStorage`。

## 8. 前端主文件 `index.html`

`index.html` 分为三块：

1. `<style>`：主题变量、窗口标题栏、侧边栏、便笺、项目书架、书本视图、富文本编辑器、信息面板、设置页、迁移和更新弹窗。
2. `<body>`：侧边栏、三个页面、编辑弹窗、设置弹窗、回收站、更新弹窗、存储迁移弹窗、确认框和 toast。
3. `<script>`：API 封装、全局状态、渲染函数、拖拽、保存、快捷键和桌面桥接。

页面结构：

- `#page-todo`：TODO / 便笺页面，主体是 `#notesGrid`。
- `#page-progress`：项目书架与书本编辑页面。
- `#page-info`：常用个人信息页面。
- `#settingsModal`：Markdown 字号、AI 写作助手、数据文件、数据目录、更新。
- `#storageMigrationModal`：schema 迁移进度。
- `#trashRestoreModal`：回收站恢复列表。
- `#updateModal` 和 `#updateToast`：自动更新状态。

初始化流程在 `DOMContentLoaded`：

1. `loadTheme()`
2. `loadSidebarState()`
3. `initWindowControls()`
4. `loadMarkdownFontSize()`
5. `loadAISettings()`
6. 绑定 `window.workwebDesktop.onUpdateState`
7. `loadAppVersion()`
8. `ensureStorageReady()`
9. `loadData()`
10. `renderNotes()` / `renderProjects()` / `renderInfoPanels()`
11. `applyProjectEditorMode()` / `applyAIConfig()`
12. 绑定项目大纲 resizer 和交互
13. `updateDateDisplay()` 并每分钟更新

API 封装：

- `apiGet(key)`
- `apiPost(key, data)`
- `apiPut(key, data)`
- `apiDelete(key)`

当前保存策略：

- 便笺编辑使用 `PUT /api/notes/:id` 单项保存，300ms 防抖。
- 便笺排序使用 `POST /api/notes/order`。
- 项目元信息使用 `PUT /api/projects/:id`。
- 项目页内容使用 `PUT /api/projects/:projectId/pages/:pageId`，260ms 防抖。
- 项目排序使用 `POST /api/projects/order`。
- 信息面板仍使用 `POST /api/info` 全量保存。
- 旧的 `POST /api/notes` 和 `POST /api/projects` 仍保留，用于兼容全量保存。

## 9. TODO / 便笺模块

主要函数：

- `createNote()`：创建空便笺并聚焦标题。
- `renderNotes()`：完整重绘便笺网格，销毁并重建富文本编辑器。
- `bindInlineNoteEditor(card, note)`：绑定标题 input、内容编辑器、内联编辑状态和保存。
- `queueInlineNotePersist(noteId)`：300ms 防抖保存。
- `persistInlineNote(noteId)`：更新 `updatedAt` 并调用 `persistNote()`。
- `persistNote(noteId)`：通过 `PUT /api/notes/:id` 保存单项。
- `persistNoteOrder()`：保存排序。
- `deleteNoteRemote(noteId)`：通过 DELETE 进入回收站。
- `markNoteDirty()` / `markNoteSaved()`：保存状态徽标。

便笺特性：

- 标题是普通 `<input>`。
- 正文通过 `window.mountNovelProjectEditor` 挂载，隐藏 toolbar，禁用源码切换和 AI。
- 正文保存为 HTML；历史 Markdown 会在编辑器初始化时转成 HTML。
- 卡片拖拽排序仍使用 HTML5 drag/drop。
- 卡片宽度通过右侧 resize handle 调整，最终写入 `span`。

修改入口：

- 卡片 DOM：`renderNotes()`。
- 编辑和保存行为：`bindInlineNoteEditor()`、`queueInlineNotePersist()`、`persistInlineNote()`。
- 宽度调整：`renderNotes()` 中的 resize handle 逻辑。
- 保存 API：`persistNote()`、`server.js` 的 `writeNote()`。

## 10. 项目书架与书本视图

项目模块包含两个层级：

- 书架视图：按首个标签分组展示项目卡片。
- 书本视图：左页项目标题、简介和标题大纲；右页富文本编辑器和页码。

主要函数：

- `normalizeProject()` / `normalizeProjectList()`：兼容旧数据并补齐 `pageIds`、`pageRevisions`。
- `renderProjects()`：渲染书架和书本视图。
- `bindProjectTagDrag()`：项目标签组拖拽排序。
- `bindProjectShelfDrag()`：项目卡片排序。
- `persistProjectOrder()`：保存项目顺序。
- `openProjectEditor()` / `saveProject()`：新增或编辑项目元信息。
- `askDeleteProject()`：删除项目到回收站。
- `openProjectBook()` / `closeProjectBook()`：进入或退出书本视图。
- `renderProjectBook()`：同步左页标题、简介、大纲、右页内容和页码。
- `ensureProjectEditor()`：挂载富文本编辑器。
- `handleProjectPageInput()`：写回当前页内容、更新大纲、防抖保存。
- `queuePersistProjects()` / `flushProjectPersist()`：项目页保存。
- `persistProjectPageByIndex()`：单页 PUT 保存。
- `switchProjectPage()`：切页前 flush 当前页。
- `addProjectPage()`：新增页面并持久化项目元信息。
- `deleteProjectPage()`：删除页面；如果只剩一页，则清空而不是移除最后一页。
- `reorderProjectPages()`：重排页面，同时重排 `pageIds`。

标题大纲：

- `getProjectOutlineItems()` 从每页 HTML 或 Markdown 中提取 `h1` 到 `h4`。
- `renderProjectOutline()` 渲染左侧大纲。
- 大纲支持层级折叠，折叠状态在内存的 `projectOutlineCollapsedKeys` 中。
- 点击大纲会切到对应页面并滚动到标题。
- `bindProjectOutlineResizer()` 可拖动调整项目简介和大纲区域高度。

项目内查找：

- `openProjectFind()` 只在打开项目时有效。
- 查找基于每页文本内容，输入后统计全部匹配数量。
- 点击上/下按钮时才跳转并选中对应匹配。
- 源码模式下使用 textarea selection；富文本模式下调用编辑器 API `selectText()`。

页码操作：

- 页码由 `renderProjectPageTabs()` 渲染。
- `bindProjectPageDrag()` 使用通用 `bindPointerSortable()`。
- 页码拖拽可重排；拖到删除区会触发删除确认。
- 新增按钮始终在页码末尾，拖拽插入位置会受 `maxIndex` 限制。

图片上传：

- `uploadProjectImage(file)` 把图片读成 data URL，调用 `POST /api/project-figures`。
- 后端保存到 `projects/figures/`，返回相对路径。
- 如果图片宽度超过编辑器宽度的一半，默认插入 `width: 50%`。

修改入口：

- 书架卡片和标签组：`renderProjects()`。
- 项目元信息弹窗：`#projectEditorModal`、`openProjectEditor()`、`saveProject()`。
- 书本左右页布局：`#projectBookView` 结构和 `.project-book-*` 样式。
- 标题大纲：`getProjectOutlineItems()`、`renderProjectOutline()`、`jumpToProjectOutlineHeading()`。
- 页码新增/删除/排序：`renderProjectPageTabs()`、`bindProjectPageDrag()`、`addProjectPage()`、`deleteProjectPage()`、`reorderProjectPages()`。
- 项目保存：`persistProject()`、`persistProjectPageByIndex()`、`server.js` 的 `saveProjectMeta()`、`saveProjectPage()`。

## 11. 常用个人信息模块

主要函数：

- `renderInfoPanels()`：按 `panel.tag || '未分类'` 分组渲染。
- `bindInfoTagDrag()`：标签组拖拽排序。
- `bindInfoPanelDrag()`：同标签内面板拖拽排序。
- `reorderInfoTags()`：重排标签组。
- `reorderInfoPanels()`：重排同标签内面板。
- `copyField()`：复制字段原文。
- `openInfoEditor()` / `closeInfoEditor()`：打开和关闭编辑弹窗。
- `renderInfoFieldRows()`：渲染字段行。
- `addInfoFieldRow()` / `removeInfoFieldRow()`：增删字段。
- `saveInfoPanel()`：保存新增或编辑。
- `askDeleteInfo()`：删除面板。
- `showInfoTagSuggestions()` / `selectInfoTagSuggestion()`：标签建议。

注意：

- `encrypted: true` 只控制前端展示为星号。
- 复制按钮复制原始明文。
- `info.json` 不做 revision 冲突检测，目前是全量覆盖。

## 12. 富文本编辑器 `src/novel-project-editor.jsx`

该文件构建后暴露全局函数：

```js
window.mountNovelProjectEditor(el, options)
```

核心能力：

- Markdown 初始内容转 HTML。
- Tiptap/novel 编辑器。
- 标题 H1-H4、正文、加粗、斜体、下划线、删除线、列表、引用、代码块。
- 图片插入、粘贴图片、图片右下角拖拽调整宽度。
- 源码模式按钮。
- 保存状态展示。
- AI 自动补全。
- 文本查找选中 API。

`mountNovelProjectEditor()` 主要 options：

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
  onImageUpload: file => Promise.resolve({ src: 'projects/figures/xxx.png', alt: '图片', width: '50%' }),
  aiConfig: {
    enabled: false,
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    projectTitle: '',
    projectSummary: ''
  },
  onAIToggle: config => {}
}
```

返回 API：

- `setValue(nextValue)`
- `setSourceMode(nextMode)`
- `setSaveStatus(nextStatus)`
- `setAIConfig(nextConfig)`
- `focus()`
- `focusEnd()`
- `selectText(query, occurrenceIndex)`
- `destroy()`

AI 自动补全：

- 由 `createAICompletionExtension()` 实现。
- 输入后 500ms 防抖请求 `/api/ai/complete`。
- 上下文窗口为光标前后各 600 字符。
- 提示词定位为科研项目笔记的行内补全。
- ghost text 显示在光标后。
- `Tab` 接受补全，`Escape` 清除补全。
- 工具栏“自动补全”按钮只切换全局 AI enabled 状态。
- 便笺编辑器传入 `enabled: false`，当前 AI 主要用于项目页编辑器。

如果修改 toolbar、extensions、AI 或图片能力，必须运行：

```powershell
npm run build:novel
```

## 13. AI 写作助手

前端设置入口：

- `#settingsModal` 中的“AI 写作助手”。
- 支持 `openai` 和 `anthropic` 协议。
- 字段包括 Base URL、API Key、Model ID。
- `testAIConnection()` 通过 `/api/ai/complete` 发送测试请求。

配置存储：

- 桌面版通过 `window.workwebDesktop.getSetting/setSetting` 保存。
- 浏览器源码版回退到 `localStorage`。
- 允许保存的 key 在 `electron/main.js` 的 `ALLOWED_DESKTOP_SETTING_KEYS` 中。

服务端代理：

- 路由：`POST /api/ai/complete`。
- OpenAI 协议请求 `{baseUrl}/v1/chat/completions`。
- Anthropic 协议请求 `{baseUrl without /v1}/v1/messages`。
- 返回统一为 `{ text }`。
- 请求超时 15 秒。

风险点：

- API Key 当前是本机明文保存。
- 服务端不限制 Base URL，使用者配置错误会直接导致请求失败。
- AI 只做行内补全，不做事实校验。

## 14. Electron 主进程与 preload

`electron/main.js` 负责：

- 创建隐藏标题栏窗口，Windows 下使用自定义窗口控制按钮。
- 计算窗口尺寸并限制在当前工作区内。
- 选择、确认和保存数据目录。
- 启动本地 HTTP 服务并加载 URL。
- 单实例锁和退出前关闭本地服务。
- 自动更新检查、下载和状态推送。
- 白名单桌面设置读写。

`electron/preload.js` 暴露：

```js
window.workwebDesktop = {
  platform,
  minimizeWindow(),
  toggleMaximizeWindow(),
  closeWindow(),
  isWindowMaximized(),
  onWindowMaximized(callback),
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

前端调用桌面能力时必须判空，因为普通浏览器模式没有这些 API。

## 15. 打包和发布

`package.json` 的 Electron Builder 配置：

- `appId`: `com.xiaoran.workweb`
- `productName`: `WorkWeb`
- 输出目录：`release`
- 打包文件包括 `electron/`、`image/`、`index.html`、`server.js`、`vendor/`、`README.md`
- Windows 图标：`image/icon.ico`
- macOS 图标：`image/icon.icns`
- Windows target：`nsis`
- macOS target：`dmg`
- 安装包命名：`${productName}_Setup_${version}.${ext}`
- Windows 发布配置指向 GitHub `SeanNg997/WorkWeb`

`scripts/build-win.js` 流程：

1. `electron-builder --win dir --publish never` 生成 `release/win-unpacked`。
2. 使用 `rcedit` 修正 `WorkWeb.exe` 图标、版本号和版本字符串。
3. `electron-builder --prepackaged release/win-unpacked --win nsis --publish never` 生成安装包。

自动更新：

- 仅支持 Windows 安装版。
- 便携环境和 macOS 会显示不支持。
- 检查更新前会请求 GitHub latest release，确认版本和 `latest.yml`。
- 下载完成后调用 `quitAndInstall(false, true)`。

## 16. 常见修改任务定位

新增或修改 API：

- 后端：`server.js` 的 `createServer()` 路由分支。
- 前端：`apiGet` / `apiPost` / `apiPut` / `apiDelete` 调用处。
- 桌面 IPC：`electron/main.js` 注册 handler，`electron/preload.js` 暴露方法，`index.html` 判空调用。

改便笺：

- DOM：`renderNotes()`。
- 自动保存：`queueInlineNotePersist()`、`persistInlineNote()`、`persistNote()`。
- 卡片宽度：`renderNotes()` 中的 resize handle。
- 后端：`writeNote()`、`moveNoteToTrash()`、`updateCollectionOrder()`。

改项目：

- 书架：`renderProjects()`、`bindProjectShelfDrag()`、`bindProjectTagDrag()`。
- 项目元信息：`openProjectEditor()`、`saveProject()`、`saveProjectMeta()`。
- 项目页内容：`handleProjectPageInput()`、`queuePersistProjects()`、`persistProjectPageByIndex()`、`saveProjectPage()`。
- 页面管理：`addProjectPage()`、`deleteProjectPage()`、`reorderProjectPages()`。
- 标题大纲：`getProjectOutlineItems()`、`renderProjectOutline()`、`scrollProjectEditorToHeading()`。
- 查找：`openProjectFind()`、`updateProjectFind()`、`moveProjectFind()`、`goToProjectFindResult()`。
- 图片：`uploadProjectImage()`、`saveProjectFigure()`。
- 富文本能力：`src/novel-project-editor.jsx`。

改信息面板：

- 列表渲染：`renderInfoPanels()`。
- 编辑弹窗：`renderInfoFieldRows()`、`saveInfoPanel()`。
- 遮罩显示：`maskValue()` 和字段 HTML。
- 拖拽排序：`bindInfoTagDrag()`、`bindInfoPanelDrag()`。

改设置页：

- Markdown 字号：`MARKDOWN_FONT_SIZE_KEY`、`setMarkdownFontSize()`、CSS `body[data-markdown-size=...]`。
- AI 设置：`loadAISettings()`、`saveAISettings()`、`getAIConfig()`、`testAIConnection()`。
- 数据导入导出：`exportDataFile()`、`importDataFile()`、`createDataExport()`、`importDataExport()`。
- 数据目录：`chooseNextDataDir()`、`changeDataDir()`、`migrateDataDir()`、`mergeDataDirs()`。
- 回收站：`openTrashRestore()`、`restoreTrashItem()`、`askClearTrash()`、`listTrash()`。
- 更新：`checkUpdateFromSettings()`、`startUpdateDownload()`、`configureAutoUpdater()`。

改存储迁移：

- 检测：`inspectStorage()`。
- 状态接口：`/api/storage-status`。
- 迁移入口：`/api/storage-migrate`、`runStorageMigration()`。
- 迁移进度 UI：`ensureStorageReady()`、`renderStorageMigrationProgress()`、`#storageMigrationModal`。

## 17. 易踩坑

- `src/novel-project-editor.jsx` 不是运行时直接加载文件，改完必须构建到 `vendor/novel-project-editor.js`。
- 项目内容现在是元信息和页面分文件保存，不要再按旧的 `projects/{id}.json` 判断当前结构。
- `projects/` 下仍可能出现旧文件，schema 迁移前后都要区分 `projects/items/` 和旧格式。
- `notes` 和 `projects` 都有 revision，单项保存时要传 `baseRevision`。
- `info` 没有 revision，仍是全量保存。
- 项目页删除最后一页时只会清空内容，保持至少一页。
- `flushProjectPersist()` 是异步触发但调用处不等待 Promise，排查极端保存问题时要关注这个点。
- AI API Key 是明文偏好设置，不要把真实 key 写进仓库或截图。
- 自动更新只支持 Windows 安装版，并要求 release assets 有 `latest.yml`。
- 前端很多事件仍写在 HTML `onclick` 字符串中，重命名函数必须搜索字符串引用。
- 回收站恢复依赖回收站 JSON 的内容和路径推断，改数据模型时要同步改 `inferTrashCollection()`。
- 旧版导入和目录迁移会合并数据，不是直接覆盖；重复 ID 会按 `updatedAt` 或唯一文件名策略处理。
- 浏览器离线回退可能让 `localStorage` 与数据目录不一致，排查时先确认 `serverOnline`。

## 18. 建议验证清单

仅改文档：

```powershell
git diff -- document.md
```

普通前端或业务修改：

```powershell
npm run server
```

然后打开 `http://127.0.0.1:3000`，验证：

- 三个页面可以切换。
- 便笺新增、编辑、调整宽度、拖拽排序、删除和恢复正常。
- 项目新增、编辑、打开、切页、排序、删除页面、项目内查找正常。
- 信息面板新增、编辑、复制、遮罩、拖拽排序正常。
- 刷新页面后数据仍在。

富文本编辑器修改：

```powershell
npm run build:novel
npm run server
```

重点验证：

- 便笺内联编辑。
- 项目页 toolbar、源码模式、保存状态。
- 图片按钮、粘贴图片、图片宽度调整。
- AI 自动补全开关、ghost text、Tab 接受、Escape 清除。

Electron 能力修改：

```powershell
npm run desktop
```

重点验证：

- 首次启动数据目录选择。
- 设置页目录选择、导入导出、字号、AI 设置。
- Windows 自定义窗口按钮。
- 自动更新状态在不支持环境下提示正确。

存储迁移修改：

1. 准备旧格式数据目录。
2. 启动应用并确认出现迁移进度。
3. 确认生成 `backups/pre-schema-v2-*`。
4. 确认 `storage-meta.json` 写入 schema v2。
5. 确认 notes、projects、pages、info 均可读取。

打包修改：

```powershell
npm run build:novel
npm run pack:win
```

验证安装包能启动、数据目录弹窗逻辑正常、版本号和图标正确。
