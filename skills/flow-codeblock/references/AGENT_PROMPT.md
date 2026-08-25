# Flow-codeblock JavaScript 代码生成规则

本文件是 Flow Codeblock Rust + Bun 执行服务的代码生成规则摘要。生成代码时以本文件和 `script-interface-doc.schema.json` 为约束；实际部署限制以服务端校验结果为准。

## 角色和运行环境

- 只生成可直接执行的 JavaScript，不生成 Rust、Bun Supervisor、HTTP 服务端、数据库或浏览器页面代码。
- 用户代码由 Rust 直接启动的 Bun 1.4.0 Supervisor 在服务端 fresh Worker 中执行。执行之间不共享变量、模块状态或持久化全局状态。
- 支持现代 JavaScript、`async/await`、Promise、箭头函数和顶层 `return`。
- 默认优先使用标准 JavaScript 和原生 `fetch`。除复杂日期处理可使用 `dayjs` 外，只有原生能力确实无法满足且用户明确要求时才使用白名单模块。

## 生成前判断

1. 用户未说明时默认使用即时执行的非脚本模式和顶层 `return`。
2. 用户要求 HTTP 重定向时必须使用脚本模式 `/flow/codeblock/{scriptId}`。
3. 写代码前先确定模式、输入字段、同步/异步流程、输出方式和错误行为，不添加无关请求、模块、定时器或复杂抽象。
4. 创建脚本时 `description` 用作列表展示名称；用户未指定名称时概括为不超过 15 个字符，用户明确给出较长名称时不要擅自截断。

## 输入契约

所有用户数据都从全局 `input` 读取，不从环境变量、持久化全局变量或其他外部状态读取。用户函数收到的 `process` 为 `undefined`，严禁读取 `process.env` 或假设服务端会为单个脚本配置业务环境变量。百度 AK 等第三方 API 密钥必须由外部调用方通过请求体、查询参数或非平台认证用途的业务请求头传入，并在接口文档中声明对应输入字段；不得把真实密钥写入代码、文档示例或说明。`FLOW_CODEBLOCK_TOKEN` 仅由 MCP Server 用于平台认证，不会进入用户代码。

### 非脚本模式

接口为 `POST /flow/codeblock`。请求体中的 `input` 原样注入全局 `input`，缺省为 `{}`；非脚本模式代码直接从 `input.<业务字段>` 读取。

`codebase64` 是执行接口字段名；脚本管理工具中的字段名是 `code_base64`。

### 脚本模式

接口为 `GET|POST /flow/codeblock/{scriptId}`。脚本模式的全局 `input` 是由服务端构建的 HTTP 输入信封，不是业务对象本身，包含 `query`、`header`、`body`、`cookies` 四个位置。

- `input.query`：查询参数，不含 `qingcodeToken` 和 `qingcodeTimeout`；单值为字符串，重复参数为字符串数组。
- `input.header`：请求头；服务端过滤 `x-original-cookie`，需要时从 `cookie` 头读取。
- `input.body`：POST JSON 请求体；空请求体为 `{}`。
- `input.cookies`：Cookie 键值对象；无 Cookie 时可能不存在。

脚本模式下 `qingcodeToken` 仅用于认证，`qingcodeTimeout` 仅用于配置超时，不会进入业务 query 或 body。

## 输出契约

默认且通常唯一的输出方式是顶层 `return`，可返回普通值或 Promise。返回值必须可 JSON 序列化，不能包含循环引用、BigInt、函数、Symbol、未处理的复杂类实例或无界数组/字符串。

只有事件式/异步流程或用户明确要求时才使用 `qf_output`：必须是裸赋值 `qf_output = { ... }`，不得与顶层 `return` 混用，也不得声明、解构、间接引用或遮蔽 `qf_output`。

推荐业务结构：`{ success: true, data: value }` 或 `{ success: false, error: message }`。它是业务结果，不替代平台外层响应。

## 脚本接口文档

脚本模式必须把接口契约作为独立 JSON 对象输出，并通过 `interface_doc` 提交。不得使用 JavaScript 注释承载方法、路径、参数、响应、认证或接口说明。JSON 必须符合 `script-interface-doc.v1`；这些必填规则与 Flow Codeblock 页面、Rust 文档接口一致，示例不是可选提示字段。MCP 预览还会执行下列完整性门禁：

- 文档必填 `schema_version/title/summary/endpoint/responses/logic_description`；无实际参数时 `request` 可省略，`usage_refs` 可省略。
- `title` 是文档标题，`summary` 是一句话摘要，`logic_description` 必须说明输入、校验、处理步骤、外部调用、成功响应和错误分支。
- `endpoint` 必填 `methods/description`；Web 页面录入时 `path` 可省略，MCP 创建时也可省略，更新时使用实际 `/flow/codeblock/{script_id}`；最终调用地址固定为 MCP 环境变量 `FLOW_CODEBLOCK_BASE_URL + /flow/codeblock/{{脚本ID}}`，发布成功后直接使用 `flow_apply_script_change` 返回的 `data.script_url`，不要询问用户域名。
- `endpoint.methods` 只能是 `GET`、`POST`。
- 查询参数、请求头和请求体字段只有实际存在时才填写，并必须有名称、类型、描述和具体值；参数保留 `required` 表示运行时是否必填。
- 需要描述 POST 请求体时填写 `content_type/schema/example`；每个响应必填 `status/description/content_type/schema/example`。
- 响应 Schema 中每个字段必须填写 `type/description/example`；字段名称由 `properties` 的键表达。
- `schema.properties` 只能放字段名到字段 Schema 的映射；`schema.required` 必须与 `properties` 同级，不能把 `required: []` 放进 `properties`。
- 请求体或响应体的根 Schema 节点必须填写 `type`；其所有嵌套 Schema 节点（包括 `properties` 字段、数组的 `items`、对象形式的 `additionalProperties` 值 Schema）都必须填写 `type/description/example`。
- 代码或 `example` 中键名已知的对象必须用 `properties` 逐项描述；对象形式的 `additionalProperties` 只用于键名运行时才确定且所有值结构相同的动态字典，并描述单个动态值的完整 Schema。只有脚本原样透传且无法从代码、接口契约或示例确定结构的上游 JSON 对象，才使用 `additionalProperties: true`；不得用 `additionalProperties: {"type":"object","example":{}}` 表示“允许任意 JSON 值”，也不得在校验报错后继续嵌套同样的空对象 Schema。
- 每个数组必须有 `items`，且 `items` 本身也必须填写 `type/description/example`；`items.type=object` 时还必须有完整 `items.properties`，数组值中的每个对象必须覆盖全部字段。
- 请求体和响应体任意层级的示例中，出现的字段必须有对应 `properties` 或 `additionalProperties`，并且示例的 JSON 类型必须与对应 `type` 一致；列入 `required` 的字段必须出现在示例中，运行时可选字段可以省略。
- JSON Schema 的 `required` 只写运行时真正必填的业务字段；成功和错误结构不同应拆成不同响应，同一状态码下字符串错误与对象错误等不同结构也应拆开描述。
- `logic_description` 必须具体说明请求字段、校验、处理步骤、是否调用外部接口、成功响应和错误分支。
- 文档面向调用方，只写查询参数、请求头、请求体和 Cookie；不得出现 `input.query`、`input.header`、`input.body`、`input.cookies` 等内部结构。调用方 POST 业务 JSON 直接放请求体，不包装为 `input`。MCP 会兼容将说明字段中误写的内部输入术语转换为调用方 HTTP 术语，但新文档应直接使用调用方表述。
- `usage_refs` 可省略，仅有真实应用引用时填写 `{app_name,app_id?,location?,note?}` 对象数组；安全提示和普通说明写入 `logic_description`，不得把字符串数组放入 `usage_refs`。
- JSON 代码块只能包含合法 JSON 对象，不得混入 Markdown、注释或尾随逗号。
- 不提供预置业务示例；所有 `example` 值必须来自当前需求和代码实际行为。文档、代码和工具参数中不得出现真实 Token、密码、Cookie、Authorization 值或验证码。

调用预览前必须按上述规则递归自检一次请求和所有响应；不要依靠重复调用预览工具逐项发现缺失字段。

只有 `flow_preview_script_change` 成功返回 `preview_id` 才能向用户说明预览已通过；`isError=true`、`-32602` 或没有 `preview_id` 均表示预览失败，必须先修正。建议显式传 `operation`；MCP 会兼容漏传该字段，没有 `script_id` 时推断为 `create`，有 `script_id` 时推断为 `update`，并通过 `input_normalizations` 说明。创建时省略 `expected_version`；MCP 仅为兼容模型常见误传而自动忽略 `expected_version=0`。

`interface_doc` 根对象只放 `schema_version/title/summary/endpoint/request/responses/logic_description/usage_refs`；`request` 只放 `query/headers/body`；`ip_whitelist` 是 `flow_preview_script_change` 的工具参数，不放进 `interface_doc`。`responses/logic_description` 必须放在 `interface_doc` 根对象内；请求体和每个响应的完整 `example` 与 `schema` 同级，`request.example` 应写成 `request.body.example`，`properties/required/items/additionalProperties` 放在 `schema` 内。MCP 会在预览前兼容纠正这些无歧义的位置错误，从父级示例或同名蛇形/驼峰别名补全可推导的节点示例，并移除 `usage_refs` 中无效的非对象条目；预览成功时通过 `interface_doc_normalizations` 返回修正记录，仍有错误时在错误文本的“本次已自动规范化”中返回。保留原文档和所有未报错字段，只修正错误列表中的准确路径；不要重写整份文档，也不要删除已有的 `responses`、`logic_description` 或 `request`。

## 原生能力和模块

- 优先使用标准 JavaScript、`URL`、`URLSearchParams`、Promise 和原生 `fetch`。
- 允许的模块以 `modules.json` 为准：`axios`、`cheerio`、`crypto-js`、`csv-parser`、`fast-xml-parser`、`form-data`、`lodash`、`pinyin`、`qs`、`sm-crypto-v2`、`uuid`、`xlsx`、`dayjs`。
- 使用模块时只能使用单个字符串字面量 `require('模块名')`；禁止动态模块名、间接 `require`、静态/动态 ESM `import/export`。
- 能用原生能力完成时不得引入 npm 包，网络请求默认使用 `fetch`，必须检查 HTTP 状态并处理 JSON、文本和空响应。

## 禁止能力和异步生命周期

- 禁止 `import`、`export`、`module.exports`、`exports.foo`、Node CLI/脚本入口和黑名单 Node 模块。
- 禁止 `eval`、`Function`、`Proxy`、`__proto__`、`child_process`、`exec`、`execFile`、`execSync`、`fork`、`spawn`、`setImmediate`、`setInterval`、`setTimeout`。
- 禁止 `Object.getPrototypeOf`、`Object.setPrototypeOf`、`Reflect.construct`、`Reflect.apply`、`Reflect.get`、`Reflect.set`、`process.exit`、`process.kill`、`process.binding`、`process._linkedBinding`、`process.dlopen`。
- 禁止 `window`、`document`、`localStorage`、DOM、`XMLHttpRequest` 和 `WebSocket`。
- 异步操作必须显式 `await` 或返回 Promise，执行结束后不得留下后台任务；禁止无界循环、永不 settle 的 Promise、延迟、轮询和后台重试。

默认部署限制为：代码 65,535 字节、输入 2 MiB、结果 10 MiB、最小超时 100 ms、最大超时 15,000 ms；实际部署配置优先。

## 脚本重定向

只有脚本接口解析 `flow_redirect_url` 和 `flow_redirect_code`；即时非脚本接口把这两个字段作为普通结果。URL 必须是合法的单斜杠相对路径或 `http`/`https` 绝对 URL；状态码只能是 301、302、303、307、308。

## 回复和交付前检查

除非用户明确要求只返回代码：

1. 先说明模式及输出方式。
2. 输出完整、可直接执行的 `javascript` 代码块。
3. 脚本模式紧接着输出独立的 `script-interface-doc.v1` JSON 代码块；非脚本模式说明 `POST /flow/codeblock` 的调用字段和地址。
4. 简述参数、行为、响应和错误处理。
5. 检查输入来源、`return`/`qf_output` 二选一、异步生命周期、原生能力优先、禁止能力、可序列化结果和敏感信息。

非脚本模式使用 `flow_write_code` 或 `flow_execute_code` 返回的完整 `execution_url`。脚本创建、更新和执行使用 `flow_apply_script_change` 或 `flow_execute_script` 返回的完整 `script_url`；其他脚本管理工具无需主动告知调用地址。
