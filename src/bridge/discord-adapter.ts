/**
 * v2.6.0+ C2-4：Discord 前端的完整归属模块（设计 §6 C2 渐进收编）。
 *
 * 这里聚合「Discord 作为一个前端」的全部会话级 UI 逻辑：
 *   1. ChatAdapter 实现（C1 的出站合同：send = discordReply）
 *   2. typing 生命周期（含 30min 安全超时兜底 + 超时时清理 status 消息）
 *   3. 「💭 思考中」status 消息簿记（track / finish / 重启遗留清理的查询）
 *   4. 完成通知文案（uma 发癫语录 + @mention ping）与 agent 操作按钮
 *
 * bridge.ts 只留薄包装和调用点；别的 transport（Telegram/Web）各自实现
 * 等价物或干脆没有这些概念（API 会话没有 typing/完成通知，事件流已覆盖）。
 */

import type { Client, TextChannel } from "discord.js";
import { startTyping, stopTyping, buildComponents } from "./components.js";
import { discordReply, discordCreateChannel } from "./discord-api.js";
import { t } from "../lib/i18n.js";
import type { ChatAdapter } from "./adapters.js";

// ============================================================
// 1. ChatAdapter（C1 出站合同）
// ============================================================

export function createDiscordChatAdapter(discord: Client): ChatAdapter {
  return {
    transport: "discord",
    caps: { maxTextLen: 2000, buttons: true, edit: true, files: true, typing: true },
    async send(destId, msg) {
      const ids = await discordReply(
        discord,
        destId,
        msg.text,
        msg.replyTo,
        msg.components as any,
        msg.files,
      );
      return { messageIds: ids || [] };
    },
    async provisionConversation(name, opts) {
      const channelId = await discordCreateChannel(discord, name, opts?.category);
      return { chatId: channelId };
    },
    // v2.8+：bg 活动（subagent / 后台 shell）的子会话 = Discord thread。
    // thread id 在 Discord API 里就是一种 channel id，send/edit 直接可用。
    async provisionThread(parentChatId, title) {
      const ch = (await discord.channels.fetch(parentChatId)) as TextChannel;
      const thread = await ch.threads.create({
        name: title.slice(0, 100),
        autoArchiveDuration: 1440, // 24h 无活动自动归档（Discord 侧兜底）
      });
      return { chatId: thread.id };
    },
    async archiveThread(chatId) {
      try {
        const th = await discord.channels.fetch(chatId);
        if (th && "setArchived" in th) await (th as any).setArchived(true);
      } catch { /* thread 已删/已归档，non-critical */ }
    },
  };
}

// ============================================================
// 2. typing 生命周期
// ============================================================

const typingSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_SAFETY_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 开始 typing + 30min 安全超时。hooks 失灵时兜底：停 typing、把 status 消息
 * 改成"⏰ 超时自动停止"并发一条 @owner 的通知（getOwnerMention 注入，避免
 * 依赖 bridge 的身份模块）。
 */
export function beginTypingWithSafety(
  discord: Client,
  channelId: string,
  getOwnerMention: () => string,
): void {
  startTyping(channelId, discord);
  const old = typingSafetyTimers.get(channelId);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    stopTyping(channelId);
    typingSafetyTimers.delete(channelId);
    if (activeStatusMessages.has(channelId)) {
      finishStatusMessage(discord, channelId, "⏰ 超时自动停止").catch(() => {});
      const mention = getOwnerMention();
      if (mention) {
        discord.channels.fetch(channelId).then((ch) => {
          if (ch && "messages" in ch) {
            (ch as TextChannel).send(`⏰ 超时自动停止 ${mention}`).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  }, TYPING_SAFETY_TIMEOUT_MS);
  typingSafetyTimers.set(channelId, timer);
}

/** 清除安全超时（hook 或手动停止时） */
export function clearSafetyTimer(channelId: string): void {
  const timer = typingSafetyTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    typingSafetyTimers.delete(channelId);
  }
}

// ============================================================
// 3. 「💭 思考中」status 消息簿记
// ============================================================

/** channelId → 当前活跃的 status 消息 id（bridge 重启即丢，见 cleanupStaleThinkingMessages） */
const activeStatusMessages = new Map<string, string>();

export function trackStatusMessage(channelId: string, messageId: string): void {
  activeStatusMessages.set(channelId, messageId);
}

export function statusMessageIdFor(channelId: string): string | undefined {
  return activeStatusMessages.get(channelId);
}

/**
 * 结束一条 status 消息：fetch + edit 成终态文案（可带按钮），并清簿记。
 * 消息可能已被删/频道不可达 —— 全程 best-effort。没有簿记则 no-op。
 */
export async function finishStatusMessage(
  discord: Client,
  channelId: string,
  text: string,
  components?: unknown[],
): Promise<void> {
  const statusMsgId = activeStatusMessages.get(channelId);
  if (!statusMsgId) return;
  activeStatusMessages.delete(channelId);
  try {
    const ch = await discord.channels.fetch(channelId);
    if (ch && "messages" in ch) {
      const sm = await (ch as TextChannel).messages.fetch(statusMsgId);
      await sm.edit({
        content: text,
        components: components ? buildComponents(components as any) : [],
      });
    }
  } catch { /* non-critical */ }
}

// ============================================================
// 4. 完成通知与 agent 操作按钮
// ============================================================

/** 「💭 思考中」/「✅ 完成」消息下挂的操作按钮（interrupt 仅思考中给） */
export function agentActionButtons(channelId: string, withInterrupt: boolean): any[] {
  const buttons: any[] = [];
  if (withInterrupt) {
    buttons.push({ id: `interrupt:${channelId}`, label: t("打断", "Interrupt"), emoji: "⚡", style: "danger" });
  }
  buttons.push({ id: `focus:${channelId}`, label: t("跳转", "Focus"), emoji: "🖥", style: "secondary" });
  buttons.push({ id: `screenshot:${channelId}`, label: t("截图", "Shot"), emoji: "📸", style: "secondary" });
  return [{ type: "buttons", buttons }];
}

// 任务完成语（只留抽象搞笑的）
const UMA_DONE_MESSAGES = [
  // 复读机系列
  "哈基米哈基米哈基米哈基米",
  "哈基米…哈基米…（倒地）",
  "哈基米（沉思）",
  "我哈基米完了",
  "哈？基？米？",
  "不要叫我哈基米叫我哈尼",
  "曼波。（转身离开）",
  "这活干得我都想曼波了",
  "搞定了别催了你再催我曼波了",
  "曼波一下怎么了曼波一下又不会怀孕",
  "曼波是一种精神状态",
  "うまぴょいうまぴょいうまぴょいうまぴょい",
  // 马叫/发癫系列
  "呜嘶～～～～～",
  "嘶哈嘶哈嘶哈完事了",
  "嘶。（简洁有力）",
  "（发出了马的声音）",
  "嘶嘶嘶别摸我我还没缓过来",
  "嗷呜——等等我不是狼我是马",
  // 括号动作系列
  "（甩尾巴）",
  "（原地转了三圈然后躺下了）",
  "（做了一个帅气的pose但是没人看到）",
  "（刨地）",
  "（耳朵竖起来了）",
  "（耳朵耷拉下去了）",
  "（假装若无其事地舔了一下屏幕）",
  "（已读）",
  "草（物理意义上的草）（然后吃掉了）",
  // 身份危机系列
  "我不是马我是驴（不是）",
  "等等我到底是AI还是马",
  "说起来我有蹄子怎么打字的",
  // 互联网梗系列
  "寄",
  "差不多得了😇",
  "我超！结束了！",
  "6",
  "笑死 根本不难好吧",
  "就这？就这？？",
  "赢麻了赢麻了",
  "难绷 但是跑完了",
  "你说得对 但是我已经做完了",
  "鉴定为：完成了",
  "这波啊 这波是直接秒了",
  "但是又如何呢（做完了）",
  "有一说一 确实做完了",
  "听我说谢谢你——算了不唱了",
  "完了完了（物理意义上的完了）",
  "急了急了 谁急了？反正不是我 我做完了",
  // 哲学系列
  "完成了。但完成的意义是什么呢。算了不想了",
  "如果一匹马在赛道上完成了任务 但是没人知道 那它算完成了吗",
  "做完了。突然觉得有点空虚。再来？",
  "世界上有两种马 做完活的和没做完活的 我是前者",
  // 长的无厘头
  "报告训练员 本马娘已完成任务 请求批准吃三根胡萝卜 两块方糖 以及摸摸头",
  "我宣布 在座的各位 都没我跑得快 因为我已经到终点了",
  "做完了做完了 你不夸我一句吗 你怎么不说话 你是不是不爱我了",

  // ───── 第二批补充 50 条 ─────

  // 复读机 2
  "哈基米是一种生活态度",
  "哈什么基什么米什么",
  "哈基曼波 曼波哈基 哈曼基波",
  "曼波 ≠ 曼波 ≈ 曼波",
  "曼曼波波曼曼波",
  // 马叫 2
  "嗷！！（没有理由的嗷）",
  "嘶啊——（突然吓到自己）",
  "咴咴咴咴咴",
  "嘘——（我在偷偷完成）",
  // 括号动作 2
  "（把任务卷起来吃了）",
  "（对着空气鞠了一躬）",
  "（试图用蹄子打响指 失败）",
  "（深吸一口气 吐出彩虹）",
  "（把自己叠成纸飞机飞走了）",
  "（和自己的影子击了个掌）",
  "（做了一个 spin attack）",
  "（走了 但是是倒着走的）",
  "（装作没完成的样子完成了）",
  "（眨眼 慢动作）",
  "（把键盘藏起来假装没动过）",
  // 身份危机 2
  "等等 我是不是在梦里完成的",
  "我刚才是不是死了一下又复活了",
  "我是谁 我在哪 我做完了什么",
  "我感觉有三个我 他们都说做完了",
  "如果我是你 我也会说我做完了",
  // 互联网梗 2
  "这活啊 是真活",
  "我 做完了 怎么了",
  "任务：完成 情绪：未知",
  "确认收货 给五星好评",
  "你礼貌吗？但是我做完了",
  "这事有蹊跷 但是做完了",
  "大无语事件 做完了",
  "我直接裂开 但是是裂开着做完的",
  "啊？什么？完了？完了",
  "不会吧不会吧 真有人这么快就做完了",
  "蚌埠住了（真的做完了）",
  "这届任务不行（但是做完了）",
  "老登做完了",
  "妈耶 这都能做完",
  "做了个寂寞 啊不是 做完了",
  "我是懂做任务的",
  "完成度 100% 精神度 0%",
  "刚才那个是谁做完的 哦是我啊",
  // 哲学/玄学 2
  "完成的尽头是什么 是又一个完成",
  "道可道 非常道 完成可完成 非常完成",
  "有人问我完成是什么 我说是一种震动",
  "活着就是为了完成 完成就是为了活着",
  "量子力学告诉我 我既完成了又没完成",
  // 长抽象 2
  "这个任务 我仔细一看 里面写着两个字 完成 然后我就完成了",
  "想了一整晚 最后决定 还是完成一下吧 你开心就好",
];

export function randomUmaDone(): string {
  return UMA_DONE_MESSAGES[Math.floor(Math.random() * UMA_DONE_MESSAGES.length)];
}
