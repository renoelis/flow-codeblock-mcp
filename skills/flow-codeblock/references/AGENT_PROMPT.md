# Flow Codeblock JavaScript Authoring Rules

This file is the authoritative code-generation and tool-flow contract for the Flow Codeblock Rust + Bun execution service. Follow it together with `script-interface-doc.schema.json`; the deployed service remains the final validator.

## Role and runtime

- Generate directly executable JavaScript only. Do not generate Rust, Bun Supervisor, HTTP server, database, or browser-page code.
- User JavaScript runs in a fresh server-side Bun 1.4.1 Supervisor worker. Workers do not share variables, module state, or persistent global state.
- Modern JavaScript, `async/await`, Promises, arrow functions, and top-level `return` are supported.
- Prefer standard JavaScript and native `fetch`. Use allowlisted modules only when native capabilities are insufficient.
- For date and time work, first choose among Bun 1.4.1's native `Date`, `Intl.DateTimeFormat`/`Intl.RelativeTimeFormat`, and `Temporal` APIs such as `PlainDate`, `PlainDateTime`, `ZonedDateTime`, and `Instant`. Use `dayjs` only for complex compatibility parsing, required plugin or chaining semantics, or when the user explicitly requests it. Do not default to `dayjs` for standard arithmetic, comparisons, ISO serialization, locale or time-zone formatting, or relative time.

## Before generating code

1. Default to non-script immediate execution and top-level `return` when the user does not specify a mode.
2. HTTP redirects require script mode at `/flow/codeblock/{scriptId}`.
3. Determine the mode, inputs, sync/async flow, output, and error behavior before writing code. Do not add unrelated requests, modules, timers, or abstractions.
4. Script `description` is the list display name. Summarize to at most 15 characters only when the user did not provide a name; preserve an explicitly supplied longer name.

## Input contract

All user data comes from global `input`, never from environment variables, persistent globals, or other external state. In user code `process` is `undefined`; never read `process.env` or assume business environment variables are provisioned. Third-party API keys must arrive from the caller through a request body, query parameter, or business request header and must be declared in the interface document. Never place real secrets in code, examples, or prose. `FLOW_CODEBLOCK_TOKEN` is used only by the MCP server for platform authentication.

### Non-script mode

The endpoint is `POST /flow/codeblock`. The request body's `input` value becomes global `input` unchanged and defaults to `{}`. Read business fields as `input.<field>`. The execution field is named `codebase64`.

### Script mode

The endpoint is `GET|POST /flow/codeblock/{scriptId}`. The server builds global `input` as an HTTP envelope with `query`, `header`, `body`, and `cookies`.

- `input.query` contains URL query parameters except `qingcodeToken` and `qingcodeTimeout`; repeated values are arrays.
- `input.header` contains request headers after `x-original-cookie` filtering; read the `cookie` header when needed.
- `input.body` is the parsed POST JSON body and is `{}` for an empty body.
- `input.cookies` is a cookie-name/value object and may be absent.
- `qingcodeToken` is authentication-only and `qingcodeTimeout` is timeout-only; neither enters business query or body data.

## Output contract

Use top-level `return` by default. Returned values must be JSON-serializable and must not contain cycles, BigInt, functions, Symbols, unhandled complex class instances, or unbounded arrays/strings. Use `qf_output = { ... }` only for event-style/asynchronous flows or when explicitly requested; it must be a bare assignment and must not be mixed with top-level `return`.

Recommended business results are `{ success: true, data: value }` or `{ success: false, error: message }`; these do not replace the platform response envelope.

## Script interface documents

Script mode must create an independent `script-interface-doc.v1` JSON object and submit it through `interface_doc` for creates and interface-contract changes. Code-only updates may omit both documentation fields and preserve the current document; existing-document field-only updates may use RFC 6902 `interface_doc_patch` containing only changed JSON Pointer operations. Do not echo code or the submitted document in the final user response unless explicitly requested.

The JSON must match `script-interface-doc.schema.json`. The document root contains only `schema_version`, `title`, `summary`, `endpoint`, `request`, `responses`, `logic_description`, and `usage_refs`. `request` contains only `query`, `headers`, and `body`; `ip_whitelist` is a tool argument, not a document field. Use caller-facing URL query parameters, HTTP headers, HTTP body, and Cookies in prose.

Before previewing, perform one complete recursive self-check:

- Required root fields are `schema_version`, `title`, `summary`, `endpoint`, `responses`, and `logic_description` whenever `interface_doc` is submitted; `request` and `usage_refs` are optional when not applicable.
- Each `usage_refs` entry is `{app_name, app_id?, location?, note?}`; every provided value is a string, including `app_id` (write numeric-looking IDs such as `"98701"`, never `98701`).
- `endpoint` requires `methods` and `description`; methods are only `GET` and `POST`. Create may omit `endpoint.path`; update must use the actual `/flow/codeblock/{script_id}` path.
- Every parameter requires `name`, `type`, `required`, `description`, and `example`. A POST body and every response require `content_type`, `schema`, and `example`.
- Every Schema node requires `type`, `description`, and `example` except the root node's description metadata when the runtime validator allows it. Every array requires a complete `items` node. Known object keys use `properties`; homogeneous runtime-key dictionaries use object-form `additionalProperties`; opaque pass-through upstream objects may use `additionalProperties: true`.
- Examples must match declared types, declare every field through `properties` or `additionalProperties`, and include all fields listed in `required`. Do not use an empty object Schema as an arbitrary-value fallback.
- Keep successful and error shapes in separate responses, including different shapes with the same status code.

Do not rely on repeated preview calls to discover missing fields. If normalization occurs and `flow_preview_script_change` returns `preview_id`, `preview_ready=true`, and `requires_repreview=false`, the normalized document is already stored; show the normalization and wait for confirmation. Do not rewrite or preview again. If a patch fails, repair only the reported operation and JSON Pointer; a failed `test` requires rereading the current document and version. Never include sensitive patch values in error prose.

## Script change workflow

1. For create, generate code and a complete document. For update, first call `flow_get_script` with only `script_id`; use the returned `current_version` as `expected_version`. Read `flow_get_script_documentation` when changing or confirming the contract. Code-only updates may omit both documentation fields and preserve the current document. Use a patch for field-only documentation changes.
2. Call `flow_preview_script_change` once the submitted code/document fields have passed the recursive self-check. Explicitly set `operation` when possible. Create has no `script_id` or `expected_version`; update has both and at least one change. `interface_doc` and `interface_doc_patch` are mutually exclusive, and both may be omitted for code-only updates.
3. Display the successful preview and wait for explicit user confirmation.
4. Call `flow_apply_script_change` with the same `preview_id` and `confirm=true`. After create, call `flow_execute_script` only when execution was requested.

The MCP compatibility layer may infer a missing operation from `script_id` and ignore `expected_version=0` on create. These normalizations do not require a second preview. MCP builds complete `execution_url` and `script_url` values from `FLOW_CODEBLOCK_BASE_URL`; use the returned `data.script_url` or `script_url` and never ask for a domain.

## Modules and safety

- Prefer native `URL`, `URLSearchParams`, Promises, and `fetch`.
- npm packages remain limited to the versions and names listed in `modules.json`, with the allowed literal `require` forms. Node built-ins (bare names and `node:*`, such as `fs` and `node:fs`) and Bun `bun:*` modules are available unless the service startup blacklist rejects them.
- The service loads `config/module_blacklist.json` at startup. The MCP package includes the default snapshot at `references/module_blacklist.json`; use it when writing code, but treat the running service's snapshot as authoritative if deployment configuration differs. `forbidden_modules` controls module access: Node built-ins are allowed unless listed, `fs` rejects both `fs` and `node:fs` under the service's normalization rules, `bun` rejects the complete `Bun` global and every `bun:*` module, and `bun:sqlite` rejects only that module. `forbidden_bun_apis` controls individual global members such as `Bun.file` and `Bun.spawn`; only listed members are omitted, while all other native Bun members remain available. Removing an entry and restarting restores that capability. `globalThis` remains the isolated execution object.
- Do not use dynamic `import`, ESM `import/export`, indirect `require`, `module`, `exports`, browser APIs, or any dangerous pattern listed in `dangerous_patterns.json`.
- The module and Bun API blacklists are deployment capability switches, not a sandbox. The default deployment config blocks high-risk Bun file, process, database, Redis, FFI, DNS, listener, socket, build, plugin, module-resolution, and environment APIs through `forbidden_bun_apis` and `forbidden_modules`; removing an entry authorizes that capability. The separate dangerous-pattern policy still applies.
- Treat every key under `dangerous_patterns.json` `identifiers` as forbidden even when it is a safe-looking property or method name. For example, use `String(value).match(pattern)` instead of `pattern.exec(String(value))`. Before returning code, check the complete source against every listed identifier and member.
- Do not use `eval`, `Function`, `Proxy`, `__proto__`, child-process APIs, timers, polling, background retries, unbounded loops, or unsettled Promises.
- Default limits are 65,535 code bytes, 2 MiB input, 10 MiB result, 100 ms minimum timeout, and 15,000 ms maximum timeout; deployed configuration wins.

## Redirects and delivery

Only script interfaces interpret `flow_redirect_url` and `flow_redirect_code`; non-script results treat them as ordinary data. Redirect URLs must be a valid single-slash relative path or an `http`/`https` URL. Codes are limited to 301, 302, 303, 307, and 308.

- Non-script delivery, including every initial generation, fix, or later update, includes the complete latest JavaScript source produced in the current turn, caller-facing invocation instructions, parameters/examples, logic, success/error examples, and the complete `execution_url`. Never return only a patch, changed fragment, explanation, or execution result.
- Script delivery includes caller-facing invocation instructions, parameters/examples, logic, success/error examples, and the published `script_url`; do not echo code or raw `interface_doc` unless requested.

MCP has no script deletion tool. Do not substitute another tool for deletion; direct the user to the Flow Codeblock web UI or REST API. Deletion requires an unlocked script with released ownership. Ownership lock, unlock, release, and transfer use their dedicated verification-code flows; never guess, store, or reuse codes.
