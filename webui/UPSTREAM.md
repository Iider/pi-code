# WebUI 上游说明

`dist/` 是 Pi Code 当前默认使用的 WebUI 冻结快照，来自
[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) 仓库提交
`f492cd7c9` 中的 `apps/kimi-code/dist-web/`。

Moonshot AI 已将新版 WebUI 源码迁移到未公开的 `code-app/apps/web` 仓库，公开的
`kimi-code` 仓库只分发预编译产物。因此这里保留完整上游产物、对应 MIT 许可证和
最小的 Pi Code 品牌改动，不反编译或改写它的业务逻辑。

当前快照的本地改动只有：

- 面向用户的 `Kimi` 品牌文字替换为 `Pi` / `Pi Code`；
- `KIMI_CODE_PASSWORD` 提示替换为 `PI_CODE_TOKEN`；
- favicon 复用 Pi Code 现有图标；
- `pi-code-brand.css` 维护品牌图形、桌面窗口顶栏和 pi 原生 OAuth 的视觉适配；桌面规则
  必须以 `html.pi-code-desktop` 为作用域，浏览器模式保留上游侧栏品牌；
- `model-config.js` 将首次引导连接到官方“设置 → 供应商”，隐藏重复的“配置”入口，以及
  无法映射到 pi agent 的 Kimi 账户页和注册表入口；
- 适配器源码位于 `adapter/model-config/`，不改写上游压缩模块，也不修改全局 `fetch`；
  构建会同时更新适配器快照和 `webui/dist` 中的服务产物。

pi agent 的认证、配置写入和模型行为全部位于 `server/`；WebUI 适配模块只负责交互，
不得保存凭据或实现 Provider 业务逻辑。更新上游快照时，应重新执行上述有限变换，
并通过浏览器验证浅色、深色、hover、focus、首次引导和核心会话流程。
桌面窗口几何和打包验收见 [`../docs/desktop.md`](../docs/desktop.md)。

使用 `sync-upstream.mjs` 可重复生成快照：

```bash
cd webui/adapter/model-config
npm run build
```

```bash
node webui/sync-upstream.mjs \
  --source /path/to/kimi-code/apps/kimi-code/dist-web \
  --license /path/to/kimi-code/LICENSE
```

同步完成后还要更新 `upstream.json` 中的 revision，并确认 Git diff 只包含预期的上游
变化和上述品牌变换。
