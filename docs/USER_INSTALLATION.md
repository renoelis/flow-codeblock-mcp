# Flow Codeblock MCP 用户安装手册

本文面向使用 Flow Codeblock MCP 的最终用户，说明如何安装本地 MCP Server，并在 Codex、Cherry Studio、Cursor 和 WorkBuddy 中完成配置。

## 1. 当前版本和工作方式

当前公开版本：`0.2.0`

安装的 MCP Server 运行在用户自己的电脑上，通过 HTTP 调用 Flow Codeblock Rust 服务；用户提交的 JavaScript 不会在用户电脑执行，仍由服务端固定版本的 Bun Supervisor 执行。

当前第一版只支持：

- 本地 `stdio` MCP；
- npm 包 `flow-codeblock-mcp`；
- 通过 `FLOW_CODEBLOCK_BASE_URL` 访问 Rust REST API；
- 通过 `FLOW_CODEBLOCK_TOKEN` 完成认证。

当前不支持：

- Streamable HTTP；
- SSE；
- 直接把 `http://103.40.14.90:53002` 当作 MCP Server 地址；
- 仅支持远程 HTTP MCP、但不支持本地 stdio 的客户端连接方式。

> 服务地址是 Rust REST API 地址，不是 MCP 地址。生产环境建议使用 HTTPS 域名，避免 Token 通过明文 HTTP 传输。

## 2. 安装前准备

### 2.1 安装 Bun

需要 Bun `1.4.0` 或更高版本。安装后检查：

```bash
bun --version
```

如果客户端电脑没有 Bun，请先按 [Bun 官方安装说明](https://bun.sh/docs/installation) 安装，并重新打开终端或客户端。

### 2.2 准备 Flow Codeblock Token

向管理员获取当前用户专用的 `FLOW_CODEBLOCK_TOKEN`。每个用户应使用独立 Token，并确认该 Token 已被授予所需脚本权限。

不要把真实 Token：

- 提交到 Git 仓库；
- 写入公开 README、截图或工单；
- 写进 npm 包；
- 发给其他用户共用。

客户端如果提供密钥管理或环境变量管理功能，应优先使用该功能保存 Token。

## 3. 通用 stdio 配置

所有支持本地 stdio MCP 的客户端都可以使用下面的配置。将 `<YOUR_FLOW_CODEBLOCK_TOKEN>` 替换为用户自己的 Token：

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.2.0"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "http://103.40.14.90:53002",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

也可以先在终端设置环境变量，再直接运行入口进行连通性检查：

```bash
export FLOW_CODEBLOCK_BASE_URL=http://103.40.14.90:53002
export FLOW_CODEBLOCK_TOKEN='flow_xxx'
bunx --bun flow-codeblock-mcp@0.2.0
```

启动后进程会等待 MCP 客户端通过 stdio 通信，这是正常现象。不要在终端手工输入 JSON；应由客户端启动并管理该进程。

## 4. Codex 配置

### 4.1 推荐：直接注册本地 stdio MCP

Codex CLI 和桌面 Codex 都可以使用本地 stdio MCP。打开终端执行：

```bash
codex mcp add flow-codeblock \
  --env FLOW_CODEBLOCK_BASE_URL=http://103.40.14.90:53002 \
  --env FLOW_CODEBLOCK_TOKEN='<YOUR_FLOW_CODEBLOCK_TOKEN>' \
  -- bunx --bun flow-codeblock-mcp@0.2.0
```

检查配置：

```bash
codex mcp get flow-codeblock
codex mcp list
```

Token 可能会被写入本机 Codex 配置文件。不要把该配置文件提交到 Git 或发送给其他人；如果企业环境有密钥管理功能，优先使用密钥管理功能注入环境变量。配置完成后重启 Codex 或新建会话。

### 4.2 可选：安装 Skill/Plugin

插件仓库地址：<https://github.com/renoelis/flow-codeblock-mcp>

仓库包含以下 Codex 插件文件：

```text
.codex-plugin/plugin.json
.mcp.json
skills/flow-codeblock/SKILL.md
```

如果你的 Codex 工作区已经配置了包含该仓库的 marketplace，可在 Codex 的 **Plugins** 页面安装；Codex CLI 可输入 `/plugins`，选择对应 marketplace 后安装。安装插件后仍需按 4.1 注册 MCP，或在该 marketplace 的 MCP 环境配置中提供 `FLOW_CODEBLOCK_TOKEN`。

如果当前插件尚未出现在你的公共插件目录，可以先下载或克隆仓库，再将 `skills/flow-codeblock` 安装到 Codex 的 skills 目录（默认是 `~/.codex/skills/flow-codeblock`），同时按 4.1 注册 MCP。这样即可使用 Skill 的代码生成和发布流程。

> 官方说明：Codex 桌面应用可从 Plugins 页面安装插件；Codex CLI 使用 `/plugins`；IDE 扩展不支持插件。详见 [OpenAI Plugins 文档](https://learn.chatgpt.com/docs/plugins)。

### 4.3 在 Codex 中使用

可以直接用自然语言提出以下请求：

```text
查询我的 Flow Codeblock token 信息和脚本列表。
```

```text
根据我的需求生成 JavaScript 和 script-interface-doc.v1 JSON，先预览，不要发布。
```

```text
预览通过后，向我展示变更摘要；只有我明确确认后再发布。
```

Skill 会要求先预览、再由用户明确确认发布。MCP 不提供删除脚本工具；需要删除时，请使用现有网页或 REST API。锁定、解锁和所有权转移会按服务端要求经过验证码流程。

## 5. Cherry Studio 配置

不同版本的 Cherry Studio 菜单名称可能略有差异，通常路径为：

```text
设置 -> MCP Servers（或 MCP 服务器） -> 添加服务器
```

选择服务器类型 `stdio`（本地命令），填写：

| 字段 | 值 |
| --- | --- |
| 名称 | `flow-codeblock` |
| Command / 命令 | `bunx` |
| Arguments / 参数 | `--bun flow-codeblock-mcp@0.2.0` |
| `FLOW_CODEBLOCK_BASE_URL` | `http://103.40.14.90:53002` |
| `FLOW_CODEBLOCK_TOKEN` | 用户自己的 Token |

如果参数输入框要求一行一个参数，请填写两行：

```text
--bun
flow-codeblock-mcp@0.2.0
```

保存后启用该服务器，使用“测试连接”或查看工具列表。若工具列表为空，先检查 Bun 路径和 Token，再重启 Cherry Studio。

## 6. Cursor 配置

Cursor 通常支持在全局设置或项目配置中添加 MCP。项目级配置文件为：

```text
.cursor/mcp.json
```

在项目根目录创建或编辑该文件，内容如下：

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.2.0"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "http://103.40.14.90:53002",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

也可以在 Cursor 的 `Settings -> Tools & MCP`（部分版本显示为 `Settings -> MCP`）中新增一个 `stdio` Server，并分别填写相同的 command、args 和 env。

保存配置后，在 MCP 面板确认 `flow-codeblock` 已启用；若 Cursor 显示命令启动失败，先在 Cursor 可用的终端执行 `bunx --bun flow-codeblock-mcp@0.2.0`，确认 Bun 已加入系统 PATH。

## 7. WorkBuddy 配置

WorkBuddy 的设置入口和字段名称会随版本变化，通常在：

```text
设置 -> MCP / 工具 -> 添加 MCP 服务器
```

选择本地 `stdio` 或“命令行服务器”，填写：

```text
名称: flow-codeblock
命令: bunx
参数: --bun flow-codeblock-mcp@0.2.0
```

在环境变量区域添加：

```text
FLOW_CODEBLOCK_BASE_URL=http://103.40.14.90:53002
FLOW_CODEBLOCK_TOKEN=<YOUR_FLOW_CODEBLOCK_TOKEN>
```

如果 WorkBuddy 将参数拆成列表，请按顺序添加 `--bun` 和 `flow-codeblock-mcp@0.2.0` 两项。保存并启用后，刷新工具列表即可看到 Flow Codeblock 工具。

## 8. 首次使用建议

建议按下面顺序验证账号和权限：

1. 调用 `flow_token_info`，确认 Token 有效、配额和过期时间正常。
2. 调用 `flow_list_scripts`，确认能读取当前 Token 名下脚本。
3. 涉及写代码时先调用 `flow_write_code`，明确选择 `non_script` 或 `script` 模式。
4. 非脚本模式只生成 JavaScript 和 `POST /flow/codeblock` 请求体；用户明确要求测试时调用 `flow_execute_code`。
5. 脚本模式生成两份独立内容：一份 `javascript` 代码，一份符合 `script-interface-doc.v1` 的 JSON。
6. 调用 `flow_preview_script_change`，检查校验结果、敏感字段警告和变更摘要。
7. 用户明确确认后，调用 `flow_apply_script_change`，并传入 `confirm: true` 和返回的 `preview_id`。
8. 创建成功后使用 `flow_execute_script` 测试脚本，再用 `flow_script_stats` 查看统计。

更新脚本时必须先读取当前版本并传入 `expected_version`。只修改描述或 IP 白名单不会生成新代码版本；`ip_whitelist: null` 表示清除白名单，省略该字段表示保持原值。

## 9. 工具和操作边界

MCP 提供以下能力：

- 非脚本 JavaScript 代码编写规则和调用请求体说明；
- 非脚本 JavaScript 执行和测试；
- Token 元数据查询；
- 脚本列表、代码和接口文档读取；
- 脚本创建/更新预览和确认发布；
- 脚本执行和统计查询；
- 脚本锁定、解锁和所有权转移。

MCP 不提供脚本删除、Token 管理或任意 HTTP 代理工具。删除脚本必须由用户通过现有网页或 REST API 完成。

锁定、解锁和所有权转移涉及邮箱验证码。验证码只能由用户在对应工具调用时提供，不要写入 Skill、配置文件、脚本或公开文档。

所有执行请求都由服务端执行认证、配额扣减、限流、危险模式校验、模块白名单、审计和统计，并进入网页专用 Web worker lane；普通 HTTP 请求仍由服务端按其标准 lane 规则处理。

## 10. 代码编写模式

### 非脚本模式

调用 `flow_write_code` 时传入：

```json
{
  "mode": "non_script",
  "requirement": "将输入数组按金额从高到低排序并返回前十条",
  "input_example": {"items": [{"amount": 10}]}
}
```

模型应返回 JavaScript 和以下 REST 请求体说明，不创建脚本：

```json
{
  "codebase64": "<Base64 编码的 JavaScript>",
  "input": {"items": [{"amount": 10}]},
  "qingcodeTimeout": 3000
}
```

该请求体用于 `POST /flow/codeblock`。使用 MCP 时，不要把 `accessToken` 放进 `input`；`flow_execute_code` 会自动注入认证和 MCP Web lane 标识。

### 脚本模式

调用 `flow_write_code` 时传入 `mode: "script"`。模型必须生成独立的 JavaScript 和 `script-interface-doc.v1` JSON，然后按以下顺序执行：

```text
flow_write_code -> flow_preview_script_change -> 用户确认
-> flow_apply_script_change -> flow_execute_script
```

预览和确认是发布前置条件；未经用户明确确认，不得创建或更新脚本。脚本创建的代码和接口文档会作为同一版本原子保存。

## 11. 常见问题

### 报错 `FLOW_CODEBLOCK_TOKEN is required`

说明 MCP Server 进程没有收到 Token。检查客户端的环境变量配置名称是否完全为 `FLOW_CODEBLOCK_TOKEN`，然后重启客户端。

### 报错 `fetch failed` 或连接超时

检查用户电脑能否访问 `FLOW_CODEBLOCK_BASE_URL`，确认防火墙、反向代理和 HTTPS 证书配置正常。服务地址必须包含协议，例如 `http://` 或 `https://`。

### 客户端提示不支持该 MCP

确认客户端支持本地 `stdio` MCP。当前版本没有提供 Streamable HTTP、SSE 或其他远程 MCP 传输；只支持远程 MCP 的客户端暂时无法直接使用本包。

### 更新发布失败

重新读取脚本当前版本并再次预览。常见原因是预览已过期、内容被修改、`expected_version` 发生冲突，或脚本已锁定。

### 为什么没有删除工具

这是产品边界设计。MCP 和 Skill 会拒绝删除请求，用户需要到现有网页或 REST API 执行删除。

## 12. 版本升级

客户端配置中的包版本固定为 `flow-codeblock-mcp@0.2.0`，可在确认新版本发布后统一替换版本号。升级前建议先阅读 GitHub 仓库的 Release 或变更说明，并重启客户端让新的 MCP Server 生效。
