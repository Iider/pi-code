# 模型配置使用与排障

Pi Code 直接使用 pi agent 的 Provider、模型和配置目录。默认目录是 `~/.pi/agent`；设置
`PI_CODING_AGENT_DIR` 后，Pi Code 和 pi CLI 会同时改用指定目录。

## 打开供应商设置

有两个入口：

- 首次引导选择“配置 pi agent 模型服务”或“添加自定义供应商”；
- 打开“设置 → 供应商”。

模型配置只使用官方 WebUI 的供应商设置，不提供悬浮按钮或另一套模型弹窗。

## 添加供应商

### 从目录添加

目录直接读取当前 pi Runtime，展示 pi agent 内置 Provider 和模型：

1. 选择 Provider；
2. 输入 API Key；
3. 保留 pi 原生 Provider 名称并导入。

凭据由 `ModelRuntime.login()` 写入 `auth.json`。环境变量提供的凭据可直接使用，但不能
在页面删除。只支持 OAuth 的 Provider 会显示“OAuth 登录”，点击后直接进入授权流程。

### 手动添加

手动添加适合 OpenAI、Anthropic、Google 等兼容接口。需要填写：

- Provider 名称和 API 协议；
- API Key 和 Base URL；
- 至少一个模型 ID 和上下文长度。

自定义 Provider 使用 pi agent 原生 `models.json` 格式。页面没有“最大输出长度”字段时，
Pi Code 不写入 `maxTokens`，由 Provider 或 pi agent 决定。

保存 `models.json` 时会保留未知字段并执行 pi schema 校验。原文件可以包含 `//` 注释和
尾随逗号；通过页面保存后会格式化为标准 JSON，注释不会保留。

## OAuth

官方 WebUI 的“账户”页只支持 Kimi 自己的登录协议，因此 Pi Code 隐藏该入口，在
“设置 → 供应商 → 从目录添加”中接入 pi agent 原生 OAuth。

选择 OAuth Provider 后，页面会按 Provider 的原生流程展示登录方式、授权链接、设备码或
手动验证码输入。授权过程可取消；页面刷新或重新进入设置后，会恢复同一 Provider 未完成
的流程和当前授权链接。完成后凭据由 `ModelRuntime.login()` 写入 `auth.json`，OAuth Token
不会写入浏览器。也可以继续使用 pi CLI 的 `/login`，两端读取同一份凭据。

## 默认模型

在“设置 → 通用 → Agent 默认值”中选择新会话的默认模型；对话输入框的模型选择器用于
当前会话。两个选择器只展示 `ModelRuntime.getAvailable()` 返回的模型。服务端会把页面
提交的模型 ID 解析为唯一的 `provider/model`，再由 `SettingsManager` 写入
`settings.json`。配置更新不会中断正在执行的 turn。

## 配置文件

| 文件 | 内容 | 写入方 |
| --- | --- | --- |
| `auth.json` | 内置 Provider 的 API Key、OAuth 凭据 | pi `ModelRuntime` |
| `settings.json` | 默认 Provider、模型和思考等级 | pi `SettingsManager` |
| `models.json` | 自定义 Provider、模型及其凭据 | Pi Code，按 pi schema 校验 |
| `models-store.json` | 远程模型目录缓存 | pi `ModelRuntime.refresh()` |

浏览器不会保存模型 API Key。Pi Code 服务 Token 与模型凭据是两套独立认证，不能混用。

## 常见问题

- **目录中显示 OAuth 登录**：该 Provider 不接受 API Key。点击条目后按页面提示授权；
  也可以使用 pi CLI 的 `/login`。
- **OAuth 刷新后仍未完成**：重新打开同一个 Provider 会恢复原流程；过期后再重新发起。
- **Provider 保存后显示错误**：凭据已保存，但认证检查失败。核对 Key、网络和 Provider
  账号状态。
- **默认模型不可用**：先确认 Provider 已连接，再刷新模型并重新选择。
- **无法删除凭据**：环境变量凭据必须从启动 Pi Code 的进程环境中移除。
- **提示配置已变化**：`models.json` 已被 pi CLI 或其他进程修改。刷新页面后重试，Pi Code
  不会覆盖外部修改。
- **自定义 Provider 校验失败**：检查协议、Base URL、模型 ID 和上下文长度。失败不会替换
  原文件。
- **配置接口返回 401**：从带服务 Token 的 Pi Code 页面重新进入；不要输入模型 API Key。

接口、安全边界和验收项见 [Pi agent 模型配置架构与验收](model-configuration-plan.md)。
