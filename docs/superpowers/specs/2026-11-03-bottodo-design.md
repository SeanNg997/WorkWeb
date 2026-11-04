# WorkWeb BotTodo 模块设计

- 日期：2026-11-03
- 仓库：SeanNg997/WorkWeb
- 分支：`BotTodo`（从 `main` 拉出；`main` 保留现版）
- 实现路径：A — 在现有 `index.html` + `server.js`（及必要的 Electron 设置白名单）内扩展

## 1. 目标

新增只读模块，展示 Grok Bot 维护的待办与日程（markdown），并通过设置中的 webhook 触发远端 bot 更新，或把用户消息发给同一 webhook。纪念日本期不做。

## 2. 信息架构与 UI

- 左侧边栏最上方新增「Bot TODO」，SVG 图标风格与现有侧栏项一致。
- 新页面 `#page-bot-todo`：
  - 顶栏：左标题「TODO in Grok Bot」，右「更新」按钮（样式与其它模块顶栏按钮统一）。
  - 上层：左右两个不可编辑浮岛——「待办」「日程」。标题居中放大；markdown 正文字号偏大；浮岛沿用现有卡片/主题变量，层次清晰、偏高级审美。
  - 下层：居中胶囊形（两端圆弧）输入框 + 发送；空内容不发送。
- Markdown 用现有 `vendor/marked.min.js` 渲染；跟随明暗主题。

## 3. 数据与文件

- 固定路径（相对当前数据目录）：
  - `bot-todo/todos.md`
  - `bot-todo/schedule.md`
- 目录/文件不存在时视为空内容；服务端可读时宜确保目录存在（可建空文件）。
- 不在设置里配置 md 路径。

## 4. API

- `GET /api/bot-todo` → `{ todos: string, schedule: string }`（文件原文）。
- `POST /api/bot-todo/webhook` → body `{ type: "update" | "message", text: string }`；服务端读取已保存的 webhook URL，以 `Content-Type: application/json` POST 出去，避免浏览器 CORS。
- 未配置 URL 时接口返回明确错误；前端禁用按钮并 toast 提示。

## 5. 设置

- 在设置弹窗中、「数据目录」板块之前新增「Grok Bot」板块。
- 字段：一个 webhook URL。
- 持久化方式与现有设置一致（桌面 `workwebDesktop` 设置白名单 key / 浏览器 `localStorage`）。

## 6. Webhook Payload

- 更新按钮：`{"type":"update","text":"根据当前的日程和待办，更新本软件的数据"}`
- 发送：`{"type":"message","text":"<输入框原文>"}`

## 7. 刷新与交互

- 进入 Bot TODO 页时立即拉取；停留该页时每约 3–5 秒轮询 `GET /api/bot-todo`。
- 离开页面停止轮询。
- 「更新」/「发送」成功与失败均 toast；发送失败不清空输入框；成功可清空。
- 读文件失败：浮岛友好空态/错误态，不崩页。

## 8. 范围外

- 纪念日 UI/数据
- 在 WorkWeb 内编辑 md
- 多 webhook URL
- OneDrive 同步本身（由 Grok Bot / 系统同步完成；本模块只读数据目录文件）

## 9. 验收

- 侧栏切换到 Bot TODO，顶栏与两岛+输入布局正确，主题明暗正常。
- 改写数据目录下两份 md 后，轮询能看到更新。
- 配置 webhook 后，「更新」「发送」能打到该 URL 且 JSON 正确。
- 未配置 URL 时有明确提示且不误发。
- 设置保存刷新后 URL 仍在。
