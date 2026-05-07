# WorkWeb 代码审查修复报告

生成日期：2026-05-07

## 修改范围

本次基于 `CODE_REVIEW.md` 和 `CODE_REVIEW_REPORT.md`，结合实际代码做了低风险修复与局部优化。未进行 `index.html` 大规模拆分、便笺渲染机制重写等高风险改动。

## 已完成修改

### server.js

- 统一 `POST /api/notes`、`POST /api/info`、`POST /api/projects` 的请求体解析，全部复用 `readRequestBody()`。
- 移除 `readRequestBody()` 和 AI 路由中的调试日志，避免生产环境输出请求内容。
- 增加 `handleJsonPost()`，统一 JSON POST 的成功、解析失败、保存失败响应。
- 拆分 Anthropic 与 OpenAI 的 AI 请求 payload：
  - Anthropic 使用 content blocks。
  - OpenAI 保持 chat completions 字符串 content。
- 提取 AI 默认 token 数和超时时间常量。
- 合并图片文件和静态文件 MIME 映射。
- 提取递归文件遍历工具 `collectFiles()`，复用到回收站列表和数据导出。

### electron/main.js

- 修复 `before-quit` 中异步关闭本地服务不可靠的问题。
- 退出前先阻止默认退出，等待本地 server close 回调完成后再继续退出。

### src/novel-project-editor.jsx

- 提取 AI 上下文长度常量 `AI_CONTEXT_CHAR_LIMIT`，替代重复硬编码 `600`。
- 移除空 `useEffect`。
- 用 `useEffect + useState` 替代 `useSyncExternalStore + Date.now()` 强制刷新工具栏状态，表达更清晰。
- 提取空白区域点击判断函数，减少重复逻辑。

### vendor/novel-project-editor.js

- 重新执行 `npm run build:novel`，同步生成编辑器产物。

### index.html

- 删除已废弃的便笺编辑模态框 HTML。
- 删除无调用的 `openNoteEditor()`、`closeNoteEditor()`、`saveNote()` 和 `editingNoteId`。
- 移除快捷键和遮罩点击中对废弃便笺模态框的处理。
- 删除未使用的 `currentAppVersion`。
- 合并 `apiSave()` 与 `apiPost()`，统一 POST 请求错误解析。
- 提取 `persistData()`，统一 notes/info/projects 的保存与 localStorage 回退逻辑。
- 保存回退到 localStorage 时增加节流提示，避免服务器异常时完全静默。
- 统一 `escHtml()` 与 `escAttr()` 的转义方式，减少 DOM 临时节点创建。
- 提取 `groupItemsByTag()` 和 `reorderTaggedItems()`，复用到项目标签分组/排序和信息面板标签分组/排序。

## 未直接修改的项目

- `index.html` 巨型文件拆分：影响范围过大，当前不适合在修复审查问题时一起做。
- `renderNotes()` 增量渲染：需要重写便笺编辑器挂载/复用策略，风险高，未纳入本次低风险修复。
- 多套拖拽逻辑完全统一：涉及交互细节较多，本次只处理标签分组/排序重复逻辑。
- `NodeSelection` 未使用：实际代码中图片缩放保存宽度时仍在使用，该审查项为误报。

## 验证结果

- `node --check server.js`：通过。
- `node --check electron/main.js`：通过。
- `npm run build:novel`：通过；Vite 提示当前 Node.js `18.19.1` 低于推荐版本 `20.19+`，但构建成功。
- `index.html` 内联脚本语法解析：通过。
- 服务端 mini-run：通过。
  - 使用临时数据目录启动服务。
  - 验证 notes/info/projects POST 和 GET。
  - 验证 `/` 静态页面可访问。
