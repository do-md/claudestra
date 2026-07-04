#!/bin/bash
# Claudestra Web-only 大总管（master orchestrator）守护封装。
#
# 由 launchd LaunchAgent `com.claudestra.web-launcher` 调用（RunAtLoad + KeepAlive）。
# `src/launcher.ts` 确保 master tmux 的 window:0 始终跑着大总管 Claude Code，并自动
# 确认它启动时的 session-idle / trust / bypass 提示（否则大总管会卡在提示上）。
#
# 与 Discord 模式的唯一差别：CONTROL_CHANNEL_ID 用合成的 local- id（无真 Discord #control）。
# 大总管的 reply() 输出经 Bridge tee 到 Web；worker agent 由大总管调 manager.ts 创建。
#
# 前置：web-only-bridge.sh 起的 Bridge 必须带**相同**的 CONTROL_CHANNEL_ID。
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"

# ⚠ 必须与 scripts/web-only-bridge.sh 的 CONTROL_CHANNEL_ID 完全一致
export CONTROL_CHANNEL_ID="${CONTROL_CHANNEL_ID:-local-master-control}"
# 大总管在回复里如何称呼操作者
export USER_NAME="${USER_NAME:-老板}"

# Web-only：绝不误连 Discord
unset DISCORD_BOT_TOKEN
cd "$REPO"
exec "$BUN" run src/launcher.ts
