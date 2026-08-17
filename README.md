# pi-code

pi-code 是为 [pi coding agent](https://github.com/earendil-works/pi) 定制的
Web 与桌面客户端。项目复用 [kimi-code](https://github.com/MoonshotAI/kimi-code)
以 MIT 许可证发布的官方 WebUI 构建产物，保留其页面样式和原生交互，并将产品品牌
与能力后端替换为 Pi Code / pi agent。

项目不修改 pi agent，也不要求 pi agent 适配 Kimi 的功能模型。服务端通过官方
`@earendil-works/pi-coding-agent` SDK 与 pi agent 协作，在保持配置、认证、会话和
运行行为兼容的前提下，将 pi 的原生能力呈现在浏览器和桌面端。

项目的长期目标是完整支持 pi agent 的原始功能：Kimi Code WebUI 只负责表现与交互，
pi agent 是唯一的能力来源和行为标准。新增功能应优先复用 pi 的原生实现，不在客户
端另造一套与 pi 不一致的概念或行为，也不为适配 UI 修改 pi agent。

```
┌─────────────────┐  /api/v1 REST + WS   ┌──────────────────────────┐
│  webui/dist/    │◄────────────────────►│  server/                 │
│  official WebUI │   envelope + events  │  Fastify + PiBridge      │
│  + Pi branding  │                      │  → createAgentSession()  │
└─────────────────┘                      │  → SessionManager        │
                                         │  → beforeToolCall gate   │
                                         └──────────────────────────┘
```

## Quick start

```bash
# Server uses the bundled WebUI and your existing pi auth in ~/.pi/agent/auth.json
cd server && npm install
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
| `--web-dist` | path (default `webui/dist`) | Override the WebUI distribution; use `webapp/dist` to run the legacy source build |
| `--no-open` | — | Do not open the browser |
| `--dangerous-bypass-auth` | — | Disable the bearer token (local dev only) |

Environment: `PI_CODE_HOME` (default `~/.pi-code`) for the token + session
metadata.

### WebUI snapshots and legacy development

`webui/dist/` is the default, self-contained official WebUI snapshot. Its upstream revision,
license, constrained brand changes, and repeatable sync command are documented in
[`webui/UPSTREAM.md`](webui/UPSTREAM.md).

`webapp/` retains the last public Vue source as a rollback and protocol-reference implementation.
To run it instead:

```bash
cd webapp
npm install && npm run build
cd ../server
npm start -- --web-dist ../webapp/dist
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
webui/    default official Kimi Code WebUI distribution + Pi Code brand layer
          and upstream sync metadata; no pi agent behavior lives here
webapp/   legacy Vue source, extracted from kimi-code @ e7d5a0aee; retained as
          a rollback path and readable protocol/UI reference
server/   the bridge (this project's own code)
  src/bridge.ts      session registry, event bus, snapshots, prompts
  src/translate.ts   pi events/messages → kimi wire vocabulary
  src/approvals.ts   beforeToolCall gate + approval objects
  src/routes.ts      /api/v1 REST subset
  src/ws.ts          WS control protocol (seq+epoch cursors, replay, resync)
server/vendor/protocol/  kimi-code's protocol package (reference schemas)
```

## Attribution & license

- The default WebUI snapshot comes from
  [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
  (`apps/kimi-code/dist-web`, MIT) at the revision recorded in
  [`webui/upstream.json`](webui/upstream.json). The corresponding license is retained at
  [`webui/LICENSE.upstream`](webui/LICENSE.upstream).
- The legacy Vue source was restored from the repository's history at
  `e7d5a0aee74e7f116cca0273c416ece9139a78a0`, the last public revision before the WebUI
  source moved to the private `code-app` repository.
- The API contract mirrors kimi-code's `kap-server` + `packages/protocol`
  (MIT). Colon-bearing routes are registered with kap-server's double-colon
  convention (`/fs::browse` serves `/fs:browse` on the wire).
- pi and this project's server code: MIT.
