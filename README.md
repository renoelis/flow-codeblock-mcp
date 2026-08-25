# flow-codeblock-mcp

Flow Codeblock 的本地 stdio MCP Server 与 Codex Skill。MCP 只调用 Flow Codeblock Rust REST API，不在用户电脑执行用户 JavaScript；用户代码仍由服务端固定版本 Bun Supervisor 执行。

## 安装

需要 Bun 1.4.0 或更高版本：

```bash
bunx --bun flow-codeblock-mcp@0.2.11
```

必须配置：

```bash
FLOW_CODEBLOCK_BASE_URL=https://qingcode.oalite.com
FLOW_CODEBLOCK_TOKEN=flow_xxx
```

`FLOW_CODEBLOCK_BASE_URL` 是已部署的 Flow Codeblock Rust API 地址。公网服务使用 `https://qingcode.oalite.com`；仅当用户在本机部署 Rust 服务时才改为对应的 localhost 地址。Token 应使用客户端的环境变量或密钥配置，不要写入提示词、工具参数或公开文件。

## 通用 stdio MCP 配置

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.2.11"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://qingcode.oalite.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

npm 包包含 MCP 运行源码、`flow-codeblock` Skill、`AGENT_PROMPT.md`、模块/危险模式规则和接口文档 Schema。普通 MCP 客户端不会自动安装 Codex Skill，但 `flow_write_code` 会直接读取包内权威规则，因此不依赖 Skill 注入也能获得完整代码契约。

## 使用约束

- 写代码前调用 `flow_write_code`；非脚本模式从 `input.<字段>` 读取，脚本模式从 `input.query/header/body/cookies` 读取。
- 查询当前脚本时调用 `flow_get_script`，只传 `script_id`；MCP 会固定向 API 附加 `version=0` 标识当前版本。只有明确查询具体历史版本时才调用 `flow_get_script_version`。接口文档当前与历史版本分别使用 `flow_get_script_documentation` 和 `flow_get_script_documentation_version`。
- 创建或更新脚本必须先调用 `flow_preview_script_change`，向用户展示预览并获得明确确认后才能调用 `flow_apply_script_change`。
- 脚本 POST 调用方直接提交业务 JSON，不包装为 `input` 或 `input.body`。
- MCP 不提供删除脚本工具；删除需要用户通过网页或 REST API 自行操作。
- 执行操作正常进行认证、限流、配额扣减、安全校验、统计和审计。
