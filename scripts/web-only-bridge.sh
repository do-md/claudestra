#!/bin/bash
# Claudestra Web-only 常驻 Bridge 守护封装。
#
# 由 launchd LaunchAgent `com.claudestra.web-bridge` 调用（RunAtLoad + KeepAlive），
# 生命周期与任何 Claude Code 会话/终端**完全解耦**：会话杀掉照样活、崩溃自拉、开机自起。
#
# 职责：
#   ① 幂等确保 master tmux session 存在（manager create/kill/restart 往它里加 window）
#   ② 以 Web-only 模式 exec Bridge（强制 unset DISCORD_BOT_TOKEN）
# KeepAlive=true → Bridge 若退出，launchd 重跑本脚本，master session 每次被重新确保。
#
# 说明：Web-only 不需要 launcher.ts（那会额外起一个 Discord「大总管」Claude Code，
# Web 路径用不到）。master session 仅需「存在」，worker agent 的 Claude Code 由
# manager 经 tmux send-keys 在交互 shell 里拉起（source ~/.zshrc → nvm → claude）。
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOCK="/tmp/claude-orchestrator/master.sock"
BUN="$HOME/.bun/bin/bun"
TMUX_BIN="$(command -v tmux || echo /opt/homebrew/bin/tmux)"

mkdir -p /tmp/claude-orchestrator

# ① 幂等确保 master session（base-index 0，与 launcher.ts 一致）
if ! "$TMUX_BIN" -S "$SOCK" has-session -t master 2>/dev/null; then
  "$TMUX_BIN" -S "$SOCK" new-session -d -s master -c "$REPO"
  "$TMUX_BIN" -S "$SOCK" set-option -t master base-index 0 2>/dev/null || true
fi

# ② Web-only：即便环境里有 token 也强制不带，绝不误连 Discord
unset DISCORD_BOT_TOKEN
cd "$REPO"
exec "$BUN" run src/bridge.ts
