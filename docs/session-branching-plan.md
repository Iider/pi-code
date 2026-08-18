# 会话分支开发方案

## 目标

Pi Code 复用 Kimi Code WebUI 的页面与交互，但分支的语义、数据和执行必须来自 pi agent。实现过程中不复制会话内容到私有格式，不维护第二套分支树，也不改变 pi 的 JSONL 会话文件。

需要区分两类能力：

- **会话分支**：pi 会话是追加式树结构，可以从历史节点继续，也可以复制当前路径为独立会话。
- **Git 分支与 worktree**：改变 Agent 工作目录和代码 checkout，不属于会话树。

本文按三个可独立验收的阶段落地。每一阶段都提供当前价值，并为下一阶段保留稳定接口。

## 实现状态

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| 完整会话分叉 | 已实现 | 会话菜单、聊天顶栏、`POST /api/v1/sessions/{id}:fork` |
| 从消息处分叉为新会话 | 已实现 | 已完成的 assistant 回复底部、同一分叉接口的 `entry_id` 参数 |
| 子会话查询与侧聊兼容 | 已实现 | `/children`、`/children` 创建接口 |
| 会话树查看与原地路径切换 | 未实现 | 第二阶段后续单元 |
| Git branch 与 worktree 管理 | 未实现 | 第三阶段 |

当前实现会在服务重启后从 pi 会话头恢复父子关系。普通分叉继续显示在主会话列表，
`side_chat` 子会话只进入侧聊区域。

## 核心约束

1. `SessionManager` 是会话分支的唯一真实来源。
2. 父子关系优先读取 pi 会话头中的 `parentSession`，不另建分支数据库。
3. 分叉只创建新会话，不修改、删除或覆盖源会话。
4. 正在生成回复或执行工具时禁止分叉，避免复制不完整状态。
5. WebUI 只消费 REST/WS 映射，不依赖 pi SDK。
6. Git 分支、独立会话分叉、会话内路径切换使用不同名称和入口。

## 第一阶段：完整会话分叉

### 用户价值

接通侧栏和聊天顶栏现有的“分叉会话”。用户可以复制当前会话的完整有效上下文，在新会话中尝试另一种方向，原会话保持不变。

### 交互

1. 用户在会话菜单中选择“分叉会话”。
2. 前端调用 `POST /api/v1/sessions/{id}:fork`。
3. 服务端使用 pi 的 `SessionManager.forkFrom()` 创建原生子会话。
4. 响应返回新会话，WebUI 将其加入本地列表并立即打开。
5. 新会话通过 `metadata.forked_from_session_id` 关联源会话，并作为普通会话显示。
6. 服务重启后，父子关系仍从 pi 会话文件恢复。

### 接口

#### 分叉完整会话

```http
POST /api/v1/sessions/{id}:fork
Content-Type: application/json

{ "title": "可选的新名称" }
```

成功时返回新会话。源会话不存在返回 `40401`；源会话仍在执行时返回冲突错误；创建失败不得留下服务端私有关系记录。

#### 查询子会话

```http
GET /api/v1/sessions/{id}/children
```

返回直接子会话，不递归展开。

#### 创建子会话

```http
POST /api/v1/sessions/{id}/children
```

第一阶段与完整会话分叉使用相同语义，作为 WebUI 已有协议的兼容入口。

### 数据映射

- pi：会话头 `parentSession` 保存父会话文件路径。
- adapter：列举会话时将父文件路径解析为父会话 ID。
- wire：普通分叉使用 `metadata.forked_from_session_id`，避免被官方 WebUI 当作侧聊隐藏；
  只有 `side_chat` 使用 Kimi 约定的 `metadata.parent_session_id`。
- `meta.json`：只继续保存标题、归档等 UI 元数据，不保存分支拓扑。

### 验收标准

- 现有“分叉会话”不再返回 `Unsupported session action: fork`。
- 分叉后自动进入新会话，历史消息与源会话一致。
- 在新会话继续发送内容不会改变源会话。
- 新会话响应包含正确的 `forked_from_session_id`，且在主侧栏可见。
- `/children` 能查询到新会话。
- 重启服务后父子关系仍然存在。
- 空会话、无持久化文件、运行中的会话给出明确错误，不产生半成品。

### 第一阶段未包含

- 从指定消息节点创建独立会话（已在第二阶段的独立单元实现）。
- 在同一会话内部切换活跃路径。
- 新的分支树 UI。
- Git worktree 管理。

## 第二阶段：消息节点分支与会话树

> 当前进度：已完成“从此处分叉”这一独立单元；会话树查看和同一会话内路径切换尚未实现。

### 用户价值

允许用户从指定历史消息重新探索，并查看、切换同一会话内的不同路径，完整对应 pi 的 `/fork` 与 `/tree` 能力。

### 交互设计

- 已完成的 agent 回复底部操作区增加“从此处分叉”，从该回复之后继续开新会话。
- 聊天顶栏增加“分支”入口；没有分支时保持弱提示，不制造空面板。
- 分支面板按树展示首条差异消息，当前路径高亮。
- 点击叶节点切换路径；切换前若 Agent 正在执行则禁止操作。
- “创建新会话”和“当前会话内分支”使用明确不同的文案。

### 服务能力

- 暴露 `SessionManager.getTree()` 的只读投影，保留 entry ID、parent ID、角色、时间和有界文本预览。
- 使用 `AgentSessionRuntime.fork(entryId)` 创建指定节点的新会话。
- 使用 `navigateTree(targetId)` 切换同一会话的活跃叶节点。
- 切换后重新生成 snapshot，并通过新 epoch 或明确的 resync 事件让客户端替换消息列表。

### 风险与保护

- 路径切换会改变模型上下文，不能仅在浏览器隐藏消息。
- compaction、`branch_summary`、模型和 thinking 变更必须沿 pi 的 context builder 解析。
- entry ID 只作为 pi 会话内标识，不提升为跨会话全局 ID。
- 先交付只读树和指定节点“新会话分叉”，再开放原地路径切换。

### 已实现的消息分叉接口

历史消息快照直接使用 pi `SessionEntry.id` 作为消息 ID（用户与 assistant 消息一致）。
WebUI 在已完成 agent 回复的底部操作区调用：

```http
POST /api/v1/sessions/{id}:fork
Content-Type: application/json

{ "entry_id": "pi session entry id" }
```

服务端验证目标必须是当前会话中已持久化的用户或 assistant 消息：

- assistant 消息：使用 `createBranchedSession(target.id)`，该回复保留在新会话中，
  成为新对话的最新状态，用户直接接着往下聊。
- 用户消息：使用 `createBranchedSession(target.parentId)`，目标消息本身不进入新上下文，
  用户可以在新会话中重新提出不同问题；目标之前的上下文保持不变。

### 验收标准

- 树结构与 pi JSONL 的 parent 链一致。
- 切换后 UI 消息、模型上下文和下一次回复使用同一路径。
- 刷新和断线重连后仍恢复当前叶节点。
- 压缩过的会话、已有多分支会话和旧版会话均可读取。

## 第三阶段：Git 分支与 worktree

### 用户价值

让一个项目的多个 Git 分支以独立工作目录并行运行 Agent，避免在同一 checkout 中频繁切换和相互污染。

### 交互设计

- 项目标题下提供独立的工作区选择器，显示当前 branch 或 detached 状态。
- 菜单可切换已有 worktree、创建 worktree、移除 worktree。
- 会话按项目根目录分组，再按 worktree 展示；会话始终绑定创建时的 `cwd`。
- “移除 worktree”明确说明默认保留 Git 分支，不与删除会话混用。

### 服务能力

- 只通过 Git 命令读取 repository root、branch 和 `git worktree list --porcelain`。
- 创建 worktree 时复用已有分支；分支不存在时从当前 HEAD 创建。
- 校验目标目录、分支占用、脏工作区和路径边界。
- 文件浏览、终端、Agent 工具和会话创建统一使用所选 worktree 的 `cwd`。

### 验收标准

- main checkout 与 linked worktree 被识别为同一项目下的不同工作区。
- 不同 worktree 中的会话和文件操作互不串目录。
- 已被其他 worktree 占用的分支不能重复 checkout。
- 删除 worktree 前有明确确认，失败时不删除 Git 分支或会话。

## 推进与停止条件

- 每一阶段通过用户验收后单独提交，不把未验证阶段混入同一提交。
- 第一阶段只需适配层和现有 WebUI 即可交付；如果必须修改上游 UI 才能工作，应暂停并重新核对协议。
- 第二阶段先验证 snapshot/resync 能可靠替换路径；验证失败时保留“指定节点创建新会话”，暂缓原地切换。
- 第三阶段只有在确实需要并行 checkout 时启动；若只是显示当前 Git 分支，则先实现只读状态，不提前建设完整管理器。
