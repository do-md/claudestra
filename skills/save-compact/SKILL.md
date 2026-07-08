---
name: save-compact
description: 先把当前会话的关键信息持久化到长期记忆（有 mem0 用 mem0，没有就用 Claude Code 自带 memory），然后自动 /compact 压缩上下文。当上下文过大、收到用量看板提醒、或用户说"存记忆压缩"/"save-compact"时触发。
user-invocable: true
---

# 保存记忆 + Compact 上下文

上下文太大时，先抢救会话里的关键信息到长期记忆，再压缩 —— 避免 /compact 的摘要丢掉重要细节。整个流程你自己完成，不要再问用户确认。

## 第 1 步：挑重点存记忆

从当前会话里挑**值得跨会话记住**的内容（是筛选，不是全部倒进去）：

- 正在进行的任务：目标、当前进度、下一步计划
- 已做出的关键决策 + 理由
- 踩过的坑 / 已验证走不通的路线（防止重蹈）
- 用户明确表达的偏好、规矩、约束
- 重新发现成本高的信息：关键文件路径、命令、配置、账号/服务的对应关系

**存储后端按优先级自动选，不要问用户用哪个：**

1. **mem0**：如果你的工具列表里有 `mcp__mem0__memory_write` → 用它。每条独立事实调一次 write（mem0 自动去重，重复写会返回 NOOP/UPDATE，正常）。
2. **Claude Code 自带 memory**：没有 mem0 时，用你系统提示里描述的 memory 目录机制（每条记忆一个文件 + 更新 MEMORY.md 索引）。
3. **都没有**：追加到项目 CLAUDE.md 的合适段落（新开一个 `## Session notes` 段也行）。

宁缺毋滥：5~15 条事实为宜；已在记忆里的不要重复存。

## 第 2 步：安排自动 compact

存完记忆后，用 Bash 安排一个后台任务，在本轮结束后向你自己的 Claude Code 发 `/compact`：

```bash
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  nohup bash -c '
    sleep 10
    tmux send-keys -t "$TMUX_PANE" -l "/compact"
    sleep 0.4
    tmux send-keys -t "$TMUX_PANE" Enter
  ' >/dev/null 2>&1 &
  disown
  echo "compact scheduled"
else
  echo "not in tmux"
fi
```

- 输出 `compact scheduled` → 本轮结束约 10 秒后 compact 会自动执行。
- 输出 `not in tmux`（不在 tmux 里跑）→ 跳过，最后提示用户手动执行 `/compact`。

## 第 3 步：告知结果

最后简要告诉用户（在 Claudestra/Discord 环境用 reply 工具，注意 reply 要在安排 compact 的 Bash **之前或紧接着**完成，别拖到 compact 触发之后）：

- 存了哪几条记忆（一行一条的简短列表）
- compact 已安排（约 10 秒后自动执行）/ 或请手动 `/compact`
