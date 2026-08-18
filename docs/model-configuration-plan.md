# Pi agent 模型配置架构与验收

- 适用版本：`@earendil-works/pi-* 0.84.2`
- 复核触发：升级 pi SDK、同步官方 WebUI，或修改模型配置接口

## 目标与边界

- Provider、认证、模型和默认模型行为以 pi agent 为准；
- Pi Code 不修改 pi agent，也不维护私有模型配置副本；
- Pi Code 与 pi CLI 共用 `~/.pi/agent`；
- 官方 WebUI 负责样式和交互，适配器只连接入口和协议；
- 浏览器不保存模型 API Key 或 OAuth Token；
- Kimi 专属账户和远程注册表能力不映射成伪造的 pi 功能。

## 架构

```text
官方 WebUI「设置 → 供应商」
          │ /api/v1
          ▼
ModelConfigurationService
  ├─ 共享 ModelRuntime ── Provider、凭据、模型目录
  ├─ SettingsManager ──── settings.json
  └─ ModelsConfigStore ── models.json
          │
          ▼
     pi agent 原生配置
```

模型配置与会话桥接共用一个 `ModelRuntime`。配置写入后刷新该实例，新会话、已有会话和
模型选择器读取同一份状态。

## 服务端职责

```text
server/src/models/
  configuration-service.ts  Provider、默认模型、刷新和 OAuth 生命周期
  provider-view.ts           官方 WebUI DTO 与 pi 模型映射
  models-config-store.ts     models.json 脱敏、校验和原子写入
  errors.ts                  错误类型和秘密脱敏
```

### Provider

- 已配置列表和新增目录均来自共享 `ModelRuntime`；
- 目录添加调用 pi 的 API Key 登录，不复制内置模型定义；
- 手动添加写入 pi 原生 `models.json`；
- Provider 认证检查并发执行，最长等待 10 秒；
- 删除前重新检查凭据来源和类型；
- 环境变量凭据不能由页面删除；
- 内置 Provider 保留 pi 原生 ID，不支持在页面改名。

### 默认模型

默认模型必须同时满足：

1. 页面选择器只展示 `ModelRuntime.getAvailable()` 返回的模型；
2. 裸模型 ID 必须在可用列表中唯一，完整 ID 使用 `provider/model`；
3. 页面提交值最终能解析到同一个可用模型。

通过校验后，`SettingsManager` 写入默认 Provider 和模型；`/auth`、`/config`、模型选择器和
会话桥接均使用同一份完整 ID。配置更新不终止正在执行的 turn。

### `models.json`

`ModelsConfigStore` 与 pi 的解析行为一致，接受 `//` 注释、尾随逗号和任意合法 Provider
键名。页面读取时将 `apiKey`、认证头和秘密值替换为：

```json
"[configured]"
```

保存流程：

1. revision 必须匹配磁盘原文；
2. 将 `[configured]` 与同一 revision 的原秘密合并；
3. 写入同目录、权限为 `0600` 的临时文件并执行 `fsync`；
4. 使用独立 `ModelRuntime` 和 pi schema 验证；
5. 原子替换正式文件并刷新共享 Runtime；
6. Runtime 刷新失败时按 revision 恢复旧文件。

配置目录权限为 `0700`。请求体上限为 1 MiB。独立 Runtime 的校验临时文件在每次操作后
清理。

### OAuth

服务端提供面向 pi Provider 的结构化 OAuth 生命周期：

- 同一 Provider 同时只允许一个流程；
- 重复发起时恢复同一 Provider 的未完成流程；
- 流程保存在内存中，10 分钟后过期；
- 完成、失败或取消结果保留 60 秒；
- 事件队列最多保留 100 条；
- 授权链接和设备码作为当前上下文保留，页面刷新后仍可恢复；
- 提示响应和凭据请求限制为 16 KiB；
- 取消是终态，不会被迟到的异步成功覆盖；
- OAuth Token 只交给 pi 的凭据存储。

官方 WebUI 的账户页不能选择 pi Provider，因此页面隐藏该入口。Provider 目录通过轻量
适配层接入上述结构化接口，展示登录方式、授权链接、设备码和手动输入；视觉继续复用官方
设置弹窗。pi CLI 的 `/login` 仍可使用，并与 Pi Code 读取同一份 `auth.json`。

## HTTP 接口

所有接口使用现有信封并受 Pi Code Bearer Token 保护。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` / `POST` | `/api/v1/providers` | 读取已配置 Provider、手动添加 |
| `GET` / `PUT` / `DELETE` | `/api/v1/providers/:id` | 读取、更新、删除 Provider |
| `GET` | `/api/v1/catalog/providers` | 读取 pi Runtime Provider 目录 |
| `GET` | `/api/v1/catalog/providers/:id` | 读取目录详情 |
| `POST` | `/api/v1/providers:import_catalog` | 使用 API Key 配置内置 Provider |
| `POST` | `/api/v1/providers/:id:refresh` | 刷新单个 Provider |
| `POST` | `/api/v1/providers:refresh` | 刷新全部 Provider |
| `GET` | `/api/v1/models` | 读取 Runtime 当前可用模型列表 |
| `GET` / `POST` | `/api/v1/config` | 读取或更新默认模型等设置 |
| `POST` / `GET` / `DELETE` | `/api/v1/oauth/login` | 创建、轮询或取消 OAuth |
| `POST` | `/api/v1/oauth/login/:id/respond` | 回答 OAuth 提示 |
| `POST` | `/api/v1/oauth/logout` | 删除 OAuth 凭据 |
| `GET` / `PUT` | `/api/v1/models-config` | 读取或保存完整 `models.json` |
| `DELETE` | `/api/v1/models-config/providers/:id` | 删除自定义 Provider |
| `POST` | `/api/v1/models-config:discover` | 刷新模型目录 |
| `POST` | `/api/v1/models-config:test` | 测试模型连通性 |

Fastify 原生 4xx 状态保持原 HTTP 状态码。未知服务端错误只返回通用 500 信息。Provider、
OAuth 和连通性测试使用独立请求体上限，避免大载荷占用服务内存。

## WebUI 适配

```text
webui/adapter/model-config/
  src/model-config.js       入口跳转、Teleport 控件查找和能力收敛
  build.mjs                 同步两处固定文件名产物
```

适配器只做四件事：

- 首次引导打开官方供应商目录或手动添加；
- 隐藏与“设置”功能重复的侧栏“配置”入口；
- 支持 Vue Teleport 到 `body` 的弹窗和菜单；
- 隐藏 Kimi 账户页和未实现的注册表导入。

点击拦截只作用于 `#app`、官方对话框和菜单。适配器不处理请求认证，也不修改
`window.fetch`；官方 WebUI 继续管理服务 Token。`npm run build` 同时更新适配器快照和
实际提供服务的 `webui/dist`。

## 安全不变量

- 配置接口必须通过服务 Bearer Token 认证；
- API Key、OAuth Token、Authorization Header 和 URL 秘密参数不得进入响应或日志；
- 浏览器存储不得出现模型凭据；
- `models.json` 校验失败不得替换原文件；
- revision 冲突返回 409，不覆盖外部修改；
- 模型连通性测试限时 15 秒、输出最多 8 Token；
- 正在执行的 turn 不因配置更新而中断。

## 自动验证

```bash
cd server
npm test
npm run typecheck

cd ../webui/adapter/model-config
npm run build
```

测试覆盖 Provider 目录、路由、默认模型、凭据边界、OAuth 竞态、请求体上限、错误脱敏、
`models.json` 原子写入和适配器产物同步。

## 人工验收

1. 全新端口首次进入时，原生入口直接展开 Provider 目录；
2. “添加自定义供应商”直接进入手动添加；
3. 侧栏菜单只保留“设置”，并可从“设置 → 供应商”管理模型；
4. 页面不出现悬浮模型按钮、Kimi 账户页或注册表入口；
5. 使用测试 Provider 保存 API Key，确认响应、DOM 和浏览器存储不含密钥；
6. 选择默认模型并新建会话，确认可以收到回复；
7. 使用 pi CLI 读取同一凭据和默认模型；
8. 从 Provider 目录完成一次 OAuth，刷新页面后确认凭据和模型可用；
9. 保存自定义 Provider，确认 Pi Code 和 pi CLI 同时识别；
10. 在 OAuth 中途刷新页面，确认授权链接、设备码或输入步骤可以恢复；
11. 输入错误 schema 或制造 revision 冲突，确认原文件不变；
12. 验证浅色、深色和窄窗口。

## 维护检查

同步官方 WebUI 或升级 pi SDK 时检查：

- 设置标签、首次引导和侧栏菜单结构；
- Teleport 容器、供应商标签和添加流程；
- Provider 认证提示和 `AuthEvent` 类型；
- `models.json` 解析规则和 `ModelRuntime.refresh()` 语义；
- 适配器脚本是否只注入一次。

模型配置测试思路参考 [agegr/pi-web](https://github.com/agegr/pi-web)。未复制其框架代码；
复制实质性 MIT 代码时，应在源文件和归因文档登记来源与版本。
