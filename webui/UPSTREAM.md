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
- `pi-code-brand.css` 替换侧栏标记和空会话品牌图形。

pi agent 的会话、工具、审批、模型和工作区适配全部位于 `server/`，不得写入这份
压缩产物。更新上游快照时，应重新执行上述有限变换，并通过浏览器验证浅色、深色、
hover、focus、首次引导和核心会话流程。

使用 `sync-upstream.mjs` 可重复生成快照：

```bash
node webui/sync-upstream.mjs \
  --source /path/to/kimi-code/apps/kimi-code/dist-web \
  --license /path/to/kimi-code/LICENSE
```

同步完成后还要更新 `upstream.json` 中的 revision，并确认 Git diff 只包含预期的上游
变化和上述品牌变换。
