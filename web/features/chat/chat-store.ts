"use client";
import { createReactStore, ZenithStore } from "@do-md/zenith";
import type {
  AgentSession,
  ChatMessage,
  ChatAttachmentView,
  PendingPermission,
  PendingAsk,
} from "./type";
import { consumeSSEStream, processStreamEvent, type StreamSink } from "./stream";
import type { WebStreamEvent } from "@/lib/chat/events";

/**
 * roster 变化指纹：捕获会影响侧栏渲染的字段（成员 + 状态 + 展示名 + 置顶/mock 标记）。
 * 轮询用它判断列表是否真的变了，只有变了才更新 state。
 */
function agentsSignature(list: AgentSession[]): string {
  return list
    .map((a) => `${a.name}${a.status}${a.displayName}${a.pinnedMaster ? 1 : 0}${a.mock ? 1 : 0}`)
    .join("");
}

interface ChatState {
  agents: AgentSession[];
  loadingAgents: boolean;
  /** 当前打开的 agent 名（""=未选） */
  activeAgent: string;
  messages: ChatMessage[];
  /** 正在拉取历史消息（openAgent → loadMessages 期间） */
  loadingHistory: boolean;
  /** 本轮流式进行中 */
  streaming: boolean;
  /** 本轮已起、还没有任何输出 → 显示「思考中」 */
  awaitingChunk: boolean;
  /** Phase 2：当前会话待处理的权限 / session-idle 卡（null=无） */
  pendingPermission: PendingPermission | null;
  /** Phase 2：当前会话待处理的 AskUserQuestion 卡（null=无） */
  pendingAsk: PendingAsk | null;
}

/**
 * Chat 中枢：agent 会话列表 + 当前会话消息 + 段级流式收发。
 * 数据源是 Bridge（/api/v1 + /events，BFF 翻译），前端消费模式沿用 claude-os：
 * 每个 agent 一条持久 SSE 流；send 只 fire-and-forget 注入，输出经该流回来。
 * streamGen 代际门控：切走 agent 时自增令旧流回调失效，不污染新视图。
 */
export class ChatStore extends ZenithStore<ChatState> implements StreamSink {
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamGen = 0;
  /** openAgent 代际：切走 agent 时自增，令历史加载 / 后续连流的旧回调失效。 */
  private openGen = 0;
  private seq = 0;
  /**
   * 每个 agent 的会话快照缓存 —— **只做切回时的首屏即时展示**（stale-while-
   * revalidate）：切走存快照，切回先显示快照、后台重拉历史拉回即替换。
   *
   * 曾经（2026-07-10 前）切回只显示快照不重拉，导致两类不一致：离开期间 agent
   * 的新消息永远看不到（流只带新事件）、和刷新页面看到的版本不同。当时不敢重拉
   * 是因为历史解析丢了所有 channel 用户消息（isMeta 过滤 bug），回合结构被破坏、
   * 窗口一滑内容就大变；session-history.ts 解包修复后重拉是稳定的（气泡 id 用
   * jsonl seq，追加只影响尾部），缓存降级为防白屏的过渡帧。
   */
  private messageCache = new Map<string, ChatMessage[]>();

  constructor() {
    super({
      agents: [],
      loadingAgents: false,
      activeAgent: "",
      messages: [],
      loadingHistory: false,
      streaming: false,
      awaitingChunk: false,
      pendingPermission: null,
      pendingAsk: null,
    });
  }

  private nextId() {
    return `cm${++this.seq}`;
  }

  private gotoLogin() {
    if (typeof window !== "undefined") window.location.href = "/login";
  }

  // ─── agent 列表 ──────────────────────────────────────────

  public async loadAgents() {
    this.produce((s) => {
      s.loadingAgents = true;
    });
    try {
      const res = await fetch("/api/agents");
      if (res.status === 401) return this.gotoLogin();
      const json = (await res.json()) as { data?: AgentSession[] };
      this.produce((s) => {
        s.agents = json.data ?? [];
        s.loadingAgents = false;
      });
    } catch {
      this.produce((s) => {
        s.loadingAgents = false;
      });
    }
  }

  /**
   * 静默刷新会话列表（轮询用）。感知本端之外的 roster 变化——master(大总管) /
   * CLI / 其他浏览器端 创建 / kill / restart 的 agent。
   * 与 loadAgents 的区别：不 toggle loadingAgents（不触发「加载中…」），且仅在
   * 列表实际变化时才 produce，避免每轮轮询都替换数组引用导致侧栏空转 re-render。
   * 401 静默返回（轮询不主动跳登录，交给显式操作处理）。
   */
  public async refreshAgents() {
    try {
      const res = await fetch("/api/agents");
      if (res.status === 401) return;
      const json = (await res.json()) as { data?: AgentSession[] };
      const next = json.data ?? [];
      if (agentsSignature(next) === agentsSignature(this.state.agents)) return;
      this.produce((s) => {
        s.agents = next;
      });
    } catch {
      /* 轮询失败静默，下一轮再试 */
    }
  }

  // ─── 会话生命周期（新建 / kill / restart）──────────────────

  /** 新建 agent（经 BFF → Bridge runManager create）。成功后刷新列表并打开。 */
  public async createAgent(
    name: string,
    dir: string,
    purpose?: string
  ): Promise<{ ok: boolean; error?: string; agent?: string }> {
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dir, purpose }),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        agent?: string;
      };
      if (!res.ok || json.ok === false) {
        return { ok: false, error: json.error || "创建失败" };
      }
      await this.loadAgents();
      const created = json.agent || name;
      await this.openAgent(created);
      return { ok: true, agent: created };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** kill agent（经 BFF → Bridge runManager kill）。成功后刷新列表。 */
  public async killAgent(
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycleAction("kill", name);
  }

  /** restart agent（经 BFF → Bridge runManager restart）。成功后刷新列表。 */
  public async restartAgent(
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycleAction("restart", name);
  }

  private async lifecycleAction(
    action: "kill" | "restart",
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/agents/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        return { ok: false, error: json.error || `${action} 失败` };
      }
      await this.loadAgents();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ─── 打开会话 + 持久流 ─────────────────────────────────────

  public async openAgent(name: string) {
    if (name === this.state.activeAgent) return;
    // 切走前把当前会话快照进缓存，回来时原样恢复（见 messageCache 注释）
    const prev = this.state.activeAgent;
    if (prev) this.messageCache.set(prev, this.state.messages);
    this.detachActiveStream();
    const gen = ++this.openGen;
    const cached = this.messageCache.get(name);
    this.produce((s) => {
      s.activeAgent = name;
      // 有缓存=先秒开上次那份（无 loading 闪烁），拉回最新后整体替换
      s.messages = cached ?? [];
      s.loadingHistory = !cached;
      s.streaming = false;
      s.awaitingChunk = false;
      // 交互卡是 per-session 的：切走先清空，新流连上后 bridge 会 replay 当前 pending。
      s.pendingPermission = null;
      s.pendingAsk = null;
    });
    // 无论有无缓存都重拉历史（stale-while-revalidate）——离开期间 agent 的产出
    // 只存在于 jsonl，不重拉就永远看不到。历史解析已稳定，重拉不再"漂"。
    await this.loadMessages(name, gen);
    if (gen !== this.openGen) return; // 已切走
    // 持久流 fire-and-forget（不 await，否则会一直阻塞到流关闭）
    void this.openStream(name);
  }

  /** 强制从 jsonl 重新拉取当前 agent 的历史（丢弃缓存快照）。刷新入口用。 */
  public async reloadHistory() {
    const name = this.state.activeAgent;
    if (!name) return;
    this.messageCache.delete(name);
    const gen = ++this.openGen;
    this.produce((s) => {
      s.messages = [];
      s.loadingHistory = true;
    });
    await this.loadMessages(name, gen);
  }

  /** 拉某 agent 的历史消息（读 CC session jsonl）。gen 守卫防切换竞态。 */
  private async loadMessages(name: string, gen: number) {
    try {
      const res = await fetch(
        `/api/chat/history?agent=${encodeURIComponent(name)}`
      );
      if (res.status === 401) return this.gotoLogin();
      const json = (await res.json()) as { data?: ChatMessage[] };
      if (gen !== this.openGen) return; // 已切走，丢弃
      this.produce((s) => {
        s.messages = json.data ?? [];
        s.loadingHistory = false;
      });
    } catch {
      if (gen !== this.openGen) return;
      this.produce((s) => {
        s.loadingHistory = false;
      });
    }
  }

  /** 打开某 agent 的持久 SSE 输出流。会话切换 / 重连共用。 */
  private async openStream(name: string) {
    const gen = ++this.streamGen;
    try {
      const res = await fetch(
        `/api/chat/stream?agent=${encodeURIComponent(name)}`
      );
      if (res.status === 401) return this.gotoLogin();
      if (gen !== this.streamGen) return; // 已切走
      const reader = res.body?.getReader();
      if (!reader) return;
      this.streamReader = reader;
      await consumeSSEStream(reader, (evt) => {
        if (gen !== this.streamGen) return;
        processStreamEvent(this, evt);
      });
    } catch {
      /* 断流：保持静默，可由 reconnect 续 */
    } finally {
      // 流关闭/断开时，若本轮仍卡在 streaming（done 没收到、流被掐、bridge 重启），
      // 解锁 composer——别让「■ 停止」永久卡住导致用户发不出/看着像没渲染。仅清当前流。
      if (
        gen === this.streamGen &&
        (this.state.streaming || this.state.awaitingChunk)
      ) {
        this.produce((s) => {
          s.streaming = false;
          s.awaitingChunk = false;
        });
      }
    }
  }

  /** 切走当前 agent：断前端流但不 abort 后端会话；自增代号令旧回调失效。 */
  private detachActiveStream() {
    this.streamGen++;
    const reader = this.streamReader;
    this.streamReader = null;
    if (reader) reader.cancel().catch(() => {});
    if (this.state.streaming || this.state.awaitingChunk)
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
      });
  }

  /** 回前台 / bfcache 恢复：若有活动 agent 但流已断，重开流。 */
  public maybeReconnect() {
    if (!this.state.activeAgent) return;
    if (this.streamReader) return;
    void this.openStream(this.state.activeAgent);
  }

  // ─── 发送 ────────────────────────────────────────────────

  /**
   * 发送一条用户消息。流式进行中也可发（「插入会话」）——claudestra 后端对忙碌
   * agent 无 busy 拦截，消息经 channel 投递后由 Claude Code 原生排队、当前回合边界
   * 处理（Discord 侧本就如此）。这是 claude-os stdin steer 在 claudestra 架构下的等价：
   * 不写进程 stdin，靠 CC 原生排队，语义即「插入正在跑的会话」。
   */
  public async send(text: string, files?: File[]) {
    const display = text.trim();
    const hasFiles = !!files && files.length > 0;
    if ((!display && !hasFiles) || !this.state.activeAgent) return;
    const agent = this.state.activeAgent;
    // 用户气泡内回显：图片给 objectURL 预览，其它给文件名 chip
    const attachments: ChatAttachmentView[] | undefined = hasFiles
      ? files!.map((f) => {
          const isImg = f.type.startsWith("image/");
          return {
            name: f.name,
            kind: isImg ? ("image" as const) : ("file" as const),
            url: isImg ? URL.createObjectURL(f) : undefined,
          };
        })
      : undefined;
    this.produce((s) => {
      // 流式中插话：给当前流式助手气泡定稿，用户插入独立成段（后续输出另起气泡），
      // 避免把「插入前的回复」和「插入后的回复」挤进同一个气泡显得错乱。
      if (s.streaming) {
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "assistant" && last.streamed) last.streamed = false;
      }
      s.messages.push({
        id: this.nextId(),
        role: "user",
        content: display,
        ts: new Date().toISOString(),
        attachments,
      });
      s.streaming = true;
      s.awaitingChunk = true;
    });
    try {
      let res: Response;
      if (hasFiles) {
        // multipart：不手动设 Content-Type，浏览器自动带 boundary
        const fd = new FormData();
        fd.append("agent", agent);
        fd.append("text", display);
        for (const f of files!) fd.append("files", f);
        res = await fetch("/api/chat/send", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent, text: display }),
        });
      }
      if (res.status === 401) return this.gotoLogin();
      if (!res.ok) {
        // 发送失败（agent 离线→502 / 超限→400 等）：解锁 + 附错误提示，
        // 别让「停止」按钮 + 思考态一直卡死（此前给离线 agent 发消息就会一直转）。
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        this.produce((s) => {
          s.streaming = false;
          s.awaitingChunk = false;
          s.messages.push({
            id: this.nextId(),
            role: "assistant",
            content: `⚠️ 发送失败：${j.error || `HTTP ${res.status}`}`,
            ts: new Date().toISOString(),
          });
        });
      }
      // 成功：输出经已打开的持久流回来，这里不读响应体
    } catch (e) {
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
        s.messages.push({
          id: this.nextId(),
          role: "assistant",
          content: `⚠️ 发送失败：${(e as Error).message}`,
          ts: new Date().toISOString(),
        });
      });
    }
  }

  // ─── StreamSink 实现 ─────────────────────────────────────

  /** 确保当前有一个流式助手气泡承接工具/文本；没有则新建。 */
  private ensureLiveAssistant() {
    const last = this.state.messages[this.state.messages.length - 1];
    if (last && last.role === "assistant" && last.streamed) return;
    this.produce((s) => {
      s.messages.push({
        id: this.nextId(),
        role: "assistant",
        content: "",
        streamed: true,
        toolCalls: [],
        ts: new Date().toISOString(),
      });
      s.awaitingChunk = false;
    });
  }

  public addToolCall(
    name: string,
    summary: string,
    state: "running" | "done" | "error"
  ) {
    this.ensureLiveAssistant();
    this.produce((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant") {
        last.toolCalls = last.toolCalls ?? [];
        last.toolCalls.push({ name, summary, state });
      }
      s.awaitingChunk = false;
    });
  }

  public appendAssistantText(text: string) {
    this.ensureLiveAssistant();
    this.produce((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant") last.content += text;
      s.awaitingChunk = false;
    });
  }

  public setStatus(status: "running" | "done") {
    this.produce((s) => {
      if (status === "done") {
        s.streaming = false;
        s.awaitingChunk = false;
      } else if (!s.streaming) {
        // 进入回合 → 锁 composer 成「停止」态。三种触发：本端 send（已置 streaming，
        // 走不到这里）/ 他端（Discord/master/另一浏览器）触发该会话 / 刷新·切回·回前台后
        // 连流时 BFF 补的 status:running（会话本就在回合中）。awaitingChunk 补「思考中」点，
        // 首个工具/文本段到达即由 ensureLiveAssistant 清除。
        s.streaming = true;
        s.awaitingChunk = true;
      }
    });
  }

  public endTurn() {
    this.produce((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant") last.streamed = false; // 定稿
      s.streaming = false;
      s.awaitingChunk = false;
    });
  }

  // ─── Phase 2 交互卡：sink 写入 + 用户回传 ─────────────────────

  public setPermission(p: PendingPermission | null) {
    this.produce((s) => {
      s.pendingPermission = p;
      // 有卡 = 在等用户抉择而非等 agent 输出 → 关掉「思考中」dots
      if (p) s.awaitingChunk = false;
    });
  }

  public setAsk(a: PendingAsk | null) {
    this.produce((s) => {
      s.pendingAsk = a;
      if (a) s.awaitingChunk = false;
    });
  }

  /** POST 一个交互回传（interrupt/permission/auq）到 BFF，统一处理 401/错误。 */
  private async postAction(
    path: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || json.ok === false)
        return { ok: false, error: json.error || "操作失败" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 一键中断：给当前会话的 tmux window 发 Ctrl+C。 */
  public async interrupt(): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    const res = await this.postAction("/api/chat/interrupt", { agent });
    // done 会经 SSE 回来解锁；这里乐观收敛
    if (res.ok)
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
      });
    return res;
  }

  /** 应答权限 / session-idle 卡（action 见 bridge PERM_KEY_SEQ）。 */
  public async resolvePermission(
    action: string
  ): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    // 乐观清卡（bridge 也会经 SSE 推 permission-cleared）
    this.produce((s) => {
      s.pendingPermission = null;
    });
    return this.postAction("/api/chat/permission", { agent, action });
  }

  /** 提交 AskUserQuestion 选择。selections[i]=第 i 题选中的 option index 数组。 */
  public async submitAsk(
    selections: number[][]
  ): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    this.produce((s) => {
      s.pendingAsk = null;
    });
    return this.postAction("/api/chat/auq", {
      agent,
      action: "submit",
      selections,
    });
  }

  /** 取消 AskUserQuestion（给 agent 发 Esc）。 */
  public async cancelAsk(): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    this.produce((s) => {
      s.pendingAsk = null;
    });
    return this.postAction("/api/chat/auq", { agent, action: "cancel" });
  }
}

export const {
  StoreProvider: ChatStoreProvider,
  useStore: useChatStore,
  useStoreApi: useChatStoreApi,
} = createReactStore(ChatStore);
