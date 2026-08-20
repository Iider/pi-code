# 会话轮次上下文屏蔽开发方案

- 状态：第一阶段已开发并通过浏览器验收
- 记录日期：2026-08-20
- 实现姿态：界面保留历史，模型上下文按轮次过滤

## 原始需求留档

> 是否可以在最右侧增加一个 icon 图标，功能是：屏蔽该轮对话（从用户消息，到 agent 完成后回复），只要是屏蔽状态，在接下来的对话中，就会从原有上下文中移除，大模型收到的信息中不包含这一部分。

> 比如第一轮对话 AI 给了我一个建议，第二轮我提了一个关于第一轮的问题，发现建议得很好，第三轮我发送“建议很好，可以开始执行了”，想让 Agent 直接根据第一轮开始干活，忽略或者不知道我第二轮问过这个问题，从而让 Agent 认为第三轮需求就是基于第一轮的回复。

> 但不能直接从上下文中完全删除，本质上，用户还是要在会话中看到这轮内容。

浏览器批注目标：已完成 Agent 回复底部的时间和操作区域；新图标放在最右侧。

## 目标与语义

“屏蔽一轮”只改变后续发给模型的上下文，不删除、折叠或改写会话历史。

- 屏蔽范围从目标 user 消息开始，到下一条 user 消息之前结束；包括 assistant 正文、thinking、tool call 和 tool result。
- 历史界面继续展示整轮内容，并用低对比度状态提示该轮已从上下文排除。
- 多轮可以同时屏蔽，状态持久保存，刷新和重开会话后仍有效。
- 进入 compaction 前可再次点击恢复；恢复只影响后续请求，不会重新执行工具，也不会撤销文件、命令或外部系统副作用。
- “模型不知道该轮”是指该轮原始消息不进入 provider payload。若其他未屏蔽轮次复述过相同信息，派生信息不会被反向清除。

不把它做成用户安装型 Pi 插件。这是 Pi Code 的会话管理与浏览器交互能力，需要 UI、HTTP 接口、JSONL 状态和 compaction 同时遵守同一套语义。内部实现可以复用 Pi SDK 的 context hook，但用户不需要安装、启用或配置扩展。

## 交互设计

### 回复底部

- 只在能够确定完整边界的已完成 Agent 轮次显示按钮，位于 footer 最右侧。
- 使用无彩色 `eye-off` 线性图标，尺寸、触摸热区、hover 和键盘焦点与复制、引用、分叉按钮一致。
- 默认提示“从后续上下文屏蔽此轮”；屏蔽后切换为恢复语义和 active 状态。
- 屏蔽中的整轮降低不透明度但不折叠；hover 或键盘聚焦时恢复可读，避免历史内容变得难以查看。
- 含工具调用的轮次首次屏蔽前确认：“这只会移除模型上下文，不会撤销该轮产生的文件、命令或外部副作用。”
- 已进入 compaction 的旧轮次，一期禁用状态切换并解释原因，避免给出无法兑现的“模型已忘记”或“已经恢复”反馈。

### 状态反馈

- 成功后就地切换图标状态，不弹打断式对话框。
- API 失败时恢复原状态并给出短 toast。
- 会话正在生成、执行工具或等待批准时不允许切换，避免一次 provider 请求中途改变上下文。

## 持久化模型

使用 Pi 原生 custom entry 记录操作，不另建会话旁路数据库：

```ts
{
  customType: "pi-code.context-mask",
  data: {
    version: 1,
    userEntryId: string,
    endEntryId: string,
    masked: boolean
  }
}
```

- JSONL 保持 append-only；同一 `userEntryId` 以当前分支最后一条记录为准。
- `endEntryId` 固化操作时的轮次末端，方便审计、分叉和未来迁移。
- custom entry 不进入 LLM context，也不污染可见消息。
- undo、分叉和树导航天然按当前 branch 读取状态；不在当前分支的记录不生效。

## 服务端设计

### 纯逻辑层

新增独立模块统一负责：

1. 从当前 branch 解析 custom entry，按最后写入获知每轮状态；
2. 根据整轮 DOM 使用的首条 Agent 回复 entry ID 定位所属 user turn 和完整结束边界；
3. 标记工具轮次、compaction 可操作性和当前屏蔽状态；
4. 按 user turn 过滤 `AgentMessage[]`，确保 tool call/result 成对离开上下文；
5. 为 API 和 WebUI 输出稳定、最小的状态 DTO。

轮次身份以持久化 user entry 为准。过滤时优先匹配 session branch 中的消息对象；SDK 复制消息的链路使用包含时间戳的完整消息签名匹配，整轮删除，不做正文模糊匹配。

### Pi SDK 接缝

- 在 create、open、fork 的统一会话装配路径中启用 mask-aware context 处理。
- provider 请求前先过滤被屏蔽轮次，再调用已有 `agent.transformContext`；不能覆盖或跳过项目和用户原有 extensions。
- `session_before_compact` 同样过滤 `messagesToSummarize` 与 `turnPrefixMessages`，保证新摘要不会重新吸收已屏蔽轮次。
- snapshot 和消息列表继续从原始 session 构建，绝不复用过滤后的 provider context。

### HTTP 接口

```text
GET /api/v1/sessions/{sessionId}/context-masks
PUT /api/v1/sessions/{sessionId}/context-masks/{assistantEntryId}
```

PUT 请求：

```json
{ "masked": true }
```

响应返回目标轮次的 `user_entry_id`、`assistant_entry_id`、`end_entry_id`、`masked`、`has_tools` 和 `can_toggle`。接口幂等：请求值与当前值相同不重复追加 custom entry。

错误边界：

- 会话 busy：返回冲突；
- entry 不存在或不属于已完成 Agent 轮次：返回校验错误；
- 旧 compaction 前、从未屏蔽的轮次首次屏蔽：拒绝并返回明确原因；
- 状态持久化失败：不得让 UI 假装成功。

## Compaction 与恢复

屏蔽功能不能只处理“下一次请求”，否则上下文压缩会把被屏蔽内容永久写进摘要。

- 正常压缩：摘要输入排除所有已屏蔽轮次。
- 压缩前已经屏蔽的轮次：custom state 继续保留，界面仍可展示原始 JSONL 历史。
- 已屏蔽轮次后来进入摘要后再恢复：目标设计必须先基于 append-only 原始 branch 重建替代摘要，成功追加新 compaction 后才追加 unmask custom entry。
- 摘要重建失败：保持原屏蔽状态，不创建半成功分支。
- 当前 Pi SDK 没有“基于任意历史 branch 原子替换摘要”的公开操作，一期因此锁定 compaction 边界前的屏蔽状态：不能首次屏蔽，也不能恢复。这是数据真实性约束，不用 UI 猜测摘要是否包含该轮。后续只有补齐并验证摘要重建事务后才开放恢复。

未来恢复已压缩轮次会增加一次摘要请求，界面必须事先提示。屏蔽或恢复导致变化点之后的 provider prompt cache 失效，这是上下文正确性的必要成本。

## 冻结版 WebUI 落点

默认页面来自 `webui/dist`，因此实现继续走现有 adapter：

```text
webui/adapter/model-config/src/model-config.js
webui/adapter/pi-code-brand.css
webui/adapter/model-config/dist/model-config.js
webui/dist/model-config.js
webui/dist/pi-code-brand.css
```

- 不直接改上游哈希 bundle，不覆盖 `window.fetch`。
- footer 按钮和轮次状态由 snapshot/message DOM 中的稳定 entry ID 关联 API 数据。
- MutationObserver 刷新必须幂等：已有按钮只更新状态，不重复插入，不因自身 DOM 修改形成刷新循环。
- 生成副本由 adapter build 统一同步，并保持字节一致。

## 验收标准

### 服务端

- provider payload 完整排除目标 user turn，前后轮保持顺序不变；
- 含 thinking、tool call、tool result 的轮次整体过滤，不留下孤立工具消息；
- snapshot 和 `/messages` 仍返回被屏蔽轮次；
- reload、多轮屏蔽、重复 PUT、恢复、undo 和 fork 状态正确；
- compaction 摘要输入不含屏蔽轮次；
- 不可安全处理的旧压缩轮次被明确拒绝；
- compaction 边界前的状态切换被可靠锁定；未来开放恢复时须遵守“摘要成功后再解屏蔽”的原子顺序。

### 浏览器

- 图标位于 footer 最右侧，视觉与现有极简操作一致；
- 点击后整轮而非单条 assistant 消息进入低对比度状态；
- 刷新后状态不丢失，恢复后立即正常显示；
- 工具轮次出现副作用确认；busy、禁用和失败状态文案清楚；
- 不影响复制、引用、分叉、附件、发送和滚动；
- 反复重挂载不会出现重复按钮或 MutationObserver 循环。

## 本期停止条件

以下任一能力无法通过公开 SDK 和现有 adapter 接缝可靠实现时，不做静默降级：

- provider 请求与 compaction 无法同时遵守过滤；
- 无法稳定把 UI 目标映射到持久 entry；
- 恢复已压缩轮次无法安全重建摘要；
- 工具消息无法按完整轮次成对过滤。

遇到停止条件时保留已验证的底层能力，明确报告限制，再决定是否升级 Pi SDK 或缩小一期范围。

## 当前实现范围

- 已新增 JSONL custom entry 状态、完整轮次识别和 last-write-wins 解析。
- 已在 provider 请求前过滤屏蔽轮次，并在 `session_before_compact` 同步过滤摘要输入；snapshot 与消息列表仍使用完整历史。
- 已新增查询和幂等切换接口，busy、非法目标和 compaction 边界均返回明确错误。
- 已在冻结版 WebUI footer 最右侧增加中性 `eye-off` 操作，提供屏蔽态、整轮弱化、工具副作用确认、禁用态和错误反馈。
- 已确认 SDK 暂无安全的历史摘要替换事务，因此一期锁定 compaction 边界前的状态切换，没有用不可靠的局部摘要覆盖冒充恢复。
- 浏览器验收已覆盖最新轮次识别、按钮可用性和整体交互；整轮 DOM 以首条 assistant entry 作为稳定锚点。
