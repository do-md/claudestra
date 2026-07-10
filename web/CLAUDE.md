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
    chat/interrupt/     POST {agent} 一键中断（代理 Bridge /web/interrupt → tmux C-c）
    chat/permission/    POST {agent,action} 权限/session-idle 卡应答（代理 Bridge /web/permission）
    chat/auq/           POST {agent,action,selections} AskUserQuestion 卡应答（代理 Bridge /web/auq）
features/chat/
  type.ts               ChatMessage / AgentSession / ToolCallView / PendingPermission / PendingAsk
  stream.ts             consumeSSEStream + processStreamEvent + StreamSink（含 setPermission/setAsk）
  chat-store.ts         zenith 中枢（agents/messages/streaming/loadingHistory + pendingPermission/pendingAsk；
                        openGen 门控历史加载，streamGen 门控流；createAgent/killAgent/restartAgent；
                        interrupt/resolvePermission/submitAsk/cancelAsk）
  components/           sidebar(AgentRow hover 出 重启/停止 + 新建按钮) / new-agent-modal
                        / message-list（含 permission-card + ask-question-card 渲染）/ composer（streaming 时出「停止」）
                        / permission-card / ask-question-card / chat(Provider)
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

**大总管（master orchestrator）置顶入口 = 复刻 Discord #control。** sidebar 第一位是 👑 大总管（`MASTER_AGENT_NAME="__master__"`, `pinnedMaster`, 不显 kill/restart）。它**不在 registry**，靠 Bridge `GET /web/master` 拿 `{channelId:CONTROL_CHANNEL_ID, cwd:MASTER_DIR, sessionId:master slug 下最新 jsonl, connected}`；`/api/agents` 置顶它，send/stream/history 三个路由对 `__master__` 特判走 `getMasterInfo()`（`lib/chat/agents.ts`）而非 registry。行为对齐 Discord：大总管只把 `reply()` 结果 + `done` 流到 Web（它没 jsonl-watcher，内部 Bash/工具 churn 不流；但**历史**从 jsonl 读，会带上工具卡）。大总管由 launcher 常驻（见下）。

## 富交互（Phase 2：中断 / 权限卡 / AskUserQuestion 卡）

复刻 Discord Phase 2，三者都「Bridge tee 交互事件到 Web → 前端渲染卡片 → 回传打 tmux 按键」，**复用 Discord 侧已有的 keystroke 逻辑**（`resolveTmuxTarget` / `applyPermissionAction` / `buildAuqKeystrokes`），只换 Web 出入口。数据回路与聊天流同构：

- **事件下行**：新增 4 个 `WebStreamEvent`（`permission` / `permission-cleared` / `ask` / `ask-cleared`），经 `/api/chat/stream`(SSE) → `processStreamEvent` → store `setPermission`/`setAsk` → `permission-card.tsx` / `ask-question-card.tsx` 渲染在 message-list 尾部。有卡时 `awaitingChunk` 置 false（在等用户不是等 agent，收起「思考中」dots）。
- **回传上行**：卡片点按 → store `resolvePermission(action)` / `submitAsk(selections[][])` / `cancelAsk()` / `interrupt()` → BFF `/api/chat/{permission,auq,interrupt}` → Bridge `/web/{permission,auq,interrupt}` → tmux 按键。乐观清卡；Bridge 也会 SSE 推 `*-cleared` 兜底。
- **迟到订阅补发**：交互卡有状态，SSE 可能在弹窗之后才连上（切会话/刷新/回前台）。Bridge `web-hub` 存 `pendingInteraction`，`/web/stream` 对新订阅者 replay 当前 pending 卡。故前端 `openAgent` 切会话时先清 `pendingPermission`/`pendingAsk`，连流后由 replay 补回。
- **中断**：streaming 时 composer 出「■ 停止」按钮 → `interrupt()` → C-c，agent 回合被杀 + `done` 解锁输入。master / agent 均可（`resolveTmuxTarget` 认 `CONTROL_CHANNEL_ID`）。
- **⚠ 权限卡测试坑**：agent 默认以 `bypassPermissions` 起（`src/lib/claude-launch.ts`），日常几乎不弹运行时权限 modal，所以权限卡**不易真机触发**（endpoint + keystroke 已 curl/单测验证，渲染路径与 AUQ 完全同构）。要真机复现权限卡，得起一个 `--permission-mode default/acceptEdits` 的 agent 再让它跑需授权的操作。AUQ 卡与中断都可正常真机触发（`AskUserQuestion` 工具与权限模式无关；中断任何 streaming 回合都行）。已真机验证（2026-07-04）：AUQ 卡渲染→单选→提交→键序列命中 TUI 精确选项（agent 回「你选了 火锅」）；中断在流式数数中途停在「4」并解锁输入。

## 运行 & 排障

- **两个 launchd 常驻服务**（会话/终端无关，`RunAtLoad+KeepAlive`，plist 机器相关不入库、wrapper 入库；plist 务必含 `LANG/LC_ALL=en_US.UTF-8`）：
  - `com.claudestra.web-bridge` → `scripts/web-only-bridge.sh`：确保 master tmux session（cwd=`master/`！）+ 带 `CONTROL_CHANNEL_ID=local-master-control` exec bridge。日志 `/tmp/claudestra-web-bridge.{out,err}`，端口 `lsof -iTCP:3847`。
  - `com.claudestra.web-launcher` → `scripts/web-only-launcher.sh`：跑 `src/launcher.ts`（合成 `CONTROL_CHANNEL_ID`），确保 master:0 常驻大总管 Claude Code + 自动确认启动提示。日志 `/tmp/claudestra-web-launcher.{out,err}`。**⚠ 两个 wrapper 的 `CONTROL_CHANNEL_ID` 必须一致。**
  - 装：写对应 plist → `launchctl bootstrap gui/$(id -u) <plist>`；查：`launchctl print gui/$(id -u)/<label>`；改代码后：`launchctl kickstart -k gui/$(id -u)/<label>`。
  - 前置：`master/CLAUDE.md` 需已渲染（大总管 persona）——`USER_NAME=X python3 /tmp/render_master_claudemd.py` 或 `bun run setup`。渲染产物 git-ignored。
  - 关掉 claudestra 自动更新（`bun src/manager.ts auto-update claudestra off`）：launcher 的自更新走 `git pull + pm2 restart`，launchd 下会坏。
  - **别**用 `bun src/manager.ts install-cli`（那装官方 3-daemon 含 cron + 面向 Discord）。
- 起 dev：`npm run dev`（若已在跑别重开，热更新会反映改动；探测用 `curl localhost:33333`）。
- **⚠ 若本机 shell 全局设了 `NODE_ENV=production`**：`next dev` 会继承它 → 触发 non-standard 告警、且 `.env.local` 加载行为异常。用 `NODE_ENV=development npm run dev` 强制。
- **⚠ `INTERNAL_API_KEY` 若在 shell 环境里已全局导出**（如与 claude-os 共用），会**盖过 `.env.local`**（Next.js 进程 env 优先级 > .env 文件）。x-api-key 认证「莫名失败」时先查 `echo $INTERNAL_API_KEY`。
- Next 16 冷知识：`_` 开头的目录是私有的、**不路由**（`app/api/_x/` 不会注册）。
- macOS 无 `timeout` 命令，测 SSE 长连接用 `curl --max-time N`。
