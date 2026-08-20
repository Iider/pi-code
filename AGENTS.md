# AGENTS.md — Pi Code

## 项目是什么

Pi Code 用官方 WebUI 提供本地 Pi Agent 会话、工作区和模型配置界面。服务端把 Pi SDK 的会话与模型能力适配为 WebUI 使用的 `/api/v1` 协议。

## 技术栈与架构

- `server/`：Fastify、TypeScript、Pi Agent SDK；提供 REST、WebSocket 和静态资源。
- `webapp/`：Vue 3、Vite；官方 WebUI 的可维护源码。
- `webui/`：官方 WebUI 快照、适配脚本和构建产物。
- `desktop/`：桌面端封装。
- `docs/`：专题说明和只增不改的迭代记录。

请求从 WebUI 进入 `server/src/routes.ts`，会话操作交给 `PiBridge`，模型配置交给 `ModelConfigurationService`；响应转换为官方 WebUI 兼容的数据结构。

## 核心业务流程

1. `npm start -- --dangerous-bypass-auth --no-open` 启动本地服务。
2. WebUI 通过 REST 加载工作区、会话、供应商和模型，通过 WebSocket 接收会话事件。
3. 会话数据由 Pi SDK 读取；供应商表单保存到 `~/.pi/agent/models.json` 并刷新共享模型运行时。
4. `webui/dist/` 作为默认静态页面，适配源码与对应产物必须同步修改。

## 开发约定

- 细节为王，优雅至上：不做临时性、阅读困难的短视修改。
- 能抄不写，能连不造，能复用不原创：优先使用 Pi SDK 和官方 WebUI 的既有协议。
- 不覆盖工作区中的既有改动；提交前按最小功能单位拆分文件。
- 修改 `webui/adapter/` 的已发布适配内容时，同步更新 `webui/dist/` 对应产物。
- 服务端验证：在 `server/` 运行 `npm test` 和 `npm run typecheck`。
- 前端验证：在 `webapp/` 运行 `npm test` 和 `npm run typecheck`。

## 当前状态与下一步

- Web 模式可清理非法本地凭据并正常进入官方 WebUI。
- 工作区会话列表支持按工作区游标分页，“展开更多 / 收起”已完成页面验收。
- 工作区默认显示目录最后一级名称；自定义名称会由服务端按目录持久化，刷新和重启后保持不变。
- 内置供应商可保存本地模型白名单，设置页和主模型选择器保持同步。
- Agent 设置中的默认权限可切换并保存，刷新页面后保留所选项。
- 归档会话支持单个删除和按工作区全部删除，服务端仅允许删除已归档且空闲的会话。
- 用户消息支持撤回编辑（`:undo`），服务端通过会话树导航撤回最近一轮，原文回填输入框。
- Agent 回复引用第一阶段已完成，使用引用 chip 和短指纹文本，不开发 pi 插件；待用户页面验收。
- 下一步：根据 `docs/message-quoting-plan.md` 的浏览器验收反馈，决定是否进入排队/编辑稳定性阶段。

## 已知问题

- 撤回消息后若未继续对话就重启服务，被撤回的尾部会因叶子指针不持久化而重新出现；继续发消息后永久正确。

## 收尾规范

每个最小功能单位完成后执行 `dev-wrap-up`：自测、用户验收、最小提交、更新本文件和 `docs/changes/`、清场。用户验收通过前不提交。
