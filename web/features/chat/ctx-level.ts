/**
 * 上下文占用色阶(200k 窗口,owner 2026-07-14 指定阈值):
 *   ≥75%(150k) deep —— 深红,事态严重
 *   ≥50%(100k) high —— 红
 *   ≥20%(40k)  mid  —— 黄,开始留意
 *   其余        none —— 不打扰
 * 各处(顶栏徽章/侧栏背景条/用量面板 Bar)按档位映射自己的样式,
 * 「深红」用 error 实色/加深透明度表达——daisyUI 没有深红 token,
 * 实色块与浅色块的对比在明暗两主题下都成立。
 */
export type CtxLevel = "deep" | "high" | "mid" | "none";

export function ctxLevel(tokens: number): CtxLevel {
  if (tokens >= 150_000) return "deep";
  if (tokens >= 100_000) return "high";
  if (tokens >= 40_000) return "mid";
  return "none";
}
