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

The UI opens straight to the conversation list. If no pi Provider is available,
open **Settings → Providers** to add a built-in or custom Provider. API Key and
OAuth providers can both be configured in the WebUI; Pi Code and the pi CLI
share the same native configuration files.

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
│   ├─ show the bundled startup page immediately       │
│   └─ WebviewWindow → http://127.0.0.1:8766/          │
│      ?desktop=1#token=<per-launch token>             │
│      (macOS WKWebView / Windows WebView2)            │
└──────────────────────────────────────────────────────┘
```

```bash
cd desktop
npm install
npm run build      # bun-compile server + stage WebUI + tauri build
# → src-tauri/target/release/bundle/macos/pi-code.app (+ .dmg)
npm run dev        # debug run via cargo
```

桌面图标源文件是 [`desktop/app-icon.png`](desktop/app-icon.png)。替换 logo 后，在
`desktop/` 目录执行 `npm exec -- tauri icon app-icon.png --output src-tauri/icons`，
即可重新生成 macOS、Windows、Linux 及移动端图标资源；网页 favicon 也使用同一套 logo。

Notes:

- The sidecar is the same server compiled with `bun build --compile` (the
  packaging route pi itself uses), so no Node installation is required.
- Desktop server state lives in `~/.pi-code-desktop` (separate from the CLI
  server's `~/.pi-code`); WebView preferences use the operating system's app
  storage, while pi auth/sessions remain shared via `~/.pi/agent`.
- 桌面端固定使用 `127.0.0.1:8766` 并限制为单实例运行，让 WebView 的首次使用状态、
  外观设置和资源缓存能够跨启动复用。启动期间先显示轻量内置启动页，服务就绪后在同一
  可见窗口进入 WebUI；连接阶段沿用同一套 Pi Code 品牌视觉，避免中间白屏或上游品牌闪现。
- macOS 原生窗口按钮保留在左上角；侧栏顶部和会话顶栏的空白区域支持拖动窗口，双击则在
  最大化与原尺寸之间切换，不会进入覆盖菜单栏和 Dock 的全屏模式。
- 带内容哈希的 `/assets/` 使用长期不可变缓存；入口 HTML、启动脚本和适配器继续在每次
  启动时校验，避免升级后继续读取旧页面。
- The sidecar polls its parent PID and exits if the shell is force-quit, so no
  orphaned servers are left behind.
- 桌面端的回合完成、待回答和待审批提醒通过 Tauri 原生系统通知发送；首次开启时由系统
  授权。浏览器访问仍使用浏览器自身的通知权限。
- Requires Rust (cargo) and Bun to build; the current arm64 output is about 106MB for the `.app` and 41MB for the `.dmg`.
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
- Pi Provider configuration: built-in API Key login, custom `models.json`
  providers, native OAuth login, default model and model refresh
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

## Development documents

- [模型配置使用与排障](docs/model-configuration.md)：页面配置、自定义模型和常见问题。
- [Pi agent 模型配置架构与验收](docs/model-configuration-plan.md)：Provider、认证、默认模型、
  数据完整性、WebUI 适配和验收清单。
- [桌面端架构与维护](docs/desktop.md)：启动链路、macOS 顶栏坐标、拖动、通知、打包和验收。

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
