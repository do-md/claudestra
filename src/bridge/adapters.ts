/**
 * v2.6.0+ ChatAdapter —— 出站消息的平台抽象（设计 docs/design-multi-frontend.md §3.3 / §6 C1）。
 *
 * 每个前端平台一个 adapter。deliverToUser 用 parseChatId 拿 transport，从这里
 * 的注册表取 adapter 调 send() —— 核心不再假设「用户 = Discord 频道」。
 *
 * C1 阶段只有 discord adapter（bridge.ts ready 时注册，内部还是 discordReply，
 * 挪壳不挪逻辑）。接入 Telegram = 实现这个接口 + registerAdapter，核心零改动。
 *
 * NeutralMessage 的按钮/选单 JSON 与交互回传语义（[button:<id>] / [select:<id>:<v>]）
 * 是冻结合同（设计 §3.2，additive-only）。降级规则写死在各 adapter 内部：
 * 无 buttons 能力 → 渲染成文本编号列表；超长 → 按 caps.maxTextLen 分块。
 */

export interface NeutralMessage {
  text: string;
  /** 中性 UI 组件（现有 buttons/select 的 raw JSON schema） */
  components?: unknown[];
  /** 出站附件的本地绝对路径 */
  files?: string[];
  /** 平台内的消息引用 id（回复哪条） */
  replyTo?: string;
}

export interface ChatAdapterCaps {
  maxTextLen: number;
  buttons: boolean;
  edit: boolean;
  files: boolean;
  typing: boolean;
}

export interface ChatAdapter {
  transport: string;
  caps: ChatAdapterCaps;
  /** 出站。分块、组件渲染、平台限速都是 adapter 内部职责。返回平台消息 id。 */
  send(destId: string, msg: NeutralMessage): Promise<{ messageIds: string[] }>;
  edit?(destId: string, messageId: string, msg: NeutralMessage): Promise<void>;
  typing?(destId: string, on: boolean): void;
}

const adapters = new Map<string, ChatAdapter>();

export function registerAdapter(adapter: ChatAdapter): void {
  adapters.set(adapter.transport, adapter);
  console.log(`🔌 ChatAdapter 注册: ${adapter.transport}`);
}

export function adapterFor(transport: string): ChatAdapter | null {
  return adapters.get(transport) ?? null;
}

export function registeredTransports(): string[] {
  return [...adapters.keys()];
}
