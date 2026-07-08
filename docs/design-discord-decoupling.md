# 设计文档：Discord 解耦（事件流 + 入站 API）

> 状态：**草案，待 owner 批准**（2026-07-09）
> 范围：Phase A（结构化事件流）+ Phase B（入站消息 API）
> 不含：网页前端本身（本设计只保证「前端只是这两个接口的消费者」）

## 1. 背景与动机

Claudestra 目前所有人机交互都经过 Discord。owner 提出两个诉求：

1. **把某个 agent 开放给外部的人用** —— Discord 的权限模型（频道可见性、成员管理）做这件事很别扭；
2. **未来可能做网页端** —— 不确定做不做，但希望现有架构先与 Discord 解耦，届时网页端是「纯前端」而不是「二次重构」。

原则（owner 多次强调）：**Keep it simple**。不做投机性大重构，只把「必须解耦才能开门」的两处打开，其余照旧。

## 2. 现状盘点

### 已经与 Discord 无关的部分（不用动）

| 部分 | 现状 |
|------|------|
| Agent↔agent 通信 | `send_to_agent` 本地走 ws 直连（`deliverToLocal`），不经 Discord |
| 消息路由中枢 | v2.0.0 `Envelope{from,to,intent,content}` + `deliver()` 统一派发；agent 侧地址是 `user:`/`agent:`/`peer:` 抽象 |
| JSONL 解析 | `lib/agent-stats.ts`、`lib/jsonl-cost.ts` 是纯库 |
| 看板数据 | `GET /stats` 已是开放 JSON 接口（v2.4.25+） |
| reply 的按钮 | agent 传的是中性 JSON（`{type:"buttons",buttons:[...]}`），进 Discord 前才由 `buildComponents` 转成 Discord 组件 |

### 真正耦合的部分

| 耦合点 | 位置 | 本设计是否处理 |
|--------|------|----------------|
| 出站：`deliverToUser` 直接调 `discordReply` | bridge.ts | ✅ Phase B 增加 `api` endpoint 分支 |
| jsonl-watcher 输出端直接写 Discord | jsonl-watcher.ts | ✅ Phase A 旁路 emit（见 §4.2 决策） |
| 用户身份 = Discord user id（`ALLOWED_USER_IDS`） | bridge.ts / .env | ✅ Phase B token 即身份 |
| registry / clients / pending 用 Discord channelId 当主键 | 全局 | ❌ 不改（见 §6 决策 D3） |
| UI 层：管理按钮、看板、slash 命令、typing | components/management/stats-dashboard | ❌ 留在 Discord |
| peer 协作信任边界 = `#agent-exchange` 频道 | peers.ts + bridge.ts | ❌ 不动，Discord 就是它的信任模型 |

## 3. 目标与验收

- **A**：任何人可以 `curl -N http://bridge/events` 实时看到结构化的 tool call / assistant 文本 / turn 事件流（JSON，SSE 协议），断线可用 `Last-Event-ID` 补发。
- **B**：外部用户凭 token `POST /api/agents/:name/messages` 与被授权的 agent 对话，同步拿到回复或经 SSE 收推送；未授权的 agent 返回 403。
- **零回归**：Discord 侧行为完全不变（渲染、debounce、drain、按钮、peer 路由都不动）。
- **不新增常驻进程**：全部住在现有 bridge 的 `Bun.serve` 里。

## 4. Phase A — 结构化事件流

### 4.1 新模块 `src/bridge/event-bus.ts`

进程内事件总线 + 环形缓冲。**没有持久化**（bridge 重启事件清零；历史数据的权威来源永远是 jsonl 文件本身，事件流只是实时通道）。

```ts
export interface BridgeEvent {
  seq: number;             // 进程内单调递增，SSE 的 id
  ts: string;              // ISO
  agent: string;           // registry 里的 agent 名（master 用 "master"）
  channelId: string;       // 对应 Discord 频道（沿用现有主键，见 D3）
  type: "tool_start" | "tool_done" | "assistant_text" | "turn_duration"
      | "agent_status" | "auto_deny" | "question" | "chat_message";
  data: Record<string, unknown>;   // 按 type 各自的负载
}
```

各 type 的 `data` 负载：

- `tool_start`: `{ toolId, name, summary }`（summary 复用 watcher 的 `formatTool` 输出）
- `tool_done`: `{ toolId, error }`
- `assistant_text`: `{ text, rateLimited }`
- `turn_duration`: `{ durationMs }`
- `agent_status`: `{ status: "thinking" | "done" }`（thinking = 收到入站消息；done = Stop hook）
- `auto_deny`: `{ reason }`
- `question`: `{ questions }`（AskUserQuestion 原始结构）
- `chat_message`: `{ direction: "in" | "out", from, text }`（Phase B 用，Phase A 先只发 `out` = agent 的正式 reply）

API：

```ts
emit(evt: Omit<BridgeEvent, "seq" | "ts">): void
subscribe(filter: { agent?: string }, cb): () => void
replaySince(seq: number, filter): BridgeEvent[]   // ring buffer，每 agent 保留最近 500 条
```

### 4.2 埋点方式：旁路镜像，不拆 watcher（关键决策）

理想架构是把 jsonl-watcher 拆成「producer（解析）→ bus → Discord sink（渲染）」。**本设计明确不这么做**，理由：

- watcher 的 flush/debounce/drain 逻辑与状态强耦合（`textQueue`/`toolMsgId`/`processing` 锁），v2.0.18 的 drain 竞态修复、v2.0.13 的 captured-text 时序都是血泪史，硬拆的回归风险远大于收益；
- Discord 渲染（debounce 1.5s、tool 消息 edit 合并、`-#` subtext、2000 字分块）本来就是 Discord 专属逻辑，放在 sink 里也不会被别的传输复用。

做法：在 `processNewData` / `drainChannelWatcher` / hook 处理器的**既有分支里加 `emit()` 一行**，Discord 写入照旧。事件流是旁路镜像（mirror），不是渲染管线的上游。代价是「同一事实两条路径」，换来的是零回归 + 改动量极小。

埋点清单：

| 事件 | 埋点位置 |
|------|----------|
| `tool_start` / `tool_done` | processNewData 的 tool_use / tool_result 分支 |
| `assistant_text` | processNewData 的 text 分支（⛔ rate-limit 带 `rateLimited:true`） |
| `turn_duration` | processNewData 的 turn_duration 分支 |
| `auto_deny` | `maybePostAutoDeny` |
| `question` | AskUserQuestion 检测分支 |
| `agent_status` | bridge.ts：deliverToLocal 成功（thinking）+ Stop hook（done） |
| `chat_message(out)` | reply handler `deliver()` 成功后 |

### 4.3 `GET /events`（SSE）

```
GET /events?agent=<name>          # 省略 agent= 订阅全部
Accept: text/event-stream
Last-Event-ID: <seq>              # 或 query ?since=<seq>，断线补发
```

响应：标准 SSE，`id:` = seq，`data:` = BridgeEvent JSON，每 30s 一条 `: ping` 注释防超时。实现用 Bun.serve 的 `ReadableStream`，订阅数不设上限（本机/内网场景）。

### 4.4 Phase A 的安全

`Bun.serve` 目前**没指定 hostname，默认绑 0.0.0.0**——`/hook`、`/stats`、`/skills/rescan` 已经暴露在内网。Phase A 顺手收紧：

- 默认 `hostname: "127.0.0.1"`；新增 env `BRIDGE_BIND` 允许放开（跨机器场景用户自己设 + 自己负责网络边界）。
- hook（typing-hook.ts）、channel-server、manager 全是 localhost 调用，收紧无副作用。唯一需要在 release notes 里提醒的是自定义 `BRIDGE_URL` 跨机器的用户。

## 5. Phase B — 入站消息 API

### 5.1 Token 模型

`~/.claude-orchestrator/tokens.json`（0600 权限）：

```json
{
  "tokens": [{
    "id": "tok_a1b2c3",
    "secret": "<crypto.randomBytes(32) hex>",
    "name": "外包-张三",
    "agents": ["worker-alpha"],
    "createdAt": "2026-07-09T00:00:00Z",
    "disabled": false
  }]
}
```

- `agents: ["*"]` = 全部本地 agent（不含 master——master 想开放必须显式写名）。
- CLI：`manager.ts token-add <name> --agents a,b`、`token-list`、`token-revoke <id|name>`。secret 只在 add 时完整显示一次。
- 鉴权：`Authorization: Bearer <secret>`。每 token 限流 30 req/min（内存滑窗，超了 429）。

### 5.2 路由融入：虚拟 chat_id `api:<tokenId>`（关键决策）

现有回路里 agent 的 `meta.chat_id`、`pendingReplies` 的 key、`resolveReplyTarget` 的入参全是「频道 id 字符串」。给 API 用户造一个**虚拟频道 id**：

```
api:<tokenId>
```

- 入站时 `resolveReplyBackChannel` 返回它 → agent 收到的 `chat_id="api:tok_a1b2c3"`，reply 时原样传回——**agent 侧完全无感**，无需改 channel-server / MCP 工具。
- `resolveReplyTarget` 开头加一个前缀分支：`api:` → 返回新 endpoint。
- `pendingReplies` / thread 追踪 / Stop hook 清理逻辑照旧工作（它们只把 key 当不透明字符串）。

router.ts 新增：

```ts
export interface ApiUserEndpoint {
  kind: "api";
  tokenId: string;
  name: string;          // token 的人类名，渲染进 agent 看到的 header
}
```

`renderContentForLocal` 加 from.kind==="api" 分支，header 形如 `[🌐 来自 API 用户 张三]`，让 agent 知道对话方不是 Discord 用户（没有 Discord push/@ 语义）。

### 5.3 入站与回复

```
POST /api/agents/:name/messages
Authorization: Bearer <secret>
{ "text": "...", "wait": 120 }
```

流程：鉴权 → scope 检查（agent 不在 token 的 agents 列表 → 403）→ 查 clients 找 agent ws（不在线 → 409 + 提示）→ 构造 `Envelope{from: api, to: local, intent: "request"}` → `deliver()`。

**回复的两种模式：**

1. **同步 wait（默认，`wait` 秒数上限 300）**：bridge 在内存挂 `threadId → resolver`；agent `reply(chat_id="api:...")` 进 `deliverToApi` 时 resolve → POST 返回 `{ reply: {...}, events: [...] }`。超时返回 202 + threadId，客户端转轮询。适合 curl / 脚本一把梭。
2. **SSE 推送**：`GET /api/events`（token 鉴权版 `/events`，只推 scope 内 agent 的事件）。`chat_message(out)` 事件里带 threadId，长连客户端用这条路。

`deliverToApi`（deliver() 的第四个 case）职责：resolve 同步 waiter + emit `chat_message` 事件 + 存 ring buffer（供 `GET /api/threads/:threadId` 兜底轮询）。**不碰 Discord。**

### 5.4 按钮与附件

- **按钮**：reply 的 components 本来就是中性 JSON，`deliverToApi` 原样放进响应。客户端「点击」= 再 POST 一条 text 为 `[button:<id>]` 的消息——与 Discord 按钮点击进 agent 的格式完全一致，agent 无感。
- **附件（出站）**：reply 带 files 时，响应里给 `files: [{ name, url: "/api/files/<opaque-id>" }]`，下载端点校验同一 token + 只允许 bridge 登记过的路径（防任意文件读取）。
- **附件（入站上传）**：v1 不做，标注 future。

### 5.5 Phase B 的安全边界

- bridge 依旧只绑 127.0.0.1；要对公网开放的用户自己上反代（Caddy / Tailscale Funnel），TLS 与网络边界不是 bridge 的职责。文档写清楚。
- token scope 只控制「能对谁说话」+「能看谁的事件」。API 用户没有管理能力：不能 create/kill/restart/cron，管理面继续只在 Discord + CLI。
- `/events`（无鉴权版）在 Phase B 合并进 `/api/events`：本机调用免 token（`req 来源 == 127.0.0.1` 且未带 Authorization 时视为 owner），带 token 则按 scope 过滤。

## 6. 设计决策记录

- **D1 旁路镜像而非拆 watcher**（§4.2）：零回归优先，渲染逻辑本就是 Discord 专属。
- **D2 虚拟 chat_id 而非新 keyspace**（§5.2）：agent 侧、pending 逻辑、channel-server 全部无感，改动集中在 bridge 的 resolve/deliver 两处。
- **D3 不改内部主键**：registry/clients/pending 继续用 Discord channelId 当 key。后果：每个 agent 仍必须有 Discord 频道才能被创建。「纯 API agent（无 Discord 频道）」是未来需求，届时再引入内部 id——现在做是投机。
- **D4 peer 协作不动**：`#agent-exchange` 的信任模型就是「频道成员即受信」，这是特性不是耦合。
- **D5 无持久化事件存储**：历史事实的权威在 jsonl，事件总线只做实时 + 500 条环形补发。要历史就读 jsonl（已有纯库）。
- **D6 管理面不进 API**：管理按钮/看板/slash 留 Discord。网页端若将来要管理能力，另行设计（权限模型完全不同）。

## 7. 测试与验收

- 新增 `tests/event-bus.test.ts`（emit/subscribe/replay/环形淘汰）、`tests/api-tokens.test.ts`（CRUD、scope、限流纯逻辑）。
- `router.test.ts` 扩展：ApiUserEndpoint、`resolveReplyTarget("api:...")`。
- live 验证（照惯例 sandbox 走一遍）：
  - `curl -N /events` 期间让某 agent 跑一轮工具调用，事件齐全、seq 连续、断线 `Last-Event-ID` 补发正确；
  - token 全链路：POST → agent 回复 → wait 模式拿到 / SSE 收到；越权 agent 403；token revoke 后 401；
  - Discord 侧回归：tool 流、💬 文本、drain、按钮、peer 路由行为不变。

## 8. 工作量与发布

| Phase | 内容 | 预估 | 风险 |
|-------|------|------|------|
| A | event-bus + 埋点 + SSE + 绑定收紧 | ~350 行 + 测试 | 低（纯旁路） |
| B | tokens + API 路由 + ApiUserEndpoint + deliverToApi + CLI | ~600 行 + 测试 | 中（reply 回路加分支，需盯 pending 语义） |

- A 独立可发布；B 依赖 A 的 event-bus。
- 版本：合并发一个 **minor**（headline：「现在可以不经 Discord、凭 token 通过 HTTP API 与 agent 对话，并实时订阅事件流」）。遵守攒批规则，与当期其他改动一起出。
