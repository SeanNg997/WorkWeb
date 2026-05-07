# WorkWeb 代码审查报告

> 审查日期：2026-05-07  
> 审查范围：项目全部代码（不包含 `node_modules`、`vendor` 中第三方构建产物、`data` 数据目录）  
> 审查原则：仅发现问题，不修改代码

---

## 1. 项目概况

| 项目 | 详情 |
|------|------|
| 名称 | WorkWeb |
| 描述 | 本地个人工作面板桌面应用 |
| 技术栈 | Node.js + Electron + React (TipTap 编辑器) |
| 核心文件 | `index.html` (6265行), `server.js` (807行), `electron/main.js` (611行), `src/novel-project-editor.jsx` (817行) |

---

## 2. 严重问题 (Critical)

### 2.1 巨型单体文件 — `index.html` 6265 行

`index.html` 将 CSS（~2000行）、HTML（~500行）、JavaScript（~3500行）全部揉在一个文件中。

**症状：**
- 没有任何模块化，所有前端逻辑暴露在全局作用域
- 代码导航困难，定位一个函数需要翻几百行
- 无法单独测试任何组件
- 修改样式可能意外影响无关区域

**建议拆分为：**
```
src/
  styles/
    base.css
    themes.css
    components.css
  js/
    api.js          # 数据层
    notes.js        # 便笺模块
    projects.js     # 项目书架模块
    info.js         # 个人信息模块
    drag.js         # 拖拽排序通用逻辑
    ui.js           # 通用 UI 工具
    app.js          # 入口/初始化
```

---

### 2.2 server.js 中请求体解析存在两套完全不同实现

`server.js` 定义了干净的 `readRequestBody(req)` 函数（第53行），但以下4个路由却**手动内联解析**请求体，完全绕过了已有函数：

| 路由 | 位置 | 解析方式 |
|------|------|----------|
| `POST /api/notes` | :537-548 | 手动 `req.on('data',...)` |
| `POST /api/info` | :558-572 | 手动 `req.on('data',...)` |
| `POST /api/projects` | :580-594 | 手动 `req.on('data',...)` |
| `POST /api/notes` (另一处) | :536 | 同上 |

其他路由（`data-dir`, `export-data`, `import-data`, `project-figures`, `trash`, `restore-trash`, `ai/complete`）正确使用了 `readRequestBody`。
另外 `POST /api/notes` 在内联解析中没有处理 `error` 事件。

**风险：** 一处有 bug 手动复制到多处；错误处理不一致。

---

### 2.3 全局变量极度泛滥

`index.html` 在顶层声明了 **50+ 个全局变量**：

```javascript
let notes = [];           // :2943
let infoPanels = [];      // :2944
let projects = [];        // :2945
let serverOnline = false; // :2946
let currentAppVersion = ''; // :2947
// ... 还有 editingNoteId, editingInfoId, editingProjectId,
//     pendingAction, draggedId, noteEditors, noteDraftTimers,
//     noteSaveStates, activeProjectId, activeProjectPageIndex,
//     projectEditor, projectSourceMode, 等等共 50+ 个
```

这些变量在 3500 行 JS 中处处可读写，任何函数都可能意外修改任何变量。调试成本极高。

---

## 3. 重复代码 (Duplication)

### 3.1 HTML5 拖拽排序代码复制了 5 次

以下 5 处拖拽实现使用了**完全相同的模板代码**（dragCounter 模式、`classList.toggle('dragging')`、`e.dataTransfer.effectAllowed = 'move'`）：

| 位置 | 功能 |
|------|------|
| `bindNoteDrag` → `renderNotes()` :4273-4303 | 便笺排序 |
| `bindProjectTagDrag()` :4574-4643 | 项目标签排序 |
| `bindInfoTagDrag()` :5833-5877 | 信息标签排序 |
| `bindInfoPanelDrag()` :5880-5931 | 信息面板排序 |
| `bindProjectShelfDrag()` :4645-4759 | 项目卡片排序（用 pointer 实现） |

**影响：** 如果发现一个拖拽 bug，需要在 5 处修复。`bindPointerSortable` 已经是一个通用函数，但项目卡片拖拽却重新手写了一套。

**建议：** 统一使用 `bindPointerSortable` 或抽象出统一的拖拽工具。

---

### 3.2 分组 + 标签排序算法重复 4 次

完全相同的"按标签分组并保留顺序"逻辑：

| 函数 | 位置 |
|------|------|
| `renderProjects()` | :4517-4526 |
| `reorderProjectTags()` | :4762-4771 |
| `renderInfoPanels()` | :5767-5776 |
| `reorderInfoTags()` | :5938-5947 |

每次都是 `const groups = {}; const tagOrder = []; items.forEach(item => { const tag = ...; if (!groups[tag]) { groups[tag] = []; tagOrder.push(tag); } groups[tag].push(item); });`

**建议：** 抽取 `groupByTag(items, getTagFn)` 工具函数。

---

### 3.3 保存状态徽章管理代码完全对称

便笺和项目的保存状态管理使用了**完全对称**的实现，但分别独立写出：

| 便笺 | 项目 | 功能 |
|------|------|------|
| `setNoteSaveBadge()` | `syncProjectSaveStatus()` | 更新 UI |
| `markNoteDirty()` | `markProjectDirty()` | 标记脏 |
| `markNoteSaved()` | `markProjectSaved()` | 标记已保存 |
| `noteSaveHideTimer` | `projectSaveHideTimer` | 定时隐藏 |

**建议：** 抽出一个通用的 `SaveStatusManager` 类。

---

### 3.4 工具函数跨文件重复

| 函数 | `server.js` | `electron/main.js` |
|------|-------------|-------------------|
| `ensureDir()` | :21-24 | :42-45 |
| `normalizeVersion()` | 通过 `readPackageVersion` 间接 | :108-110 |

---

### 3.5 `escHtml` 和 `escAttr` 实现风格不一致

- `escHtml` 使用 DOM 元素 `textContent` 赋值 (`:3471-3474`)
- `escAttr` 使用正则替换 (`:3476-3483`)

`escHtml` 创建 DOM 元素的方式每次调用都产生 GC 压力，高频调用时效率低。`escAttr` 的正则方式更适合高频场景。两者应该统一实现风格。

---

## 4. 废弃/无用代码 (Dead Code)

### 4.1 `.note-content` 富文本渲染样式已失效

`index.html` :896-912 定义的 `.note-content h1`、`.note-content h2`…`.note-content table` 等样式已经**永远不会匹配到任何元素**。

原因：便笺内容现在由 TipTap 编辑器渲染在 `.novel-project-editor-prose` 内部，而非 `.note-content` 的直接子元素。这些样式是针对旧版 `marked.parse()` 渲染的静态 HTML，属于遗留代码。实际生效的是 `note-content-editor-host` 下的样式。

---

### 4.2 `void tick` 抑制 lint 警告

`src/novel-project-editor.jsx` :343：
```javascript
void tick;
```
使用了 `useSyncExternalStore` 的返回值仅为了触发重渲染，但用 `void` 抑制未使用变量警告。这掩盖了代码意图（应该用注释说明何以需要 subscribe），且如果 store 未来返回更复杂的数据类型可能遗漏同步。

---

### 4.3 便笺模态编辑框功能已废弃

`index.html` 中仍有完整的便笺模态编辑框 HTML 结构 (:2695-2717) 和对应的 JS 函数 `openNoteEditor()`、`closeNoteEditor()`、`saveNote()` (:4404-4457)。但目前的 `createNote()` 直接创建卡片并进入内联编辑模式，模态编辑框从未被调用。

**确认：** `openNoteEditor` 在整个代码中没有任何调用点（`createNote` 直接调用 `focusNote`，没有触达模态框路径）。

---

### 4.4 unused `isModalContentEmpty` 函数

`:4077-4093` 定义的 `isModalContentEmpty` 仅在遮罩点击事件中使用，其内部通过硬编码判断不同模态框的内容是否为空。三个分支判断都耦合了具体字段名，扩展性差。

---

## 5. 低效实现

### 5.1 server.js 路由使用 if 链

`:467-745` 处，所有路由匹配通过 **连续 20 个 `if` 语句** 实现，每个请求都要走过大半条链：

```
if (pathname === '/api/version' && req.method === 'GET')  → 检查
if (pathname === '/api/data-dir' && req.method === 'GET') → 检查
if (pathname === '/api/data-dir' && req.method === 'POST') → 检查
... 20 个 if 之后 ...
```

**建议：** 使用路由表或 Map 结构。最少也应将静态文件服务 (`:739-768`) 放在最后（目前它不在最末，而是在 AI 路由之后）。

---

### 5.2 全量 DOM 重建

每次数据变更时，以下函数 **销毁并重建全部 DOM**：

| 函数 | 操作 |
|------|------|
| `renderNotes()` | `destroyNoteEditors()` + `grid.innerHTML = ''` + 重建所有卡片 |
| `renderProjects()` | 重建整个 `projectShelf` HTML |
| `renderInfoPanels()` | `container.innerHTML = ''` + 重建所有分组和面板 |
| `renderInfoFieldRows()` | `container.innerHTML = ''` + 每次输入都重建所有行 |

特别是 `renderInfoFieldRows`，每次 keystroke 都销毁重建所有字段行 DOM，效率极差。

---

### 5.3 重复 Array.find() 查询

`getProjectById()` 每次调用都执行 `Array.find()`。在频繁操作（如编辑器每次输入触发 `handleProjectPageInput`）中，同一个项目的查询被重复多次。

**建议：** 维护一个 `Map<id, project>` 索引。

---

### 5.4 `getSortableInsertionIndex` 在 pointermove 中频繁调用

拖拽移动时每次 `pointermove` 都会调用此函数，内部每次都重新 `querySelectorAll` 查询 items 并执行 `getBoundingClientRect()` 重排。建议缓存 items 列表和只更新坐标。

---

### 5.5 硬编码重试延时链

`PROJECT_EDITOR_SCROLL_RETRY_DELAYS` (:3150) 定义了 8 级延时 `[0, 80, 180, 320, 520, 800, 1200, 1700]`，并通过递归 timeout 实现"等编辑器渲染完再滚动"的效果。

这种方式极度脆弱：如果编辑器加载比预想慢（大文件）或快（小文件），要么跳转失败要么白等。应该使用事件驱动（编辑器提供 `onReady` 回调）或 MutationObserver。

---

### 5.6 主题 CSS 变量全部重复定义

4 套主题 (`sage`, `sand`, `blue`, `stone`) 各定义了 **42 个 CSS 变量** (:22-152)。每套主题的变量结构完全相同，只是颜色值不同。

**建议：** 主题只定义颜色 token（`--primary`, `--bg`, `--text` 等），其余样式通过语义变量引用。

---

## 6. 安全隐患

### 6.1 API Key 明文存储

`:3348-3353` — 用户的 AI API Key 以明文存储在 `localStorage`（浏览器端）和磁盘的 `desktop-settings.json`（Electron 端）。即使使用 `type="password"` 输入，存储后任何能访问该文件的进程都可读取。

**建议：** 使用操作系统的凭据管理器（如 Windows Credential Store / macOS Keychain）。

---

### 6.2 CORS 配置过于宽松

`server.js` :455：`Access-Control-Allow-Origin: *` — 虽然是本地工具，但如果有其他本地进程发起请求可能造成问题。

---

### 6.3 无请求体大小限制

`readRequestBody` 没有任何 body size 限制，可以发送 GB 级数据导致服务器内存溢出。

---

### 6.4 服务器直接转发 AI 请求

`/api/ai/complete` (:630-711) 将用户的 AI 凭证无条件转发给第三方，没有请求频率限制。如果一个恶意脚本反复调用，会消耗用户的 API 配额。

---

## 7. 代码风格/结构问题

### 7.1 Magic Numbers 散落各处

| 值 | 含义 | 出现位置 |
|----|------|----------|
| 300 | debounce 延迟 | `launch.js` 轮询间隔、note persist 延迟 |
| 260 | 项目 persist 防抖 | `queuePersistProjects` |
| 15000 | AI 请求超时 | `server.js` |
| 500/800 | 保存徽章显示时长 | 多处 |
| 120 | focus 延迟 | `focusNote` |
| 150 | modal 打开后 focus 延迟 | 多处 |

**建议：** 统一定义常量对象。

---

### 7.2 缺少错误边界

服务器端任何未捕获的 promise rejection 或同步错误都会使得请求挂起直到超时。例如 `readRequestBody` 的 `.catch` 只在部分路由被处理。

---

### 7.3 `prototype.hasOwnProperty.call` 写法冗余

`server.js` :241：
```javascript
Object.prototype.hasOwnProperty.call(item, 'summary')
```
可以简化为 `'summary' in item` 或 `Object.hasOwn(item, 'summary')`（Node 16.9+）。

---

## 8. 汇总统计

| 类别 | 数量 | 最高优先级 |
|------|------|-----------|
| 严重问题 | 3 | ⭐⭐⭐ |
| 重复代码 | 5 类 | ⭐⭐ |
| 废弃代码 | 4 处 | ⭐ |
| 低效实现 | 6 处 | ⭐⭐ |
| 安全隐患 | 4 处 | ⭐⭐⭐ |
| 风格问题 | 3 类 | ⭐ |

---

## 9. 优先修复建议

1. **拆分 `index.html`** — 最影响开发效率的单点问题
2. **统一 `server.js` 请求体解析** — 最简单但收益最高的修复
3. **API Key 加密存储** — 安全性
4. **抽取拖拽通用逻辑** — 减少维护成本
5. **改为增量 DOM 更新** — 提升性能和用户体验
6. **添加请求体大小限制** — 安全性
7. **清理废弃代码** — 消除误导
