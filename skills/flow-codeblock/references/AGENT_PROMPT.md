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

## 输入契约

所有用户数据都从全局 `input` 读取，不从环境变量、持久化全局变量或其他外部状态读取。

### 非脚本模式

接口为 `POST /flow/codeblock`。请求体中的 `input` 原样注入全局 `input`，缺省为 `{}`。因此非脚本模式的 `input` 是业务参数对象本身：

```javascript
const name = input.name;
const items = Array.isArray(input.items) ? input.items : [];
```

平台请求体：

```json
{
  "codebase64": "<Base64 编码的 JavaScript>",
  "input": {"name": "Alice", "items": [1, 2, 3]},
  "qingcodeTimeout": 3000
}
```

`codebase64` 是执行接口字段名；脚本管理工具中的字段名是 `code_base64`。

### 脚本模式

接口为 `GET|POST /flow/codeblock/{scriptId}`。脚本模式的全局 `input` 是 HTTP 输入信封，不是业务对象本身：

```javascript
{
  query: {},
  header: {},
  body: {},
  cookies: {}
}
```

- `input.query`：查询参数，不含 `qingcodeToken` 和 `qingcodeTimeout`；单值为字符串，重复参数为字符串数组。
- `input.header`：请求头；服务端过滤 `x-original-cookie`，需要时从 `cookie` 头读取。
- `input.body`：POST JSON 请求体；空请求体为 `{}`。
- `input.cookies`：Cookie 键值对象；无 Cookie 时可能不存在。

示例：

```javascript
const userId = input.query?.userId;
const authorization = input.header?.authorization;
const payload = input.body ?? {};
const sessionId = input.cookies?.session_id;
```

脚本模式下 `qingcodeToken` 仅用于认证，`qingcodeTimeout` 仅用于配置超时，不会进入业务 query 或 body。

## 输出契约

默认且通常唯一的输出方式是顶层 `return`，可返回普通值或 Promise。返回值必须可 JSON 序列化，不能包含循环引用、BigInt、函数、Symbol、未处理的复杂类实例或无界数组/字符串。

只有事件式/异步流程或用户明确要求时才使用 `qf_output`：必须是裸赋值 `qf_output = { ... }`，不得与顶层 `return` 混用，也不得声明、解构、间接引用或遮蔽 `qf_output`。

推荐业务结构：`{ success: true, data: value }` 或 `{ success: false, error: message }`。它是业务结果，不替代平台外层响应。

## 脚本接口文档

脚本模式必须把接口契约作为独立 JSON 对象输出，并通过 `interface_doc` 提交。不得使用 JavaScript 注释承载方法、路径、参数、响应、认证或接口说明。JSON 必须符合 `script-interface-doc.v1`，完整约束见 `script-interface-doc.schema.json`。

- 必须包含 `schema_version` 和 `endpoint.methods`。
- `endpoint.methods` 只能是 `GET`、`POST`；创建时 `endpoint.path` 可省略，更新时使用实际 `/flow/codeblock/{script_id}`。
- `request.query`、`request.headers`、`request.body` 必须与代码实际读取的 `input.query`、`input.header`、`input.body` 一致。
- `responses` 的状态码、Schema 和示例必须与代码实际返回值一致。
- JSON 代码块只能包含合法 JSON 对象，不得混入 Markdown、注释或尾随逗号。
- 文档、示例、代码和工具参数中不得出现真实 Token、密码、Cookie、Authorization 值或验证码。

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
3. 脚本模式紧接着输出独立的 `script-interface-doc.v1` JSON 代码块；非脚本模式输出 `POST /flow/codeblock` 请求示例。
4. 简述参数、行为、响应和错误处理。
5. 检查输入来源、`return`/`qf_output` 二选一、异步生命周期、原生能力优先、禁止能力、可序列化结果和敏感信息。
