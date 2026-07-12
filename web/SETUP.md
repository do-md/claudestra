# Claudestra Web Client — Setup & Run

The **Next.js web frontend** for Claudestra — a second front door beside Discord:
PWA-installable, OneSignal push, multi-session streaming chat, and a live remote
terminal. It is a standard **Node/npm** app that talks only to the Bridge's HTTP
API (`/api/v1` + `/api/v1/events`); it does **not** embed the Bun backend.

> Architecture & internals live in [`web/CLAUDE.md`](./CLAUDE.md). The wire
> contract (auth, history pagination, SSE events) is in
> [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md). This file is just
> "how do I install and run it."

---

## Prerequisites

- **Node.js ≥ 20** + npm (Next 16 / React 19). The web app runs on Node, entirely
  separate from the Bun backend — two independent dependency trees.
- **The Claudestra Bridge must be running** and reachable at `BRIDGE_HTTP_URL`
  (default `http://127.0.0.1:3847`). Two ways to get there:
  - **A — you already run Claudestra with Discord** (see [`../SETUP.md`](../SETUP.md)):
    the Bridge, the `claudestra` MCP server, and the Stop hook are already wired by
    `bun run setup`. Skip to [Install the web app](#1-install-the-web-app).
  - **B — Web-only, no Discord bot**: see
    [Run the backend in Web-only mode](#web-only-backend-no-discord) first.
- **Bun** — only needed to run the backend and to issue the API token below.
- **SSH login enabled on the machine.** The web app authenticates against your OS
  account via local SSH/PAM (no separate account system). On macOS enable
  *System Settings → General → Sharing → Remote Login*; otherwise login fails.

---

## 1. Install the web app

```bash
cd web
npm install
```

No monorepo checkout is required: `@do-md/zenith` and `@do-md/common` are vendored
under `web/.packages/` (committed, resolved via `tsconfig.json` paths).
`@do-md/core-react` comes from npm like any other dependency.

---

## 2. Configure environment

```bash
cp .env.example .env.local
```

Fill `.env.local`:

| Variable | Required | Notes |
|---|---|---|
| `CLAUDESTRA_API_TOKEN` | **yes** | Bridge `/api/v1` Bearer token. Issue it (see below). The BFF sends it server-side; the browser never sees it. |
| `BRIDGE_HTTP_URL` | yes | Default `http://127.0.0.1:3847`. **Use `127.0.0.1`, not `localhost`** — the Bridge binds IPv4 only; the `::1` ambiguity causes intermittent 10s `fetch failed` timeouts. |
| `INTERNAL_API_KEY` | yes | Random secret (`openssl rand -hex 32`). Alternative auth (`x-api-key`) for scripts hitting protected API routes. |
| `NEXT_PUBLIC_ONESIGNAL_APPID` / `ONESIGNAL_APP_ID` / `ONESIGNAL_REST_API_KEY` | no | OneSignal Web Push. Leave blank to run without push. |
| `CLAUDESTRA_DATA_ROOT` | no | Overrides the data dir (default `~/.claude-orchestrator/web`), which holds the SQLite for auth sessions + per-agent settings. |

**Issue the API token** (from the repo root, replace `bun` path as needed):

```bash
bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal
```

- `--agents '*,master'` — `*` covers all non-master agents; **`master` must be
  listed explicitly** (the wildcard excludes it).
- `--force` — acknowledges the shared-context guard for non-`--external` agents.
- `--terminal` — grants the **remote terminal** (the 🖥️ live-tmux feature). This is
  **host-shell-level access**: a terminal can Ctrl-C out of Claude Code into a raw
  shell, bypassing `--disallowedTools`. It is a separate capability from messaging,
  so it must be granted explicitly. Drop `--terminal` if you don't want the web
  terminal — chat/history/interrupt all work without it.

Copy the printed token into `CLAUDESTRA_API_TOKEN`.

---

## 3. Run (development)

```bash
npm run dev        # → http://localhost:33333
```

macOS gotchas (only if your shell exports these globally):

- Global `NODE_ENV=production` shadows dev mode → `NODE_ENV=development npm run dev`.
- Global `INTERNAL_API_KEY` shadows `.env.local` → `env -u INTERNAL_API_KEY npm run dev`.
- Turbopack cold start: the first few requests after a restart may 401/502 while
  env/compilation settles — just refresh.

## 4. Run (production)

```bash
npm run build
npm run start      # → http://localhost:3333
```

Ports are deliberately non-default (dev `33333` / prod `3333`) to avoid clashing
with sibling apps on the same machine.

## 5. Log in

Open the app → you're redirected to `/login`. Enter your **OS username + password**
— verified by a local SSH connection to `127.0.0.1:22` (PAM). On success a
7-day HttpOnly `cstra_session` cookie is set and you land on `/chat`.

New agents are created by talking to the master orchestrator (👑 大总管) in chat —
there is no separate "new session" button by design.

---

## Web-only backend (no Discord)

If you don't want a Discord bot, run the Bridge in **Web-only mode** — it detects
the absence of `DISCORD_BOT_TOKEN` and skips all Discord init while still serving
the `/api/v1` + `/api/v1/events` the web app needs.

### One-time backend prerequisites

1. **tmux ≥ 3.2** (`brew install tmux`). Agents are tmux windows; the live remote
   terminal needs grouped sessions.
2. **Register the channel-server MCP** so Claude Code sessions can reach the Bridge:
   ```bash
   claude mcp add claudestra -s user -- ~/.bun/bin/bun run <repo>/src/channel-server.ts
   ```
3. **Register the Stop / Notification hook** (REQUIRED for the web UI) in
   `~/.claude/settings.json`, so turn-end (`done`) is emitted — without it the web
   composer never unlocks and streamed messages never finalize to rendered Markdown:
   ```jsonc
   "hooks": {
     "Stop":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "Notification":[{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}]
   }
   ```
   `typing-hook.ts` exits silently when there's no channel context, so it's harmless
   for unrelated Claude Code sessions.

### Start the Bridge (foreground)

```bash
# from repo root
unset DISCORD_BOT_TOKEN
CONTROL_CHANNEL_ID=local-master-control bun run src/bridge.ts
```

### Create an agent

```bash
bun src/manager.ts create <name> <existing-dir> [purpose]
```

> The working dir **must already exist**. Avoid `/tmp` — its `/private` symlink
> misplaces Claude Code's session jsonl slug.

### Persistent (recommended, macOS launchd)

Wrapper scripts are provided:

- `scripts/web-only-bridge.sh` — idempotently ensures the `master` tmux session and
  execs the Bridge in Web-only mode.
- `scripts/web-only-launcher.sh` — optional; keeps a master orchestrator (大总管)
  Claude Code alive in window 0 and auto-dismisses its startup trust/bypass prompts.

Wire them into LaunchAgents (`com.claudestra.web-bridge` / `com.claudestra.web-launcher`)
with `RunAtLoad` + `KeepAlive`. **Both must share the same `CONTROL_CHANNEL_ID`.**
After changing bridge code, reload with:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.web-bridge
```

---

## Reference

- [`web/CLAUDE.md`](./CLAUDE.md) — internal architecture, data flow, PWA gotchas.
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) — the `/api/v1` +
  `/events` contract (auth, history pagination, SSE event types).
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) — multi-frontend
  design (chat_id keyspace, NeutralMessage, ChatAdapter).
- [`FORK.md`](../FORK.md) — what this fork adds on top of upstream (additive-only).
