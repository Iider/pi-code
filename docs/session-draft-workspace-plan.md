# 会话草稿工作台开发方案

- 状态：阶段 1 已实现，待浏览器验收
- 记录日期：2026-08-20
- 决策姿态：分阶段建设会话级能力，不扩张为通用文档平台
- 首次验收点：会话开关、Agent 创建草稿、对话卡片、上下文压缩

## 实施记录（2026-08-20）

阶段 1 已落地，当前等待页面验收，尚未提交 Git：

- `+` 菜单草稿入口、Swarm 风格激活控件及 hover/focus 关闭；
- 会话级开关持久化，关闭时移除工具 schema 和能力提示；
- `session_draft` 的 create、list、read、update；
- 项目目录外的 revision 文件存储、原子索引、容量限制和乐观锁；
- 逻辑独立的临时 user capability message，不写入会话记录；
- 当前轮保留正文，已结束轮次和 compaction 输入压缩正文；
- 草稿卡片、只读查看和复制全文。
- 草稿卡片支持“引用”，复用消息引用 chip；发送时只携带草稿 ID、固定 revision 和有界摘录，不注入全文。

自动验证：服务端 TypeScript 类型检查通过，91 项测试通过。阶段 2 的发布审批、保存到本地、
fork 复制和删除回收站仍按原计划保留，待本轮体验验收后再开发。

## 原始需求留档

> 给会话创建独立的草稿空间或者日记空间，用于存储一些临时的方案或者文档草稿，不放置到项目目录中。其他会话或其他 Agent 不应因为看到尚未落地的模型规划和改动而影响独立判断。

> 用户不会手动创建草稿，实际需求是给 Agent 创建草稿。之后可以通过提示词让 Agent 将草稿落地到本地目录，也可以在草稿卡片上提供复制、保存按钮。

> 可以做草稿开关，Agent 创建的草稿需要在会话中呈现草稿卡片。

> 不修改 system prompt，避免从上下文最前端破坏 provider prompt cache。采用逻辑独立的 synthetic user message；Provider 不接受连续 user role 时，在 Provider 转换边界合并，不伪造自然语言 Agent 回复。

需求落点：Pi Code 提供会话级、默认关闭的 Agent 草稿能力。开启后，Agent 可以把未定方案和文稿保存到项目目录之外；用户在对话中查看草稿卡片，必要时复制或明确落地。草稿默认不进入后续模型上下文，其他会话也不会通过正常会话链路读取。

## 结论

采用“Pi Code 内核服务 + 隐藏 inline extension + 冻结版 WebUI adapter”：

- Pi Code 管理存储、会话归属、revision、发布审批和生命周期；
- Pi inline extension 注册一个 `session_draft` 工具，但只在开关开启时加入 active tools；
- 开关状态写入 Pi custom entry，不进入模型上下文；
- 每次 provider 请求临时注入一条 synthetic user 能力提示，不修改 system prompt 或历史消息；
- Agent 创建和更新草稿，用户不在第一阶段手动新建或编辑；
- 工具结果在对话中渲染草稿卡片，正文按需从服务端读取；
- 草稿工具中的全文只在当前活跃轮次保留，后续请求和 compaction 只携带有界摘录与 digest；
- 通过提示词发布时必须确认路径，通过卡片复制或保存时不再调用模型。

这不是用户可安装或移除的插件。实现上复用 Pi extension 接缝，产品上属于 Pi Code 系统能力。它与 Plan 模式正交：Plan 模式约束 Agent 行为，草稿工作台保存未落地内容；二者可以联动，但不能互相依赖。

## 产品边界

### 目标

- 尚未批准的模型方案不污染项目目录、项目搜索和项目规则发现；
- 草稿只归属于当前会话，普通新会话默认看不到；
- Agent 可以自主创建、读取和更新草稿；
- 用户始终能看到草稿产物、revision 和发布状态；
- 草稿正文不因工具历史长期占用上下文；
- 草稿落地是明确、可审计的文件写入动作。

### 非目标

第一阶段不建设：

- 通用 Markdown 编辑器或多人协作文档；
- 标签、全文搜索、知识库和跨会话草稿市场；
- 草稿自动进入所有后续请求；
- 草稿自动发布到项目；
- 依靠自然语言提示实现访问控制；
- 操作系统级安全隔离。

会话隔离解决正常产品链路中的误读和上下文污染，不构成安全沙箱。多个 Agent 若使用同一系统用户并拥有无限制 Bash，理论上仍能主动读取 `~/.pi-code`。真正的强隔离需要独立用户、容器或能力令牌文件代理，不纳入本期。

## 用户体验

### 会话开关

入口放在输入框左下角 `+` 按钮展开的菜单中，复用 Swarm 模式的选择和激活交互，不在会话顶栏增加入口。菜单增加一项：

```text
草稿
让 Agent 暂存未落地的方案和文稿
```

点击菜单项开启草稿后，在输入框左下角的 `toolbar-left` 区域显示“草稿”激活控件，位置和密度与 Swarm 激活控件一致：

```text
[＋]  [权限]  [Swarm]  [草稿]
```

- 默认显示中性草稿图标和“草稿”状态，不使用强调色制造持续干扰；
- 鼠标移入激活控件后，状态图标切换为叉号；
- 点击叉号关闭草稿能力，控件从 `toolbar-left` 移除；
- 再次从 `+` 菜单点击“草稿”可重新开启；
- `+` 菜单中的草稿项同步显示当前开启状态，不能重复注入第二个激活控件；
- 键盘聚焦时提供与 hover 相同的关闭操作和明确的 `aria-label`；
- 触摸设备始终提供可点击的关闭按钮，不依赖 hover；
- 草稿可与 Swarm、Plan 和权限模式同时开启，不占用互斥模式槽位。

草稿默认关闭并按会话持久化。关闭只停止 Agent 草稿能力，不删除已有草稿或历史卡片。

关闭时：

- 不注入能力提示；
- `session_draft` 不进入 active tools，不向 provider 发送工具 schema；
- 已有草稿和卡片仍可查看、复制和手动保存；
- Agent 不能继续创建、读取或更新草稿。

开启时：

- 从下一轮请求开始生效；
- 临时注入最小能力提示；
- 将唯一的 `session_draft` 加入 active tools；
- 不自动读取已有草稿正文；
- 不自动创建空白草稿。

会话 busy、执行工具或等待批准时，开关变更延迟到当前 Agent run 完成，避免同一次请求中途改变工具集合。

### 草稿卡片

Agent 创建或更新草稿后，在对应工具调用的位置显示专用卡片：

```text
┌ 草稿 · 项目重构方案                     r3 ┐
│ 拆分索引、采集和校验三个阶段，先保持……      │
│                                            │
│ [查看]                 [复制] [保存到本地]  │
└────────────────────────────────────────────┘
```

卡片展示：

- 标题、动作（已创建/已更新/已发布）和 revision；
- 最多 120 个 Unicode 字素的摘录；
- 查看正文、复制全文、保存到本地；
- 发布后显示目标路径；
- 错误时保留工具错误态，不伪装成成功卡片。

第一阶段不提供“新建”和正文编辑按钮。查看正文使用只读抽屉或对话框；复制和保存是浏览器/桌面端直接操作，不产生模型请求。

### 提示词落地

用户可以说：

> 把刚才的重构方案落地到 docs/refactor-plan.md

Agent 调用 `request_publish`，卡片进入待确认状态。确认界面必须显示草稿标题、固定 revision、绝对目标路径、覆盖状态和 diff。用户批准后才执行原子写入；拒绝后草稿保持不变。

卡片“保存到本地”由用户直接选择文件位置，属于用户发起的导出，不需要 Agent 或二次模型请求。保存到当前工作区时仍执行路径和覆盖校验。

## 状态与存储

### 会话状态

开关使用 Pi custom entry，按当前 branch 最后一条记录生效：

```ts
{
  customType: "pi-code.session-draft.settings",
  data: {
    version: 1,
    enabled: boolean
  }
}
```

custom entry 不进入 LLM context。重复设置相同值不得追加记录。

### 草稿模型

```ts
type SessionDraft = {
  version: 1;
  id: string;
  sessionId: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
  published?: {
    revision: number;
    path: string;
    publishedAt: string;
  };
};
```

每个 revision 不可变：

```ts
type DraftRevision = {
  draftId: string;
  revision: number;
  content: string;
  digest: string;
  createdAt: string;
};
```

更新必须携带 `expectedRevision`。revision 不匹配时返回冲突，Agent 重新读取后再更新，不允许 last-write-wins 覆盖正文。

### 文件布局

第一阶段复用 `PI_CODE_HOME`，不引入数据库：

```text
~/.pi-code/session-drafts/<session-id>/
├── index.json
└── drafts/
    └── <draft-id>/
        ├── r000001.md
        ├── r000002.md
        └── r000003.md
```

- `index.json` 使用临时文件 + rename 原子替换；
- revision 文件创建后不修改；
- 文件名只使用服务端生成的安全 ID；
- 标题不得参与路径拼接；
- 单草稿正文第一阶段限制为 256 KiB；
- 单会话第一阶段限制为 32 个草稿、每个草稿 100 个 revision；
- 达到限制时明确报错，不静默删除旧版本。

这些上限是防止意外膨胀的产品边界，不是配额平台。出现真实容量需求后再决定是否迁移 SQLite 或对象存储。

### 生命周期

- 普通新会话：草稿关闭、目录为空；
- 完整 fork：复制分叉点可见的草稿 revision 快照，之后独立更新；
- side chat：第一阶段不继承草稿；
- undo：不删除草稿内容，卡片按当前 branch 可见；孤立 revision 等会话删除时一起清理；
- archive：保留草稿；
- 删除已归档会话：先把草稿目录移动到 `PI_CODE_HOME/trash/session-drafts/`，保留 30 天；
- 服务启动时不扫描或注入其他会话草稿。

## Agent 接缝

### 内置 inline extension

通过现有 `DefaultResourceLoader.extensionFactories` 装配隐藏 extension：

```ts
{
  name: "pi-code-session-draft",
  hidden: true,
  factory: sessionDraftExtension
}
```

extension 始终注册工具定义，但 Pi Code 使用 `setActiveToolsByName()` 按会话开关增删 `session_draft`，同时保留其他项目、用户和内置工具的 active 状态。不得覆盖整个工具集合或阻断已有 extension hooks。

### 单一工具

```ts
session_draft({
  action: "create" | "list" | "read" | "update" | "request_publish",
  draftId?: string,
  title?: string,
  content?: string,
  expectedRevision?: number,
  targetPath?: string
})
```

服务端按 extension 创建时绑定的 session ID 决定命名空间。模型不能传入任意 session ID，也不能通过 `draftId` 越过当前会话。

工具返回值保持有界：

```ts
{
  draftId: string;
  title: string;
  revision: number;
  excerpt: string;
  digest: string;
  status: "created" | "read" | "updated" | "publish_requested";
}
```

`read` 在当前活跃轮次需要额外返回正文供 Agent 使用，但不得把正文复制进摘要、卡片 metadata 或日志。

## 会话级提示词注入

### 不修改 system prompt

开关开启时，每次 provider 请求临时构造逻辑独立的 synthetic user message：

```xml
<session-capability name="draft">
Use session_draft for provisional plans or documents. Publish only when the user explicitly requests it.
</session-capability>
```

约束：

- 不写入 JSONL、snapshot、导出或可见聊天历史；
- 不修改任何历史消息；
- 位于最新真实 user message 之前；
- 关闭开关后，下一次请求不再生成；
- compaction 后按开关重新生成，不依赖摘要保留；
- 只负责能力发现，访问控制、revision 和发布审批全部由代码执行。

### Provider 角色兼容

逻辑层始终保留 synthetic user 与真实 user 的边界：

1. Provider 支持连续 user role：独立发送；
2. Provider 不支持连续 user role：只在 provider payload 副本中合并两个 user content；
3. 无法可靠判定能力时：默认合并，不能伪造自然语言 assistant 回复；
4. 第一阶段不引入 synthetic assistant acknowledgment。

Provider 兼容逻辑不得改变 session JSONL 中的用户原文。应通过 adapter 契约测试覆盖内置 Provider，不能依靠模型名称字符串猜测。

## 上下文与缓存不变量

### 工具历史压缩

`create`、`update` 和 `read` 都可能让草稿全文出现在工具参数或结果中。只把正文移出项目目录还不够，必须同步控制后续 provider context：

- 当前活跃 Agent run：保留本轮草稿工具的完整参数和 `read` 正文，确保 Agent 能完成创建、修改和确认；
- Agent run settled 后：后续请求把已完成的草稿工具调用压缩为 `draftId`、title、revision、最多 120 字素摘录和 digest；
- tool call 与 tool result 必须成对保留，不能产生孤立工具消息；
- `session_before_compact` 使用相同压缩规则，摘要不能重新吸收草稿全文；
- 原始 Pi JSONL 继续保留工具调用，作为会话审计记录；正常 Agent context 不读取其中的全文；
- 当前会话需要继续编辑时，Agent 再调用 `read` 获取指定 revision。

压缩在 bridge 的 `transformContext` 和 compaction hook 中完成，并继续链式调用上游 transform，不能覆盖用户 extension。

### Prompt cache

1. 不修改 system prompt；
2. 单纯开启或关闭草稿时，不修改持久历史消息；synthetic user 只追加在当前请求尾部附近；
3. 工具 schema 只有开关切换时发生变化，开启后保持稳定；
4. 开启或关闭工具集合仍可能导致一次 Provider 缓存变化，具体取决于 Provider；不得宣称零影响；
5. 草稿工具产生全文后，settled 压缩会改写后续 provider payload 中对应的历史 tool call/result，因此缓存会从该工具轮次起失效一次；这是让全文退出长期上下文的必要代价；
6. 除草稿工具消息的确定性压缩外，不修改其他历史 user 或 assistant 消息；
7. 同一草稿工具消息只从全文态转换到压缩态一次，后续 metadata 保持稳定，避免每轮重复破坏缓存；
8. 关闭状态每轮零提示词、零草稿工具 schema 开销；
9. 摘录按 Unicode 字素限制，digest 使用固定算法，不调用模型总结。

## 服务端与 WebUI

### 服务端模块

建议新增：

```text
server/src/session-drafts/store.ts
server/src/session-drafts/service.ts
server/src/session-drafts/extension.ts
server/src/session-drafts/context.ts
```

- `store.ts`：原子文件存储、revision、digest、容量限制；
- `service.ts`：会话权限、fork、删除、发布事务；
- `extension.ts`：单一 Agent 工具；
- `context.ts`：synthetic user、Provider 兼容和工具历史压缩。

HTTP 接口：

```text
GET  /api/v1/sessions/{id}/draft-settings
PUT  /api/v1/sessions/{id}/draft-settings
GET  /api/v1/sessions/{id}/drafts
GET  /api/v1/sessions/{id}/drafts/{draftId}
GET  /api/v1/sessions/{id}/drafts/{draftId}/revisions/{revision}
POST /api/v1/sessions/{id}/drafts/{draftId}:publish
```

开关 PUT 幂等；busy 时记录待应用状态或返回冲突，第一阶段优先返回明确冲突。发布接口要求固定 revision、目标路径和覆盖决策。

### 冻结版 WebUI adapter

默认页面仍来自 `webui/dist`。第一阶段不修改上游哈希 bundle：

```text
webui/adapter/model-config/src/model-config.js
webui/adapter/pi-code-brand.css
webui/adapter/model-config/dist/model-config.js
webui/dist/model-config.js
webui/dist/pi-code-brand.css
```

adapter 负责：

- 在输入框左下角 `+` 菜单注入草稿项；
- 开启后在 `toolbar-left` 注入与 Swarm 同密度的草稿激活控件，hover/focus/触摸均可关闭；
- 同步菜单选中态、会话状态和激活控件，关闭后立即移除控件；
- 识别 `session_draft` 工具结果中的稳定 metadata，替换为草稿卡片；
- 从服务端按需读取正文；
- 查看、复制、保存和发布确认；
- 对重复挂载、会话切换和 MutationObserver 刷新保持幂等。

第一阶段不新增未知 wire content part，避免冻结版上游 projector 丢弃消息。工具结果只返回稳定 JSON metadata；adapter 按工具名和 `draftId` 渲染，解析失败时退回原生工具卡片。

## Plan 模式关系

- 草稿开关在普通模式和 Plan 模式都可用；
- 进入 Plan 模式不会自动开启草稿；
- 开启草稿不会限制 Agent 写项目，权限仍由现有模式和审批控制；
- 后续可以增加“保存 Plan 为草稿”和“依据固定 revision 执行”，但不属于第一阶段；
- 不把 Plan 模式的临时推理自动存成草稿。

## 分阶段开发

### 阶段 0：接缝验证

在不保留产品代码的验证分支或测试夹具中确认：

1. `setActiveToolsByName()` 能增删草稿工具且不影响其他 active tools；
2. synthetic user 在内置 Provider 转换后角色合法；
3. 当前活跃轮次保留全文、下一轮压缩全文的时机可稳定判断；
4. `session_before_compact` 能复用同一压缩函数；
5. frozen WebUI 可以稳定识别并替换草稿工具卡片。

任一关键接缝失败时先调整方案，不把实验兼容代码留在主路径。

### 阶段 1：最小闭环

1. 会话开关 custom entry、GET/PUT 接口和 active tools 切换；
2. 文件存储、revision、digest、容量限制与会话权限；
3. `session_draft` 的 create/list/read/update；
4. synthetic user 和 Provider 角色兼容；
5. 活跃轮次/后续轮次/compaction 的全文压缩；
6. 对话草稿卡片、只读查看和复制；
7. create、open、reload 和普通新会话行为。

完成后暂停，由用户验证 `+` 菜单入口、Swarm 风格的激活与关闭交互、Agent 创建意愿、卡片密度、正文查看和真实模型理解。

### 阶段 2：落地与生命周期

1. Agent `request_publish`、审批、路径校验、diff 和原子写入；
2. 卡片保存到本地；
3. 完整 fork 复制快照、side chat 不继承；
4. archive、删除回收站和清理；
5. revision 历史查看和指定版本复制/发布。

完成后再次由用户验收发布路径、覆盖确认、fork 隔离和恢复行为。

## 验收标准

### 存储与隔离

- 草稿正文不出现在项目目录、项目文件树或项目搜索中；
- 一个会话不能通过 API 或工具读取另一个会话的 `draftId`；
- revision 冲突不覆盖正文，失败写入不留下半个 index；
- 普通新会话不继承草稿，fork 与 side chat 遵守既定策略；
- 关闭开关不删除已有草稿。

### 上下文与缓存

- 关闭时 provider payload 不含草稿提示或工具 schema；
- 只切换开关时 system prompt 和持久历史消息字节不变；
- synthetic user 不进入 JSONL、snapshot 或 UI；
- Provider payload 不出现非法连续角色；
- 活跃轮次可以读写完整正文；下一轮只保留有界 metadata；
- 草稿工具历史只发生一次确定性全文态到压缩态转换，非草稿历史保持不变；
- compaction 摘要输入不含草稿正文；
- tool call/result 保持配对，上游 transform 和其他 extension 继续生效。

### UI 与发布

- 草稿入口位于输入框左下角 `+` 菜单，不出现在会话顶栏；
- 开启后在 `toolbar-left` 显示与 Swarm 同密度的激活控件，hover/focus 出现叉号并可关闭；
- 草稿与 Swarm、Plan 可同时开启，切换任一能力不覆盖其他激活控件；
- 开关按会话恢复，busy 状态不可中途切换；
- Agent 创建和更新后出现对应 revision 卡片；
- 查看、复制和保存不产生模型请求；
- 发布固定 revision，明确显示路径、diff 和覆盖风险；
- adapter 重挂载不产生重复开关、重复卡片或观察器循环；
- 解析异常时回退原生工具卡片，不丢失会话内容。

## 停止条件与复核触发

以下任一情况出现时停止扩张，保留已验证的最小闭环：

- 工具 schema 无法按会话可靠启停；
- 无法在不修改 system prompt 和历史前缀的前提下提供能力提示；
- 草稿全文无法同时从后续请求和 compaction 中移除；
- frozen WebUI 无法稳定关联工具结果与草稿卡片；
- Agent 很少自主使用草稿，卡片没有产生可见价值；
- 存储、fork 和回收生命周期的维护成本超过使用频率。

继续建设 Plan 联动、跨会话引用、搜索或数据库存储的触发条件：第一、二阶段完成真实会话验收，并出现重复使用或明确容量需求。否则保持会话草稿工具的窄边界。
