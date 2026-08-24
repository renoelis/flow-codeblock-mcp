---
name: flow-codeblock
description: 使用 Flow Codeblock MCP 工具写出非脚本代码或创建、校验、发布和执行脚本；涉及脚本删除时必须拒绝并引导用户使用现有网页或 REST API。
---

# Flow Codeblock

此 Skill 配合本插件的 stdio MCP Server 使用。MCP Server 只调用 Flow Codeblock Rust HTTP API；用户 JavaScript 仍由 Rust 服务启动固定版本的 Bun Supervisor 执行。

## 认证和边界

- MCP Server 从进程环境读取 `FLOW_CODEBLOCK_BASE_URL`（默认 `http://103.40.14.90:53002`）和 `FLOW_CODEBLOCK_TOKEN`。
- 认证值由 MCP Server 从 `FLOW_CODEBLOCK_TOKEN` 读取；工具不要求把 Token 放入业务参数。Token 查询工具会按 Rust API 原样返回当前 Token 元数据。
- MCP 不提供删除脚本、token 管理或任意 HTTP 代理工具。用户要求删除时必须明确拒绝，不要改用其他工具模拟删除。锁定、解锁和所有权转移必须通过验证码流程工具完成。
- 非脚本和脚本执行工具都使用始终启动的独立 Web worker lane，并保留服务端认证、配额、限流、危险模式、模块白名单、审计和统计规则；不能改走 Standard lane。

## 模式选择

所有涉及“写代码”“生成代码”“实现接口”的请求，必须先调用 `flow_write_code`，根据用户意图选择模式：

- `non_script`：只生成可执行 JavaScript 和调用规则，不写数据库、不创建脚本。非脚本请求体中的 `input` 是业务参数对象本身；必须说明 `POST /flow/codeblock` 的请求体和调用方式；用户明确要求测试时，才调用 `flow_execute_code`。
- `script`：生成 JavaScript 和独立的 `script-interface-doc.v1` JSON。脚本代码中的 `input` 固定是 `{ query: {}, header: {}, body: {}, cookies: {} }` 这类 HTTP 输入信封，先预览；用户明确确认后创建脚本和接口文档，再调用 `flow_execute_script` 测试执行。

不要把非脚本代码上传到脚本管理接口，也不要把脚本模式的发布流程省略成一次未经确认的写库操作。

## 工具选择

- `flow_write_code`：选择非脚本或脚本写码模式，返回代码规则、请求体模板和后续工具链；不写库、不执行。
- `flow_execute_code`：执行非脚本 JavaScript，调用 `POST /flow/codeblock` 并使用 Web lane。
- `flow_token_info`：查询当前 token 的状态、配额、过期时间和脚本额度。
- `flow_list_scripts`：分页列出脚本。
- `flow_get_script`：读取当前或历史版本的代码、描述、IP 白名单和文档。
- `flow_get_script_documentation`：读取当前或历史脚本接口文档。
- `flow_request_script_owner_challenge`：申请锁定或解锁验证码。
- `flow_lock_script`：使用锁定验证码锁定脚本并设置所有者。
- `flow_unlock_script`：使用解锁验证码解除脚本锁定。
- `flow_start_ownership_transfer`：校验授权邮箱并向新所有者发送验证码。
- `flow_confirm_ownership_transfer`：使用新所有者验证码完成转移。
- `flow_preview_script_change`：预览创建或更新，调用服务端校验但不写库。
- `flow_apply_script_change`：仅发布已预览内容；必须同时传入 `preview_id` 和 `confirm: true`。
- `flow_execute_script`：执行指定脚本，结果会按正常执行请求扣减配额。
- `flow_script_stats`：查询脚本执行统计。

## 非脚本模式流程

1. 调用 `flow_write_code`，传 `mode: "non_script"` 和用户需求。
2. 生成符合代码规则的 JavaScript，使用 `input` 并通过顶层 `return` 返回结果。
3. 向用户展示 JavaScript 代码，以及非脚本调用规则：

   ```json
   {
     "codebase64": "<Base64 编码的 JavaScript>",
     "input": {},
     "qingcodeTimeout": 3000
   }
   ```

该请求体提交到 `POST /flow/codeblock`。MCP 工具调用时只传 `code` 或 `code_base64`、`input` 和可选 `timeout_ms`；MCP Server 自动补认证头和 `X-Flow-Execution-Origin: mcp`。
4. 用户仅要求代码时，不调用执行工具；用户明确要求测试或执行时，才调用 `flow_execute_code`。

非脚本模式不得生成 `script-interface-doc.v1`，也不得调用 `flow_preview_script_change` 或 `flow_apply_script_change`。

## 脚本变更流程

1. 调用 `flow_write_code`，传 `mode: "script"` 和用户需求。
2. 创建脚本时生成 JavaScript 和独立接口文档；更新脚本时先读取当前脚本和当前版本，更新必须使用读取到的 `expected_version`。
3. 调用 `flow_preview_script_change`。创建必须提交 `code` 或 `code_base64`；更新可以只提交描述或 `ip_whitelist`，也可以提交代码和/或 `interface_doc`。
4. 向用户展示校验结果、代码 hash、规范化文档、敏感字段警告和变更摘要。
5. 只有预览校验通过且用户明确确认后，才调用 `flow_apply_script_change`；创建成功后必须继续调用 `flow_execute_script` 做测试执行。
6. 预览过期、版本冲突或内容变化时停止并重新读取、预览；不要强行覆盖。

脚本代码的输入必须按 HTTP 位置读取，不能把非脚本的业务对象写法直接套到脚本模式：

```javascript
const userId = input.query?.userId;
const authorization = input.header?.authorization;
const payload = input.body ?? {};
const sessionId = input.cookies?.session_id;
```

版本规则由服务端保证：代码或接口文档 canonical JSON 变化才生成新版本；只改描述或 IP 白名单不生成新版本；多个字段同时变化在一次更新中提交。创建时代码和接口文档原子保存为版本 1。

## 所有权操作流程

- 锁定：先调用 `flow_request_script_owner_challenge`，`action` 为 `lock`；再把邮箱收到的验证码传给 `flow_lock_script`，同时提交 `owner_name`。
- 解锁：先调用 `flow_request_script_owner_challenge`，`action` 为 `unlock`；再把验证码传给 `flow_unlock_script`。必须使用当前所有者邮箱。
- 转移：调用 `flow_start_ownership_transfer`，`authorizer_email` 使用当前所有者邮箱或脚本 Token 登记邮箱；拿到 `transfer_id` 后，由新所有者使用验证码调用 `flow_confirm_ownership_transfer`。
- 不要在工具参数、说明或脚本中猜测或复用验证码；验证码错误、过期、冷却和所有者不匹配时停止流程并报告服务端错误。

## 代码生成规则

生成非脚本代码或修改用户脚本时，先阅读以下项目资料，并以 `AGENT_PROMPT.md` 的完整规则为准：

- [AGENT_PROMPT.md](references/AGENT_PROMPT.md)

- [API 约定](references/api.md)
- [接口文档 schema](references/script-interface-doc.schema.json)
- [危险模式](references/dangerous_patterns.json)
- [允许模块](references/modules.json)

代码必须使用 `input` 接收输入并使用顶层 `return` 返回结果；非脚本模式的 `input` 是业务对象，脚本模式的 `input` 是 `{ query, header, body, cookies }` HTTP 输入信封。只使用允许模块；优先使用标准 JavaScript 和原生 `fetch`；禁止动态 `import`、`export`、间接 `require`、`module`、`exports` 及危险模式；禁止浏览器 API 和黑名单 Node 模块；遵守代码、输入、结果和超时限制。脚本模式的接口文档不得写入 JavaScript 注释，必须作为独立的 JSON 对象生成，并符合 `references/script-interface-doc.schema.json` 定义的 `script-interface-doc.v1` 结构。这里提交的是符合 Schema 的接口文档实例，不是 Schema 定义本身。

接口文档 JSON 应描述输入 query、headers、POST body、响应和逻辑，并与代码实际行为一致；方法只能是 `GET` 或 `POST`。创建脚本时可以省略 `endpoint.path`，由服务端填入真实脚本 ID；通过 MCP 预览创建时也可以使用 `/flow/codeblock/{script_id}` 占位形式，MCP 会移除该占位路径。更新脚本时必须填写实际的 `/flow/codeblock/{script_id}` 路径。代码可以有少量实现注释，但不得用 JSDoc 或块注释承载接口契约。不要在文档、示例、代码或工具说明中写入真实 Token、密码、Cookie、Authorization 值或其他敏感凭据。发布前必须完成预览和确认。

脚本模式向用户展示生成结果时，使用两个独立代码块：第一个为可执行 `javascript` 代码，第二个为可直接作为 `interface_doc` 提交的 `json` 对象；不要把 Markdown 说明或注释放入 JSON 块。非脚本模式不输出接口文档，而是输出 JavaScript 和 `POST /flow/codeblock` 请求体示例。

## 调用约定

工具参数使用 JSON snake_case 字段。非脚本执行代码二选一：`code`（UTF-8 JavaScript）或 `code_base64`，输入放入 `input`。脚本代码二选一：`code` 或 `code_base64`；更新操作必须带 `script_id` 与 `expected_version`；创建操作不能带 `script_id`。`ip_whitelist` 为字符串数组或 `null`，其中 `null` 表示清除白名单，字段省略表示保持原值。脚本执行时仅允许 `GET`/`POST`，输入放入 `query`、`headers` 和 `body`。

不要向用户承诺远程 HTTP/SSE/Streamable HTTP 连接；第一版只提供本地 stdio MCP Server。其他 MCP 客户端可按其 stdio 配置方式启动同一个 Bun 入口。
