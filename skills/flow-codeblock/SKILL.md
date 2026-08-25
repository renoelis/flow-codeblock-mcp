---
name: flow-codeblock
description: 使用 Flow Codeblock MCP 工具写出非脚本代码或创建、校验、发布和执行脚本；涉及脚本删除时必须拒绝并引导用户使用现有网页或 REST API。
---

# Flow Codeblock

此 Skill 配合本插件的 stdio MCP Server 使用。MCP Server 只调用 Flow Codeblock Rust API，用户 JavaScript 始终在服务端 Bun Supervisor 中执行。

## 边界

- MCP 必须从环境读取 `FLOW_CODEBLOCK_BASE_URL` 和 `FLOW_CODEBLOCK_TOKEN`；缺少任一变量时拒绝启动。公网服务使用 `https://qingcode.oalite.com`，仅本机部署 Rust 服务时使用对应的 localhost 地址。不要把 Token 放入工具参数、代码或文档。
- 不提供脚本删除、Token 管理或任意 HTTP 代理工具。删除请求必须拒绝，并引导用户使用现有网页或 REST API。
- 执行工具使用 MCP Web worker lane，但仍执行服务端认证、配额、限流、安全校验、审计和统计。
- 锁定、解锁和所有权转移只能使用对应验证码工具，不猜测、记录或复用验证码。

## 写码模式

凡是写代码或实现接口，先调用 `flow_write_code` 并选择模式。

读取脚本时，当前版本使用 `flow_get_script`，只传 `script_id`，MCP 会固定向 API 附加 `version=0` 标识当前版本；只有用户明确要求某个具体历史版本时才使用 `flow_get_script_version`，并传入用户指定或 `available_versions` 中已有的版本号，不得猜测。接口文档的当前版本和历史版本分别使用 `flow_get_script_documentation` 与 `flow_get_script_documentation_version`，不得猜测文档版本。

### `non_script`

只生成 JavaScript 和 `POST /flow/codeblock` 调用规则，不创建脚本。请求体中的 `input` 是业务对象本身，代码使用 `input.<字段>`。

只要求写代码时不要执行；用户明确要求测试时才调用 `flow_execute_code`。

### `script`

生成两个独立代码块：可执行 JavaScript，以及可直接作为 `interface_doc` 提交的 `script-interface-doc.v1` JSON。

代码运行时内部输入为 `{ query, header, body, cookies }`，按需读取对应位置；调用方发送普通 HTTP 请求，POST 业务 JSON 直接放在请求体中，不包装成 `input` 或 `input.body`。接口文档只使用查询参数、请求头、请求体和 Cookie 等调用方概念。

创建或更新代码的流程：

1. 生成代码和完整接口文档；更新前先用 `flow_get_script` 读取当前版本，只传 `script_id`。
2. 调用 `flow_preview_script_change`。创建不带 `script_id`；更新带 `script_id` 和 `expected_version`。更新预览会先确认脚本存在且版本未变化；404 或版本冲突时停止并重新读取，不得继续发布。
3. 展示预览结果。只有用户明确确认后，才调用 `flow_apply_script_change`，传 `preview_id` 和 `confirm: true`。
4. 创建成功后调用 `flow_execute_script`，其 `body` 参数直接传业务 JSON，报告执行和配额结果。

创建时 `description` 是脚本列表展示名称。用户未指定名称时，根据需求概括为不超过 15 个字符；用户明确给出较长名称时保留原意，不要擅自截断。

创建和代码更新必须提交接口文档；只改描述或 IP 白名单可以不提交。代码或文档变化生成新版本，只改描述/IP 不生成新版本；`ip_whitelist: null` 表示清除，省略表示保持。

## 接口文档

MCP 预览使用严格完整性门禁。文档必须与代码行为一致，并包含：

- 文档必填：`schema_version/title/summary/endpoint/responses/logic_description`；没有实际参数时 `request` 可省略；`usage_refs` 始终可省略，仅有真实应用引用时填写 `{app_name,app_id?,location?,note?}` 对象数组，普通说明写入 `logic_description`；
- `title` 是文档标题，`summary` 是一句话摘要，`logic_description` 必须具体说明输入、校验、处理步骤、外部调用、成功响应和错误分支；
- `endpoint` 必填 `methods/description`；`methods` 只能是 `GET`、`POST`；`path` 创建时可省略，更新时必填实际路径；最终调用地址是用户提供的域名加 `/flow/codeblock/{{脚本ID}}`，用户未提供域名时先询问，不得猜测；
- 查询参数、请求头和请求体字段只有实际存在时才填写，并且必须提供名称、类型、描述和具体值；参数对象同时保留 `required` 表示运行时是否必填；需要描述 POST 请求体时填写 `content_type/schema/example`；
- 每个响应必填 `status/description/content_type/schema/example`；
- 响应 Schema 中每个字段必须填写 `type/description/example`，字段名称由 `properties` 的键表达；

嵌套 Schema 和示例必须先自行递归检查一次，通过后再调用预览；不得依靠连续预览逐项发现缺失字段：

- 请求体或响应体的根 Schema 节点必须填写 `type`；其所有嵌套 Schema 节点（包括 `properties` 字段、数组的 `items`、`additionalProperties` 值 Schema）都必须填写 `type/description/example`；固定字段对象必须有完整 `properties`；动态键字典可使用 `additionalProperties` 描述完整的值 Schema；二者不能同时缺失；
- 每个 `type: "array"` 必须有 `items`，且 `items` 本身也必须填写 `type/description/example`；对象数组还必须有完整 `items.properties`；
- 数组值中的每个对象都必须包含 `items.properties` 的全部字段；
- 任意层级示例中出现的字段必须有对应 `properties` 或 `additionalProperties`；列入 `required` 的字段必须出现在示例中，运行时可选字段可以省略；
- JSON Schema 的 `required` 只声明运行时真正必填的业务字段；成功、错误结构不同应拆成不同 `responses`。

规范结构中，请求体和每个响应的完整 `example` 与 `schema` 同级，`properties/required/items/additionalProperties` 放在 `schema` 内。MCP 会在预览前兼容纠正这两类无歧义的位置错误，从父级示例或同名蛇形/驼峰别名补全可推导的节点示例，并移除 `usage_refs` 中无效的非对象条目；预览成功时通过 `interface_doc_normalizations` 返回修正记录，仍有错误时在错误文本的“本次已自动规范化”中返回。必须保留原文档及所有未报错字段，只修正错误列表中的准确路径；不得重写整份文档或删除 `responses`、`logic_description`、`request`。

文档面向调用方，说明文字不得出现 `input.query/input.header/input.body/input.cookies`。创建时 `endpoint.path` 可省略；更新文档时填写实际脚本路径。不要提供预置业务示例，所有 `example` 值必须来自当前需求和代码实际行为。

## 所有权

- 锁定/解锁：先调用 `flow_request_script_owner_challenge`，再用邮件验证码调用 `flow_lock_script` 或 `flow_unlock_script`。
- 转移：调用 `flow_start_ownership_transfer` 后，由新所有者用验证码调用 `flow_confirm_ownership_transfer`。
- 验证码错误、过期、冷却或所有者不匹配时停止并报告服务端错误。

## 代码规则

生成或修改代码时阅读 [AGENT_PROMPT.md](references/AGENT_PROMPT.md)。仅在需要查细节时按需阅读：

- REST 字段或错误：[api.md](references/api.md)
- 完整接口文档结构：[script-interface-doc.schema.json](references/script-interface-doc.schema.json)
- 使用 npm 模块：[modules.json](references/modules.json)
- 安全规则排查：[dangerous_patterns.json](references/dangerous_patterns.json)

代码必须使用 `input` 和顶层 `return`，只使用允许模块，不使用动态 `import`、间接 `require`、`module`、`exports`、浏览器 API 或危险模式。接口契约只放在独立 JSON 中，不得写成 JSDoc 或代码注释。
