# 桌面端架构与维护

Pi Code 桌面端使用 Tauri v2 打包 Rust 外壳、Bun 单文件服务端和官方 WebUI 快照。
桌面外壳不修改 pi agent；模型、认证和会话仍通过 `@earendil-works/pi-coding-agent`
及 `~/.pi/agent` 工作。

## 启动链路

1. 创建一个可见的本地 WebView，立即显示 `desktop/ui-placeholder/index.html`；
2. 生成本次启动专用的 Bearer Token；
3. 独占 `127.0.0.1:8766`，端口被占用时在启动页显示错误；
4. 启动 `pi-code-server` sidecar，并传入 `PI_CODE_DESKTOP=1`、`PI_CODE_HOME` 和 Token；
5. 服务端就绪后，在同一个 WebView 中导航到
   `http://127.0.0.1:8766/?desktop=1#token=<token>`；
6. 应用退出时终止 sidecar；强制退出时，sidecar 通过父进程检测自行结束。

桌面端固定端口并限制为单实例。不要改回“随机端口 + 新建第二个窗口”：随机端口会让
WebView 的来源和持久化状态变化；隐藏的 WKWebView 在 macOS 上还可能在 Vue 初始化前被
系统暂停，表现为长时间白屏或停在“正在准备工作台”。

静态资源缓存分两类：

- `/assets/` 下带内容哈希的文件使用一年不可变缓存；
- `index.html`、适配器、启动脚本等可变入口使用 `no-cache`。

## 桌面模式边界

桌面窗口同时使用三个稳定标记：

- 初始化脚本设置 `window.__PI_CODE_DESKTOP__ = true`；
- URL 查询参数包含 `desktop=1`；
- `<html>` 增加 `pi-code-desktop` 类。

桌面专属 CSS 必须以 `html.pi-code-desktop` 开头。浏览器模式没有该类，继续显示上游
侧栏品牌和原始顶栏布局。桌面模式隐藏侧栏品牌，只保留原生窗口按钮和侧栏操作按钮。

## macOS 顶栏几何

当前验收值：

| 项目 | 值 |
| --- | --- |
| WebUI 顶栏高度 | `42px` |
| 原生窗口按钮位置 | `LogicalPosition(13, 23)` |
| 收起侧栏按钮 | `top: 8px; left: 84px` |
| 新建会话按钮 | `top: 8px; left: 112px` |
| 收起状态顶栏左内边距 | `148px` |

`traffic_light_position(x, y)` 中的 `x` 是关闭按钮左边缘，不是按钮中心。`y` 也不是
CSS 的顶部坐标：Wry 使用它计算原生标题栏容器高度，同时保留按钮在容器内的原始基线。
当前 macOS arm64 环境中，窗口按钮直径约 `14px`，容器内基线约 `9px`，可见中心约为：

```text
y - 9 + 14 / 2
= 23 - 9 + 7
= 21px
```

`21px` 正好是 `42px` WebUI 顶栏的中线。不要通过给 `.chat-header` 增加底部内边距或
整体移动页面内容来迁就原生按钮；这会让分隔线、标题和操作按钮互相错位。调整顶栏高度
后，应重新测量原生按钮，而不是把 `y` 当作 CSS 坐标直接套用。

窗口原生标题必须保持为空字符串。产品名由 WebUI、应用包和 Dock 图标呈现；设置原生
标题会在左上角形成重复的 `pi-code` 文本。

## 拖动与双击

`.side .ch` 和 `.chat-header` 由适配器添加
`data-tauri-drag-region="deep"`。按钮和输入框使用 `-webkit-app-region: no-drag`，避免
拖动区域吞掉点击。

Tauri capability 必须保留：

- `core:window:allow-start-dragging`；
- `core:window:allow-internal-toggle-maximize`。

双击拖动区调用系统最大化切换，保留菜单栏和 Dock，不使用全屏模式。不要在顶栏上增加
透明拖动层；透明层会遮挡侧栏、新建会话和菜单按钮。

## 系统通知

桌面端通过 `tauri-plugin-notification` 发送回合完成、待回答和待审批通知。能力文件必须
允许查询权限、申请权限和发送通知。浏览器模式继续使用浏览器通知 API，两者的权限提示
文案由桌面标记区分。

## 构建与验证

```bash
cd webui/adapter/model-config
npm run build

cd ../../../server
npm run typecheck
npm test

cd ..
cargo fmt --check --manifest-path desktop/src-tauri/Cargo.toml
cargo check --manifest-path desktop/src-tauri/Cargo.toml
git diff --check

cd desktop
npm run build
```

产物位于：

```text
desktop/src-tauri/target/release/bundle/macos/pi-code.app
desktop/src-tauri/target/release/bundle/dmg/pi-code_<version>_aarch64.dmg
```

DMG 封装失败时先运行 `hdiutil info`，只卸载路径位于当前项目
`desktop/src-tauri/target/release/bundle/macos/rw.*.dmg` 的残留镜像，再重新打包。不要卸载
其他项目或用户手动挂载的磁盘映像。

## 人工验收

安装前彻底退出旧版并覆盖 `/Applications/pi-code.app`，避免把旧进程或旧安装包误认为新
构建。至少检查：

1. 启动页立即出现，随后在同一窗口进入会话页；
2. 展开和收起侧栏时，窗口按钮与 `42px` 顶栏上下居中；
3. 桌面端不显示侧栏 Logo，浏览器模式仍显示；
4. 侧栏和内容顶栏空白处可以拖动窗口；
5. 双击拖动区在最大化和原尺寸之间切换，不进入全屏；
6. 侧栏、新建会话、搜索、菜单和输入框仍可点击；
7. 回合完成、待回答和待审批通知能进入系统通知中心；
8. 关闭应用后，`8766` 端口和 `pi-code-server` 进程均已释放。
