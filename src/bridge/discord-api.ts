/**
 * Discord API 操作：发消息、获取历史、反应、编辑、创建/删除频道
 */

import { TextChannel, PermissionFlagsBits, OverwriteType, type Client } from "discord.js";
import { buildComponents } from "./components.js";

let botUserId: string | null = null;
const recentBotMessageIds = new Set<string>();

export function setBotUserId(id: string) {
  botUserId = id;
}

export function getBotUserId() {
  return botUserId;
}

export function trackSentMessage(id: string) {
  recentBotMessageIds.add(id);
  if (recentBotMessageIds.size > 200) {
    const first = recentBotMessageIds.values().next().value;
    if (first) recentBotMessageIds.delete(first);
  }
}

export function isBotMessage(id: string) {
  return recentBotMessageIds.has(id);
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > limit) {
      if (current) chunks.push(current);
      current = line.length > limit ? line.slice(0, limit) : line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function discordReply(
  discord: Client,
  chatId: string,
  text: string,
  replyTo?: string,
  components?: any[],
  files?: string[]
): Promise<string[]> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("send" in channel)) {
    throw new Error(`频道 ${chatId} 不存在或无法发送消息`);
  }

  const textChannel = channel as TextChannel;
  const messageIds: string[] = [];
  const discordComponents = components
    ? buildComponents(components)
    : undefined;

  const chunks = chunkText(text, 2000);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const options: any = { content: chunks[i] };
    if (i === 0 && replyTo) {
      options.reply = { messageId: replyTo };
    }
    if (isLast && discordComponents?.length) {
      options.components = discordComponents;
    }
    if (isLast && files?.length) {
      options.files = files.map((f) => ({ attachment: f }));
    }
    const sent = await textChannel.send(options);
    messageIds.push(sent.id);
    trackSentMessage(sent.id);
  }

  return messageIds;
}

export async function discordFetchMessages(
  discord: Client,
  channelId: string,
  limit: number = 20
): Promise<string> {
  const channel = await discord.channels.fetch(channelId);
  if (!channel || !("messages" in channel)) {
    throw new Error(`频道 ${channelId} 不存在`);
  }

  const textChannel = channel as TextChannel;
  const messages = await textChannel.messages.fetch({
    limit: Math.min(limit, 100),
  });

  const sorted = [...messages.values()].reverse();
  const lines = sorted.map((m) => {
    const tag = m.author.bot ? "[bot]" : "";
    return `[${m.id}] ${m.author.username}${tag}: ${m.content}`;
  });

  return lines.join("\n");
}

export async function discordReact(
  discord: Client,
  chatId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("messages" in channel)) throw new Error("频道不存在");
  const msg = await (channel as TextChannel).messages.fetch(messageId);
  await msg.react(emoji);
}

export async function discordEditMessage(
  discord: Client,
  chatId: string,
  messageId: string,
  text: string
): Promise<void> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("messages" in channel)) throw new Error("频道不存在");
  const msg = await (channel as TextChannel).messages.fetch(messageId);
  if (msg.author.id !== botUserId) throw new Error("只能编辑 bot 自己的消息");
  await msg.edit(text);
}

export async function discordCreateChannel(
  discord: Client,
  name: string,
  categoryName?: string
): Promise<string> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID 未配置");
  const guild =
    discord.guilds.cache.get(guildId) ??
    (await discord.guilds.fetch(guildId).catch(() => null));
  if (!guild) throw new Error(`Bot 未加入 guild ${guildId}`);

  let parentId: string | undefined;
  if (categoryName) {
    let cat = guild.channels.cache.find(
      (c) => c.name === categoryName && c.type === 4
    );
    if (!cat) {
      // category 不存在，自动创建。注意：新建 category 也要 deny 已知的 peer bot，
      // 否则之后 category 下面的频道继承"无 override" → peer 默认可见。
      cat = await guild.channels.create({
        name: categoryName,
        type: 4, // GuildCategory
        permissionOverwrites: await buildPeerDenyOverrides(guild),
      });
    }
    parentId = cat?.id;
  }

  // v2.0.20+ 新频道创建时直接带 peer bot 的 deny ViewChannel overrides，避免新建的
  // agent 频道被 peer 可见。之前的 scopePeerToAgentExchange 只在 peer 加入瞬间扫一次
  // 当时已存在的频道；以后通过 manager.ts create 新建的频道没在那一次循环里、
  // category 也可能在 peer scope 之后才生 → peer 默认能看到。这里在 create 时
  // 直接显式 deny 兜住。
  const ch = await guild.channels.create({
    name,
    parent: parentId,
    topic: `Claude Code agent channel`,
    permissionOverwrites: await buildPeerDenyOverrides(guild),
  });
  return ch.id;
}

/**
 * 读 peers.json 列出所有已知 peer bot，返回 deny ViewChannel 的 permissionOverwrites，
 * 供 `guild.channels.create({ permissionOverwrites })` 用。peers.json 没条目返回空数组。
 *
 * v2.2.0+ 关键修复：**按 peer bot 的 user id 直接 deny（member overwrite）**，不再去
 * 查它的 managed role。之前查 role 用 `guild.roles.cache.find(... tags.botId ...)`，
 * bridge 刚重启时 guild role 缓存是冷的 → 查不到 role → 返回空 → 新建的 agent 频道
 * 没带 deny → **被 peer bot 看见**（owner 实测：重启后建的测试频道全被 peer 拿到访问）。
 * bot user id 从 peers.json 直接拿，永远可靠，不依赖任何缓存。
 *
 * 只 deny ViewChannel —— 不动 SendMessages，#agent-exchange 的 allow 单独管理。
 */
async function buildPeerDenyOverrides(_guild: any): Promise<any[]> {
  try {
    const { readPeers } = await import("../lib/peers.js");
    const peers = await readPeers();
    if (!peers.peerBots || peers.peerBots.length === 0) return [];
    return peers.peerBots.map((pb) => ({
      id: pb.id,
      type: OverwriteType.Member,
      deny: [PermissionFlagsBits.ViewChannel],
    }));
  } catch {
    return [];
  }
}

export async function discordDeleteChannel(
  discord: Client,
  channelId: string
): Promise<void> {
  const channel = await discord.channels.fetch(channelId);
  if (channel && "delete" in channel) {
    await (channel as TextChannel).delete();
  }
}
