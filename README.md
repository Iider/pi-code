# pi-code

pi-code 是为 [pi coding agent](https://github.com/earendil-works/pi) 定制的
Web 与桌面客户端。项目参考 [kimi-code](https://github.com/MoonshotAI/kimi-code)
WebUI 的视觉设计和交互方式，尽力还原其简洁、流畅的使用体验，但产品能力始终以
pi agent 为准。

项目不修改 pi agent，也不要求 pi agent 适配 Kimi 的功能模型。服务端通过官方
`@earendil-works/pi-coding-agent` SDK 与 pi agent 协作，在保持配置、认证、会话和
运行行为兼容的前提下，将 pi 的原生能力呈现在浏览器和桌面端。

项目的长期目标是完整支持 pi agent 的原始功能：Kimi Code 提供界面与交互设计上的
参考，pi agent 则是唯一的能力来源和行为标准。新增功能应优先复用 pi 的原生实现，
不在客户端另造一套与 pi 不一致的概念或行为。

```
┌─────────────────┐  /api/v1 REST + WS   ┌──────────────────────────┐
│  webapp/        │◄────────────────────►│  server/                 │
│  kimi-web (Vue) │   envelope + events  │  Fastify + PiBridge      │
│  built by Vite  │                      │  → createAgentSession()  │
└─────────────────┘                      │  → SessionManager        │
                                         │  → beforeToolCall gate   │
                                         └──────────────────────────┘
```

## Quick start

```bash
# 1. front end (build once)
cd webapp && npm install && npm run build

# 2. server (uses your existing pi auth in ~/.pi/agent/auth.json)
cd ../server && npm install
npm start                    # opens the browser with the token appended
```

The server listens on `127.0.0.1:8765` by default and serves the built WebUI
from the same origin (kimi `web` style). The bearer token is generated on
first run and stored at `~/.pi-code/server.token`.

The UI opens straight to the conversation list — there is no kimi-style
sign-in gate. pi provider credentials are read from `~/.pi/agent/auth.json`
per request; if none are configured, prompts fail with an actionable error
(`pi` CLI login) instead of blocking the UI.

### Server options

```
npm start -- --port 8765 --workspace /path/to/project --approvals dangerous
```

| Flag | Values | Meaning |
|---|---|---|
| `--port` | number (default 8765) | HTTP/WS listen port |
| `--workspace` | path (default cwd) | Root workspace for new sessions |
| `--approvals` | `dangerous` (default) / `all` / `none` | Tool approval policy: ask for destructive bash commands only / every mutative tool call (bash·write·edit) / never ask |
| `--no-open` | — | Do not open the browser |
| `--dangerous-bypass-auth` | — | Disable the bearer token (local dev only) |

Environment: `PI_CODE_HOME` (default `~/.pi-code`) for the token + session
metadata.

### Front-end development

```bash
cd webapp
KIMI_SERVER_URL=http://127.0.0.1:8765 npm run dev   # Vite dev server + API proxy
```

## Desktop app (Tauri)

`desktop/` is a Tauri v2 shell that wraps the whole stack into a native app:

```
┌─ pi-code.app ─────────────────────────────────────────┐
│  Rust shell (main.rs)                                │
│   ├─ spawn sidecar: pi-code-server (Bun single-file   │
│   │  binary = Fastify + pi SDK, 65MB)                │
│   │   env: PI_CODE_TOKEN (per-launch random),         │
│   │        PI_CODE_DESKTOP=1 (exit with parent)       │
│   ├─ wait for 127.0.0.1:<free-port>                  │
│   └─ WebviewWindow → http://127.0.0.1:<port>/#token  │
│      (macOS WKWebView / Windows WebView2)            │
└──────────────────────────────────────────────────────┘
```

```bash
cd desktop
npm install
npm run build      # bun-compile server + stage webapp + tauri build
# → src-tauri/target/release/bundle/macos/pi-code.app (+ .dmg)
npm run dev        # debug run via cargo
```

Notes:

- The sidecar is the same server compiled with `bun build --compile` (the
  packaging route pi itself uses), so no Node installation is required.
- Desktop state lives in `~/.pi-code-desktop` (separate from the CLI server's
  `~/.pi-code`); pi auth/sessions are still shared via `~/.pi/agent`.
- The sidecar polls its parent PID and exits if the shell is force-quit, so no
  orphaned servers are left behind.
- Requires Rust (cargo) and Bun to build; ~94MB .app / 32MB .dmg.
- Known caveat: rendering relies on the system webview — on macOS that is
  WebKit. The UI is modern-Vue + monaco/xterm/shiki/mermaid; it runs in
  WebKit, but exotic corners (terminal canvas, kitty graphics) are untested
  there. Windows (WebView2/Chromium) has no such concern.

## What works

- Session list / create / rename / archive / restore (backed by pi's
  `SessionManager.listAll()` + `~/.pi-code/meta.json` for archived flags)
- Snapshot restore (pi messages → kimi wire messages), live streaming via the
  raw agent-core event vocabulary (`turn.started`, `assistant.delta`,
  `thinking.delta`, `tool.call.started`, `tool.result`, `turn.ended`, …)
  which the WebUI's own client-side projector consumes
- Prompts, steering while busy, abort, compaction
- Tool approvals: pi has no permission system, so the bridge chains a
  `beforeToolCall` gate (keeping extension hooks intact) and surfaces pending
  approvals as `event.approval.requested`; approve/reject from the WebUI
- Model switching + thinking level, usage/context stats
- Workspaces (derived from session cwds), file tree browsing (`fs:browse`,
  `fs:home`, session `fs:list` / `fs:read`)

Degrades gracefully (empty data): goals, todo tasks, swarm children,
terminals, skills, plugins, search, export, ask-user questions.

## Repository layout

```
webapp/   kimi-web front end — extracted from kimi-code @ e7d5a0aee
          (Vue 3 + Vite; the last revision before the source moved to the
          private code-app repo). Unmodified except for vitest/ws being
          dropped from devDependencies.
server/   the bridge (this project's own code)
  src/bridge.ts      session registry, event bus, snapshots, prompts
  src/translate.ts   pi events/messages → kimi wire vocabulary
  src/approvals.ts   beforeToolCall gate + approval objects
  src/routes.ts      /api/v1 REST subset
  src/ws.ts          WS control protocol (seq+epoch cursors, replay, resync)
server/vendor/protocol/  kimi-code's protocol package (reference schemas)
```

## Attribution & license

- The webapp is derived from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
  (`apps/kimi-web`, MIT) — restored from the repository's git history at
  commit `e7d5a0aee74e7f116cca0273c416ece9139a78a0`, 2026-08-05.
- The API contract mirrors kimi-code's `kap-server` + `packages/protocol`
  (MIT). Colon-bearing routes are registered with kap-server's double-colon
  convention (`/fs::browse` serves `/fs:browse` on the wire).
- pi and this project's server code: MIT.
