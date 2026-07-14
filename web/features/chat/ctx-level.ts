/**
 * 上下文占用色阶(1M 窗口——Fable 5 的上下文不是 200k;此前按 200k 算,
 * 389k 的会话直接爆表深红,实际才 39%,正是「变红太快」的根因)。
 * owner 2026-07-14 指定绝对档位:
 *   ≥750k(75%) deep —— 深红,该压缩了
 *   ≥500k(50%) high —— 红
 *   ≥200k(20%) mid  —— 黄,开始留意
 *   其余         none —— 不打扰
 * 各处(顶栏徽章/侧栏背景条/用量面板 Bar)按档位映射自己的样式,
 * 「深红」用 error 实色/加深透明度表达——daisyUI 没有深红 token,
 * 实色块与浅色块的对比在明暗两主题下都成立。
 */
export type CtxLevel = "deep" | "high" | "mid" | "none";

/** 上下文窗口参考刻度(Fable 5 = 1M tokens) */
export const CTX_WINDOW = 1_000_000;

export function ctxLevel(tokens: number): CtxLevel {
  if (tokens >= 750_000) return "deep";
  if (tokens >= 500_000) return "high";
  if (tokens >= 200_000) return "mid";
  return "none";
}
