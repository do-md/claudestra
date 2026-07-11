# Fork 差异清单（do-md/claudestra vs shawnlu96/claudestra）

> 本 fork 的使命：给 Claudestra 加一个可 PWA 安装、OneSignal 推送的 **Next.js Web 客户端**
> （`web/`，Discord 之外的第二前门）。2026-07-10 起全面采纳 upstream 的多前端解耦架构
> （`docs/design-multi-frontend.md` + `docs/web-frontend-guide.md`），fork 侧只保留
> upstream 没有的能力，全部以 `[fork]` 注释标记、遵守 additive-only 合同。
> **merge upstream 时的原则：冲突全取 upstream，再按本清单核对 fork 增量是否需要重挂。**

## fork 独有目录（upstream 无，merge 不冲突）

- `web/` — Next.js Web 客户端（BFF 消费 upstream /api/v1 + /events，见 `web/CLAUDE.md`）
- `scripts/web-only-bridge.sh` / `scripts/web-only-launcher.sh` — launchd 常驻封装
- `src/bridge/local-adapter.ts` — local ChatAdapter（见下）
- 本文件

## src/ 内的 fork 增量（merge 后需核对的补丁点）

### Web-only 模式（无 DISCORD_BOT_TOKEN 可跑）
- `bridge/config.ts`：`WEB_ONLY = !process.env.DISCORD_BOT_TOKEN`
- `bridge.ts` 末尾启动块：WEB_ONLY 分支跳过 Discord 登录，只跑
  bg-activity-watcher / archive-sweeper / metrics（Discord 专属初始化全部跳过）
- `bridge/local-adapter.ts` + 注册：provisionConversation 返回 `local-<uuid>`
  合成会话地址（manager create 零改动），出站 no-op（web 走 /events + 历史 API）
- `bridge/router.ts` parseChatId/formatChatId：`local-` 前缀 → transport "local"
- `bridge.ts` ws case：create_channel 按 WEB_ONLY 选 adapter；delete/rename_channel、
  announce_focus 对 local-* no-op

### additive /api/v1 端点（upstream 缺口，落地后应切换删除）
- `POST /api/v1/agents/:name/interrupt` — tmux C-c（master → master:0）
- `POST /api/v1/agents/:name/answer` — AUQ submit/cancel（buildAuqKeystrokes）+
  权限弹窗 allow/allow_session/deny（发键前 tmuxCapture 重验）
- `GET /api/v1/agents/:name/pending` — 挂起交互补拉（SSE 迟到订阅者 replay）；
  additive 加 `thinking: boolean`（该 agent 此刻是否在回合中，见「事件与状态」getAgentStatus），
  web composer 连流时读它同步「暂停」态
- `POST /api/v1/agents` + `POST /api/v1/agents/:name/{kill,restart}` — 生命周期，仅全权 token
- `GET /api/v1/agents` 增强：`?include=stopped` 入列已停止 agent；master 入列
  （scope 显式含 "master" 才可见）
- `findApiAgent` master 特判：channelId=CONTROL_CHANNEL_ID、cwd 取 channel-server
  注册信息、sessionId probe 最新 jsonl → messages/history/interrupt/answer 对 master 透明

### 事件与状态
- `bridge/event-bus.ts`：`question_cleared` 事件类型（additive）——AUQ 应答/取消后
  web 收卡；Discord AUQ 按钮 + API answer 双侧发射
- `bridge/event-bus.ts`：`getAgentStatus(agent)`（additive）——O(1) 追踪每个 agent 最近一次
  `agent_status`（thinking/done）。`emitEvent` 里旁路更新一个 `agentStatuses` map。供
  `/pending` 的 `thinking` 字段用（web composer 刷新/切回/回前台连流时同步「暂停」态）。
  bridge 重启清零（同 ring 的 R6，权威回合边界靠 Stop hook 的 done）。单测在 tests/event-bus.test.ts。
- `bridge/ask-user-question.ts`：`registerAuqState` 把状态注册与 Discord 渲染解耦
  （web-only / post 失败时 answer 端点仍有状态可用）；jsonl-watcher 调用点先注册后渲染

### 修复（应上报 upstream）
- **历史 API 丢所有 channel 用户消息**（lib/session-history.ts）：channel 送达的
  入站消息（web/API/Discord/agent↔agent）在 CC jsonl 里是 `isMeta:true` +
  `<channel …>` 包装的 user 记录，被 `isMeta` 一刀切过滤 → 任何 web 前端的历史
  里都没有用户消息，回合结构随之丢失（连续 assistant 粘连）。修复：新增
  `unwrapChannelMessage`（剥 wrapper + `[🌐/🤖 …]` framing header、提取 `user`
  属性为 `from` 字段），isMeta 分支先尝试解包再过滤；`HistoryMessage` 增
  `from?: string`（additive）。测试：tests/session-history.test.ts
  `unwrapChannelMessage` describe 块。
- **/events SSE 空闲断流**（bridge.ts handleEventsRequest）：Bun.serve 默认 HTTP
  idleTimeout≈10s，upstream 的 30s ping 活不到第一轮，事件间隙 >10s 的订阅者被静默
  掐掉（实测 10.7s close）。修复：连接即发 `: connected` + ping 5s。
- **API 回复事件重复**（bridge.ts reply ws case）：api: 目的地的回复 deliverToApi
  已埋点 chat_message(out)，reply case 再发一次 = 同一条回复两个事件。修复：api
  transport 跳过 reply case 的埋点。
- **agentInScope R1 漏洞**（lib/principals.ts）："agent-master" 变体未按 master 处理，
  `"*"` token 可经前缀变体绕过 master 排除。修复：两个名字都算 master。

### 其它
- `manager.ts` token-add：允许显式 `master` scope 值（--force；大总管接入 web 用）
