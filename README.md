# flow-codeblock-mcp

Flow Codeblock 的本地 stdio MCP Server 与 Codex Skill。MCP 只调用 Flow Codeblock Rust REST API，不在用户电脑执行用户 JavaScript；用户代码仍由服务端固定版本 Bun Supervisor 执行。

## 安装

需要 Bun 1.4.0 或更高版本：

```bash
bunx --bun flow-codeblock-mcp@0.2.27
```

必须配置：

```bash
FLOW_CODEBLOCK_BASE_URL=https://qingcode.oalite.com
FLOW_CODEBLOCK_TOKEN=flow_xxx
```

`FLOW_CODEBLOCK_BASE_URL` 是已部署的 Flow Codeblock Rust API 地址，也是代码调用地址的基址。非脚本工具会返回 `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock` 形式的 `execution_url`；脚本创建、更新和执行工具会返回 `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock/{script_id}` 形式的 `script_url`，无需再向用户询问域名。其他管理工具不额外附加调用地址。公网服务使用 `https://qingcode.oalite.com`；仅当用户在本机部署 Rust 服务时才改为对应的 localhost 地址。Token 应使用客户端的环境变量或密钥配置，不要写入提示词、工具参数或公开文件。

## 通用 stdio MCP 配置

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.2.27"],
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
- 查询当前脚本时调用 `flow_get_script`，只传 `script_id`；MCP 会固定向 API 附加 `version=0` 标识当前版本，并将详情中的 `code_base64` 解码为 UTF-8 `code` 返回给大模型。只有明确查询具体历史版本时才调用 `flow_get_script_version`，该工具同样会解码代码；无法严格解码时保留原始 `code_base64`。接口文档当前与历史版本分别使用 `flow_get_script_documentation` 和 `flow_get_script_documentation_version`。
- 所有工具 JSON 出参中的 `token`、`access_token`、`authorization`、`refresh_token`、`qingcodeToken` 等凭据字段都会自动脱敏；统计字段如 `token_cache`、`unique_tokens` 不会被误处理。
- `flow_preview_script_change` 会向模型暴露结构化的 `interface_doc` 工具 Schema。预览前还会纠正可无歧义识别的 `responses/logic_description` 深层错位、误放的完整请求示例、`schema.properties.required`、脚本 `description` 和 `ip_whitelist`，将说明字段中误写的 `input.query/header/body/cookies` 转换为调用方 HTTP 术语，并通过 `interface_doc_normalizations` 返回修正记录；更新时与当前值相同的 `ip_whitelist` 会从变更载荷中省略，并通过 `ignored_changes` 说明，避免只改接口文档时误报白名单变更；固定字段对象使用 `properties`，键名未知且值同构的字典使用对象形式 `additionalProperties`，仅脚本原样透传且结构确实未知的上游 JSON 对象使用 `additionalProperties: true`。
- 创建或更新脚本必须先调用 `flow_preview_script_change`，向用户展示预览并获得明确确认后才能调用 `flow_apply_script_change`。
- `flow_preview_script_change.operation` 建议显式传入；漏传时 MCP 会根据 `script_id` 自动推断，没有脚本 ID 视为创建，有脚本 ID 视为更新，并在 `input_normalizations` 中说明。
- 非脚本写码/执行返回完整 `execution_url`；脚本创建、更新发布及执行返回完整 `script_url`。列表、读取、文档、统计和所有权工具不额外附加调用地址。
- 用户代码不能读取 `process.env` 或服务器业务环境变量。百度 AK 等第三方密钥必须由外部调用方通过业务请求体、查询参数或业务请求头传入，并在接口文档中声明；`FLOW_CODEBLOCK_TOKEN` 仅供 MCP 平台认证。
- 释放所有权时，先用 `flow_request_script_owner_challenge(action=release)` 申请当前所有者验证码，再调用 `flow_release_script_ownership`；脚本必须先解锁，释放后其他 Token 使用者可以重新认领。
- 脚本 POST 调用方直接提交业务 JSON，不包装为 `input` 或 `input.body`。
- MCP 不提供删除脚本工具；删除需要用户通过网页或 REST API 自行操作。
- 执行操作正常进行认证、限流、配额扣减、安全校验、统计和审计。
