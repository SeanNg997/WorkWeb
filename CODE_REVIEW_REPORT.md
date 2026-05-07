# WorkWeb 代码审查报告

**审查日期**: 2026年5月7日  
**审查范围**: 项目所有源代码  
**审查人**: 潇然  

---

## 审查摘要

| 问题类型 | 数量 |
|---------|------|
| 重复代码 | 16 处 |
| 废弃代码 | 6 处 |
| 低效实现 | 4 处 |
| 硬编码值 | 10 处 |
| 潜在bug/问题 | 5 处 |

---

## 一、server.js

### 1. Anthropic/OpenAI payload 条件分支完全相同（重复代码/潜在bug）

- **位置**: `server.js:654-664`
- **问题**: `isAnthropic` 和 `!isAnthropic` 两个分支的 payload 对象完全一模一样，条件判断毫无意义
```js
const payload = isAnthropic
  ? { model, max_tokens: maxTokens || 150, messages: [{ role: 'user', content: prompt }] }
  : { model, max_tokens: maxTokens || 150, messages: [{ role: 'user', content: prompt }] };
```
- **建议**: Anthropic API 的请求体结构与 OpenAI 不同，应该使用不同的字段格式

### 2. 三处 POST 路由手动读取请求体，未复用 readRequestBody()（重复代码）

- **位置**: `server.js:536-549`（`/api/notes POST`）、`server.js:558-572`（`/api/info POST`）、`server.js:580-593`（`/api/projects POST`）
- **问题**: 这三处都用 `let body = ''; req.on('data', ...); req.on('end', ...)` 手动方式读取请求体，而其他路由统一使用了 `readRequestBody(req)` 辅助函数
- **影响**: 手动方式没有错误日志、没有 `.catch()` 处理，行为不一致

### 3. 两份几乎相同的 MIME 类型映射表（重复代码）

- **位置**: `server.js:727-733`（figure MIME）与 `server.js:754-765`（静态文件 MIME）
- **问题**: `figureMime` 是 `mime` 的子集，两处定义了重叠的 MIME 映射
- **建议**: 提取为一个共享常量

### 4. 两个几乎相同的递归目录遍历函数（重复代码）

- **位置**: `server.js:210-220`（`listTrash` 内的 `walk`）与 `server.js:279-297`（`listDataFiles` 内的 `walk`）
- **问题**: 两处都是递归遍历目录收集文件，逻辑高度相似
- **建议**: 提取为一个通用的目录遍历辅助函数

### 5. 生产环境残留的 debug 日志（废弃代码）

- **位置**: `server.js:58-62`、`server.js:632`、`server.js:635`、`server.js:707`
- **问题**: `readRequestBody` 里有 4 行 `console.log` 调试输出（打印 raw body 长度、预览、解析结果），AI 路由也有 debug 日志
- **建议**: 移除或使用环境变量控制

### 6. 硬编码的超时值和默认值（硬编码）

- **位置**: `server.js:675`（timeout: 15000）、`server.js:656,662`（maxTokens || 150）
- **问题**: AI 请求超时和默认 max_tokens 直接写死在代码里
- **建议**: 提取为常量

---

## 二、electron/main.js

### 7. ensureDir() 与 server.js 完全重复（重复代码）

- **位置**: `electron/main.js:42-45` vs `server.js:21-24`
- **问题**: 两处的 `ensureDir()` 函数实现完全一致
- **建议**: 从 server.js 导出复用

### 8. readJSONFile()/writeJSONFile() 与 server.js 的 readJSON()/writeJSON() 高度相似（重复代码）

- **位置**: `electron/main.js:47-58` vs `server.js:42-51`
- **问题**: 功能相同，只是参数签名略有不同
- **建议**: 统一为一套工具函数

### 9. 硬编码的窗口尺寸和颜色（硬编码）

- **位置**: `electron/main.js:418-424`
- **问题**: 窗口宽高 (`1480x940`)、最小尺寸 (`1180x760`)、背景色 (`#f4efe4`)、标题栏高度 (`42`) 等全部硬编码

### 10. before-quit 使用 async 但未正确等待（潜在bug）

- **位置**: `electron/main.js:606-610`
- **问题**: `app.on('before-quit', async () => {...})` 中使用了 `await` 关闭服务器，但 Electron 的 `before-quit` 事件不保证等待 async handler 完成
- **影响**: 服务器可能未正确关闭就退出了

---

## 三、src/novel-project-editor.jsx

### 11. NodeSelection 被导入但未使用（废弃代码）

- **位置**: `novel-project-editor.jsx:7`
- **问题**: `import { NodeSelection, TextSelection, Plugin, PluginKey }` 中的 `NodeSelection` 在整个文件中从未被使用

### 12. 空的 useEffect（废弃代码）

- **位置**: `novel-project-editor.jsx:511-513`
```js
useEffect(() => {
  return () => {};
}, [value]);
```
- **问题**: 这个 effect 注册了一个空的清理函数，不做任何事情，依赖 `value` 但完全不使用它

### 13. 两处重复的"空白区域点击"逻辑（重复代码）

- **位置**: `novel-project-editor.jsx:515-528` (`focusEndWhenClickingBlankSpace`) 与 `novel-project-editor.jsx:577-589` (`isBlankSpaceClick`)
- **问题**: 两个函数都在检查"点击是否发生在编辑器空白区域"，逻辑高度重叠
- **建议**: 合并为一个函数

### 14. 硬编码的 AI 上下文长度限制（硬编码）

- **位置**: `novel-project-editor.jsx:43`、`novel-project-editor.jsx:69`
- **问题**: `cursorPos.pos - 600` 和 `beforeText.slice(-600)` 中的 600 是硬编码的上下文窗口大小，且重复出现

### 15. useSyncExternalStore 用 Date.now() 作为快照（低效实现）

- **位置**: `novel-project-editor.jsx:326-340`
- **问题**: `getSnapshot` 返回 `Date.now()`，这意味着每次 editor 事件都会产生一个新的快照值，导致组件频繁重新渲染
- **影响**: 很多 transaction（如光标闪烁）并不需要触发重渲染，造成不必要的性能开销

---

## 四、index.html

### 16. 整个便笺编辑模态框及相关函数是死代码（废弃代码）

- **位置**: `index.html:2694-2717`（editorModal HTML）、`index.html:3117`（`editingNoteId` 变量）、`index.html:4404-4457`（`openNoteEditor()`、`closeNoteEditor()`、`saveNote()` 三个函数）
- **问题**: 便笺现在使用行内编辑（`bindInlineNoteEditor`），`createNote()` 直接创建便笺并调用 `focusNote()`，**从不调用** `openNoteEditor()`
- **影响**: 约 50 行 JS + 25 行 HTML 完全是死代码

### 17. currentAppVersion 变量声明后从未被读取（废弃代码）

- **位置**: `index.html:2947`
- **问题**: `let currentAppVersion = '';` 在 `loadAppVersion()` 中被赋值，但全文没有任何地方读取这个变量

### 18. 三处 persist 函数完全相同的 try/catch 模式（重复代码）

- **位置**: `index.html:3094-3098` (`persistNotes`)、`index.html:3101-3106` (`persistInfo`)、`index.html:3108-3113` (`persistProjects`)
- **问题**: 三个函数结构完全一致：先 try 服务器端保存，catch 时回退到 localStorage
- **建议**: 提取为通用的 `persist(key, data)` 函数

### 19. apiSave() 与 apiPost() 功能几乎完全相同（重复代码）

- **位置**: `index.html:2959-2967` (`apiSave`) 与 `index.html:2969-2978` (`apiPost`)
- **问题**: 两者都是 POST 请求到 `/api/{key}`，唯一的区别是错误处理方式不同
- **建议**: 合并为一个函数

### 20. reorderInfoTags() 与 reorderProjectTags() 逻辑完全相同（重复代码）

- **位置**: `index.html:5937-5958` vs `index.html:4761-4782`
- **问题**: 两个函数的算法完全一样：按标签分组 -> 记录 tagOrder -> 找到 fromIdx/toIdx -> splice -> flatMap
- **建议**: 提取为通用的 `reorderTaggedItems(items, getTag, fromTag, toTag)` 函数

### 21. 标签相关函数多处重复（重复代码）

- **位置**: 
  - `showProjectTagSuggestions()` (5178-5199) vs `showInfoTagSuggestions()` (6047-6063)
  - `selectProjectTagSuggestion()` (5206-5215) vs `selectInfoTagSuggestion()` (6071-6078)
  - `getExistingProjectTags()` (5174-5176) vs `getExistingInfoTags()` (6043-6044)
- **问题**: 标签建议、选择、获取逻辑在项目和信息面板两处高度重复

### 22. 四套拖拽逻辑高度重复（重复代码）

- **位置**: 
  - note card 拖拽 (4274-4303)
  - `bindProjectTagDrag` (4574-4643)
  - `bindInfoTagDrag` (5833-5877)
  - `bindInfoPanelDrag` (5880-5931)
- **问题**: 四处拖拽逻辑都是相同的 `dragCounter` + `dragstart`/`dragend`/`dragover`/`dragenter`/`dragleave`/`drop` 模式
- **建议**: 统一为一套可复用的拖拽框架

### 23. renderNotes() 每次全量销毁重建所有编辑器（低效实现）

- **位置**: `index.html:4225-4392`
- **问题**: 每次调用都先 `destroyNoteEditors()`（销毁所有 React 实例），再 `grid.innerHTML = ''`（清空 DOM），然后重新创建所有卡片和编辑器
- **影响**: 当便笺数量多时，会导致大量不必要的 React mount/unmount 和 DOM 操作

### 24. normalizeVersionText() 与 electron/main.js 的 normalizeVersion() 重复（跨文件重复）

- **位置**: `index.html:2980-2982` vs `electron/main.js:108-110`
- **问题**: 两个函数实现完全一致：`String(value || '').trim().replace(/^v/i, '')`

### 25. 大量硬编码的定时器值（硬编码）

- **位置**: 
  - `index.html:4120`: 300ms（便笺保存 debounce）
  - `index.html:4485`: 260ms（项目保存 debounce）
  - `index.html:3834`: 500ms（保存状态隐藏延迟）
  - `index.html:5449`: 620ms（开书动画时长）
  - `index.html:5468`: 340ms（关书动画时长）
  - `index.html:5450`: 120ms（聚焦延迟）
  - `index.html:3150`: `[0, 80, 180, 320, 520, 800, 1200, 1700]`（滚动重试延迟数组）

### 26. persist 函数静默吞掉错误（潜在bug）

- **位置**: `index.html:3094-3113`
- **问题**: 服务器请求失败时，catch 块只回退到 localStorage，不给用户任何提示
- **影响**: 如果服务器在线但返回了错误（如磁盘满），用户不会收到任何反馈

### 27. createNote() 先渲染再持久化，存在不一致窗口（潜在bug）

- **位置**: `index.html:4148-4161`
- **问题**: `renderNotes()` 在 `persistNotes()` 之前调用，如果持久化失败，UI 上会显示一个未保存的便笺

---

## 优先修复建议

### 高优先级
1. **#1** - Anthropic/OpenAI payload 条件分支相同（明确的 copy-paste bug）
2. **#16** - 便笺编辑模态框及相关函数（大量死代码）
3. **#2** - 三处手动读取请求体（不一致的错误处理）
4. **#23** - renderNotes() 全量重建（性能影响最大）

### 中优先级
5. **#5** - 生产环境残留的 debug 日志
6. **#7-8** - ensureDir/readJSON/writeJSON 跨文件重复
7. **#18-22** - 多处重复的业务逻辑函数
8. **#10** - before-quit async 处理问题

### 低优先级
9. **#11-12** - 未使用的导入和空 useEffect
10. **#6, #9, #14, #25** - 硬编码值
11. **#15** - useSyncExternalStore 性能优化

---

*报告生成时间: 2026-05-07*
