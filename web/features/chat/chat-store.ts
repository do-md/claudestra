"use client";
import { createReactStore, ZenithStore } from "@do-md/zenith";
import type { AgentSession, ChatMessage } from "./type";
import { consumeSSEStream, processStreamEvent, type StreamSink } from "./stream";
import type { WebStreamEvent } from "@/lib/chat/events";

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
}

/**
 * Chat 中枢：agent 会话列表 + 当前会话消息 + 段级流式收发。
 * 数据源是 Bridge（v1 经 mock-bridge），前端消费模式沿用 claude-os：
 * 每个 agent 一条持久 SSE 流；send 只 fire-and-forget 注入，输出经该流回来。
 * streamGen 代际门控：切走 agent 时自增令旧流回调失效，不污染新视图。
 */
export class ChatStore extends ZenithStore<ChatState> implements StreamSink {
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamGen = 0;
  /** openAgent 代际：切走 agent 时自增，令历史加载 / 后续连流的旧回调失效。 */
  private openGen = 0;
  private seq = 0;

  constructor() {
    super({
      agents: [],
      loadingAgents: false,
      activeAgent: "",
      messages: [],
      loadingHistory: false,
      streaming: false,
      awaitingChunk: false,
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
    this.detachActiveStream();
    const gen = ++this.openGen;
    this.produce((s) => {
      s.activeAgent = name;
      s.messages = [];
      s.loadingHistory = true;
      s.streaming = false;
      s.awaitingChunk = false;
    });
    // 先拉历史（刷新/切换不丢），再连持久流承接新输出
    await this.loadMessages(name, gen);
    if (gen !== this.openGen) return; // 已切走
    // 持久流 fire-and-forget（不 await，否则会一直阻塞到流关闭）
    void this.openStream(name);
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

  public async send(text: string) {
    const display = text.trim();
    if (!display || !this.state.activeAgent || this.state.streaming) return;
    this.produce((s) => {
      s.messages.push({ id: this.nextId(), role: "user", content: display });
      s.streaming = true;
      s.awaitingChunk = true;
    });
    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: this.state.activeAgent, text: display }),
      });
      if (res.status === 401) return this.gotoLogin();
      // 输出经已打开的持久流回来，这里不读响应体
    } catch {
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
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
    if (status === "done")
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
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
}

export const {
  StoreProvider: ChatStoreProvider,
  useStore: useChatStore,
  useStoreApi: useChatStoreApi,
} = createReactStore(ChatStore);
