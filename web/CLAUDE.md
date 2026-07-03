# Claudestra Web 客户端

Claudestra 的 Next.js Web 前门（Discord 之外的第二入口）。可 PWA 安装、OneSignal 推送、多会话流式 Chat。
架构方案见项目图 `claudestra` 的 Reference `web-client-architecture.md`（BFF 代理 → Bridge /web/* 网关）。

## 技术栈 & 端口

- Next.js 16 + React 19 + TypeScript + Tailwind 4 + daisyUI；状态管理 zenith（`@do-md/zenith`，复制式 `.packages/`）。
- 端口：**dev 33333 / 生产 3333**（避让 claude-os 的 22222/2222）。
- 运行时是标准 Node/npm（`npm run dev`），**独立于仓库根的 Bun 后端**（bridge/manager 那套）。两套依赖树互不干扰。

## 目录结构

```
app/
  page.tsx              → redirect /chat
  chat/page.tsx         Chat 页面（<Chat/>）
  login/page.tsx        SSH 账号登录
  api/
    auth/{login,logout,me}/  鉴权（公开，自处理）
    agents/             GET agent 列表；POST 新建（代理 Bridge /web/agents）
    agents/kill/        POST kill（代理 Bridge /web/agents/kill）
    agents/restart/     POST restart（代理 Bridge /web/agents/restart）
    chat/send/          POST 注入消息（isAuthed；真实→Bridge /web/inject，mock 回退）
    chat/stream/        GET SSE 输出流（isAuthed；真实→Bridge /web/stream，mock 回退）
    chat/history/       GET ?agent= 历史消息（BFF **直接读** CC session jsonl，见下）
features/chat/
  type.ts               ChatMessage / AgentSession / ToolCallView
  stream.ts             consumeSSEStream + processStreamEvent + StreamSink
  chat-store.ts         zenith 中枢（agents/messages/streaming/loadingHistory；
                        openGen 门控历史加载，streamGen 门控流；createAgent/killAgent/restartAgent）
  components/           sidebar(AgentRow hover 出 重启/停止 + 新建按钮) / new-agent-modal
                        / message-list / composer / chat(Provider)
lib/
  db/                   getDb + auth migration（数据根 ~/.claude-orchestrator/web/db）
  services/auth.service.ts  verifySSH(ssh2) + session CRUD
  api-auth.ts           isAuthed（cookie 或 x-api-key 双认证）
  chat/                 events(段级流协议) / mock-bridge(pub/sub) / agents(读 registry.json,
                        含 resolveSession 取 sessionId+cwd) / history(jsonl→ChatMessage[] 解析器)
proxy.ts                Next16 proxy：只拦页面 cookie；API 由 handler 自守
```

## 鉴权模型（复用 claude-os SSH/PAM + Bearer）

- 登录：`verifySSH` 连本机 SSH 校验账号密码 → 写 SQLite session → HttpOnly cookie `cstra_session`（7天）。
- 双认证 `isAuthed()`：浏览器 cookie session，或外部脚本 `x-api-key === INTERNAL_API_KEY`。
- **分层**：`proxy.ts` 只拦「页面」（无 cookie → /login）；API 路由各自在 handler 调 `isAuthed()`（遵 prin-475132；且 proxy 跑 edge 运行时读不到 `.env.local`）。
- cookie 名用 `cstra_session`（不是 claude-os 的 `cos_session`）——localhost 下 cookie 按 host 不按端口隔离，必须避名。

## 数据流（BFF dual-mode：真实 Bridge / mock 回退）

会话 = 一个 claudestra agent。前端每打开一个 agent 建一条持久 SSE 流（`GET /api/chat/stream`）；`send` 只 fire-and-forget 注入（`POST /api/chat/send`），输出经该流回来。

BFF（`app/api/chat/{send,stream}`）按 agent 是否有真实 channelId 分流（`lib/chat/agents.ts` 的 `resolveChannelId`，读 registry.json）：
- **真实 agent**（registry 有 channelId）→ 服务端调 Bridge 的 `POST /web/inject` / 代理 `GET /web/stream?channelId=`（Bridge 侧 `bridge/web-hub.ts` + jsonl-watcher/reply tee）。浏览器永不直连 3847。
- **mock agent**（registry 缺失/未起后端）→ `lib/chat/mock-bridge.ts` 的 globalThis pub/sub 模拟，保开发体验。

两条路事件协议一致（`lib/chat/events.ts` 的 `WebStreamEvent`，与 Bridge 侧 `web-hub.ts` 对齐），前端零感知。

**历史消息（`chat/history`）例外：BFF 直接读盘，不经 Bridge。** 打开会话时 `chat-store.openAgent` 先 `loadMessages`（`GET /api/chat/history?agent=`）再连流。该路由用 `resolveSession` 从 registry 取 `sessionId+cwd`，由 `lib/chat/history.ts` 读 `~/.claude/projects/-<slug>/<sessionId>.jsonl` 解析成 `ChatMessage[]`。为什么直接读盘而非 Bridge `/web/history`：历史是纯只读磁盘操作、同机、**对已停止 agent 也有效**（Bridge 无 live `clients` 条目），且不碰 Discord 关键路径 `bridge.ts`。解析忠实复刻 `src/bridge/jsonl-watcher`：`hasReply` 时抑制 text 块、reply 工具(`mcp__<mcp>__reply`)的 `input.text` 作最终回复、非隐藏 `tool_use`→工具卡、按 human user 消息切 turn、剥 `<channel>` 包装、turn 内去重重复文本段。

**会话管理（`agents` POST / `agents/kill` / `agents/restart`）走 Bridge。** BFF 代理 Bridge 的 `/web/agents*`，Bridge 内部 `runManager("create"|"kill"|"restart")`（Bun 进程,bun 必在 PATH）。故 create/kill/restart 需 Bridge 在跑（与 send/stream 一致）。

## 运行 & 排障

- **Bridge 常驻**（会话/终端无关）：由 launchd LaunchAgent `com.claudestra.web-bridge` 拉起，`RunAtLoad+KeepAlive`，跑 `scripts/web-only-bridge.sh`（确保 master tmux session + Web-only exec bridge）。装/查/重载：
  - 装：写 `~/Library/LaunchAgents/com.claudestra.web-bridge.plist`（照 `src/lib/cli-install.ts` 的 plist 约定，务必含 `LANG/LC_ALL=en_US.UTF-8`）→ `launchctl bootstrap gui/$(id -u) <plist>`。
  - 查：`launchctl print gui/$(id -u)/com.claudestra.web-bridge`；日志 `/tmp/claudestra-web-bridge.{out,err}`；端口 `lsof -iTCP:3847`。
  - 改代码后：`launchctl kickstart -k gui/$(id -u)/com.claudestra.web-bridge`。
  - **别**用 `bun src/manager.ts install-cli`（那装官方 3-daemon：bridge+launcher+cron，会额外起 Discord 大总管，Web-only 用不到）。plist 机器相关不入库；wrapper 入库。
- 起 dev：`npm run dev`（若已在跑别重开，热更新会反映改动；探测用 `curl localhost:33333`）。
- **⚠ 若本机 shell 全局设了 `NODE_ENV=production`**：`next dev` 会继承它 → 触发 non-standard 告警、且 `.env.local` 加载行为异常。用 `NODE_ENV=development npm run dev` 强制。
- **⚠ `INTERNAL_API_KEY` 若在 shell 环境里已全局导出**（如与 claude-os 共用），会**盖过 `.env.local`**（Next.js 进程 env 优先级 > .env 文件）。x-api-key 认证「莫名失败」时先查 `echo $INTERNAL_API_KEY`。
- Next 16 冷知识：`_` 开头的目录是私有的、**不路由**（`app/api/_x/` 不会注册）。
- macOS 无 `timeout` 命令，测 SSE 长连接用 `curl --max-time N`。
