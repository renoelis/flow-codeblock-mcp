import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.FLOW_CODEBLOCK_BASE_URL ?? "http://103.40.14.90:53002").replace(/\/+$/, "");
const accessToken = process.env.FLOW_CODEBLOCK_TOKEN?.trim();
const previewTtlMs = 10 * 60 * 1000;
const requestTimeoutMs = 30_000;

if (!accessToken) {
  throw new Error("FLOW_CODEBLOCK_TOKEN is required");
}

const previewStore = new Map<string, { expiresAt: number; fingerprint: string; operation: "create" | "update"; payload: Record<string, unknown> }>();

class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Flow-codeblock API returned HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: jsonText(value) }] };
}

const allowedModules = [
  "axios",
  "cheerio",
  "crypto-js",
  "csv-parser",
  "fast-xml-parser",
  "form-data",
  "lodash",
  "pinyin",
  "qs",
  "sm-crypto-v2",
  "uuid",
  "xlsx",
  "dayjs",
];

const codeRules = [
  "所有用户数据都从全局 input 读取；不要从环境变量、持久化全局变量或其他外部状态读取业务参数。",
  "默认使用顶层 return 返回普通值或 Promise；只有事件式/异步流程或用户明确要求时才使用严格裸赋值 qf_output。",
  "只使用服务端允许的模块；优先使用标准 JavaScript 和原生 fetch，不要静态/动态 import、export 或间接 require。",
  "禁止 eval、Function、Proxy、child_process、process.exit、spawn、exec、setImmediate、setInterval、setTimeout 等危险模式。",
  "禁止 window、document、localStorage、DOM、XMLHttpRequest、WebSocket，以及黑名单 Node 模块。",
  "不要把 Token、密码、Cookie、Authorization 值或验证码写入代码、接口文档和输出。",
  "代码、输入、结果和执行时间必须服从服务端限制；默认代码 65,535 字节、输入 2 MiB、结果 10 MiB、执行超时最大 15,000 ms，实际部署配置优先。",
];

const agentPromptRules = {
  source: "Flow-codeblock_rust/AGENT_PROMPT.md",
  runtime: [
    "服务端固定使用 Bun 1.4.0 Supervisor；每次执行使用 fresh Worker，不共享变量、模块状态或持久化全局状态。",
    "支持现代 JavaScript、async/await、Promise、箭头函数和顶层 return；不要生成 Rust、Bun Supervisor、HTTP 服务端或数据库代码。",
  ],
  input: {
    all_user_data_from: "global input",
    non_script: {
      endpoint: "POST /flow/codeblock",
      shape: "业务输入对象原样注入 input，缺省为 {}",
      example: { name: "Alice", items: [1, 2, 3] },
      code_access: "input.name、input.items",
    },
    script: {
      endpoint: "GET|POST /flow/codeblock/{scriptId}",
      shape: { query: {}, header: {}, body: {}, cookies: {} },
      code_access: "input.query、input.header、input.body、input.cookies",
      query: "查询参数；重复参数为字符串数组；qingcodeToken 和 qingcodeTimeout 不进入业务 query",
      header: "请求头；服务端过滤 x-original-cookie，需要时从 cookie 头读取",
      body: "POST JSON 请求体；空请求体为 {}",
      cookies: "Cookie 键值对象；无 Cookie 时可能不存在",
    },
  },
  output: {
    default: "顶层 return；返回值必须可 JSON 序列化",
    qf_output: "仅事件式/异步流程或用户明确要求时使用 qf_output = { ... }，不得与顶层 return 混用",
    recommended: ["{ success: true, data: value }", "{ success: false, error: message }"],
  },
  interface_document: "脚本模式必须单独输出并提交 script-interface-doc.v1 JSON，不能写成 JavaScript 注释",
  network: "优先使用原生 fetch，检查 HTTP 状态和 JSON/文本/空响应；所有异步请求必须 await 或 return",
  redirects: "仅脚本接口解析 flow_redirect_url 和 flow_redirect_code；即时非脚本接口把它们作为普通结果",
};

const interfaceDocSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://flow-codeblock.local/schemas/script-interface-doc.v1.json",
  title: "Flow Script Interface Document v1",
  type: "object",
  required: ["schema_version", "endpoint"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "script-interface-doc.v1" },
    title: { type: "string", maxLength: 200 },
    summary: { type: "string", maxLength: 2000 },
    endpoint: {
      type: "object",
      required: ["methods"],
      additionalProperties: false,
      properties: {
        methods: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["GET", "POST"] } },
        path: { type: "string", pattern: "^/flow/codeblock/" },
        description: { type: "string", maxLength: 4000 },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { "$ref": "#/$defs/parameters" },
        headers: { "$ref": "#/$defs/parameters" },
        body: { "$ref": "#/$defs/body" },
      },
    },
    responses: { type: "array", maxItems: 50, items: { "$ref": "#/$defs/response" } },
    logic_description: { type: "string", maxLength: 20_000 },
    usage_refs: { type: "array", maxItems: 100, items: { "$ref": "#/$defs/usage" } },
  },
  "$defs": {
    parameters: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: ["name", "required", "description"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          type: { enum: ["string", "integer", "number", "boolean", "array", "object"] },
          required: { type: "boolean" },
          description: { type: "string", minLength: 1, maxLength: 4000 },
          example: {},
          default: {},
          format: { type: "string", maxLength: 100 },
          enum_values: { type: "array", maxItems: 100 },
        },
      },
    },
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
    response: {
      type: "object",
      required: ["status", "description"],
      additionalProperties: false,
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        description: { type: "string", minLength: 1, maxLength: 4000 },
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
    usage: {
      type: "object",
      required: ["app_name"],
      additionalProperties: false,
      properties: {
        app_id: { type: "string", maxLength: 200 },
        app_name: { type: "string", minLength: 1, maxLength: 200 },
        location: { type: "string", maxLength: 500 },
        note: { type: "string", maxLength: 4000 },
      },
    },
  },
};

function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  inputExample: unknown,
): Record<string, unknown> {
  const directRequestBody = {
    codebase64: "<Base64 编码的 JavaScript>",
    input: inputExample ?? {},
    qingcodeTimeout: 3000,
  };
  const interfaceDocTemplate = {
    schema_version: "script-interface-doc.v1",
    title: "<接口标题>",
    summary: "<接口摘要>",
    endpoint: {
      methods: ["POST"],
      description: "<接口说明>",
    },
    request: {
      query: [],
      headers: [],
      body: {
        content_type: "application/json",
        schema: { type: "object" },
        example: inputExample ?? {},
      },
    },
    responses: [
      {
        status: 200,
        description: "成功",
        content_type: "application/json",
        schema: { type: "object" },
      },
    ],
    logic_description: "<处理逻辑>",
  };

  const common = {
    mode,
    requirement,
    side_effects: {
      database_write: false,
      code_execution: false,
    },
    code_rules: codeRules,
    allowed_modules: allowedModules,
    output_format: [
      "输出一个独立的 javascript 代码块。",
      "代码使用 input 和顶层 return。",
      "不要把接口契约写进 JSDoc 或块注释。",
    ],
    agent_prompt_rules: agentPromptRules,
  };

  if (mode === "non_script") {
    return {
      ...common,
      purpose: "生成可直接提交给非脚本执行接口的 JavaScript，并说明调用规则；不会创建脚本。",
      next_action: "将生成的 code 或 code_base64 与 input 交给 flow_execute_code，或按 direct_rest_request 调用 Rust API。",
      direct_rest_request: {
        method: "POST",
        path: "/flow/codeblock",
        headers: {
          "Content-Type": "application/json",
          accessToken: "<FLOW_CODEBLOCK_TOKEN>",
          "X-Flow-Execution-Origin": "mcp",
        },
        body: directRequestBody,
        notes: [
          "codebase64 是 JavaScript UTF-8 内容的 Base64，不是 code_base64。",
          "input 会作为代码中的 input 对象；缺省时使用 {}。",
          "qingcodeTimeout 单位为毫秒，服务端会校验最小和最大值。",
          "MCP Server 会自动补 accessToken 和 X-Flow-Execution-Origin，调用 flow_execute_code 时不要把它们放进 input。",
        ],
      },
      mcp_tool: {
        name: "flow_execute_code",
        input: {
          code: "<JavaScript> 或 code_base64",
          input: inputExample ?? {},
          timeout_ms: 3000,
        },
      },
      input_contract: agentPromptRules.input.non_script,
    };
  }

  return {
    ...common,
    purpose: "生成符合 Flow Codeblock 规则的脚本代码和独立接口文档，然后按预览、确认、创建、执行流程处理。",
    side_effects_after_confirmation: {
      database_write: true,
      code_execution: true,
    },
    workflow: [
      "生成 javascript 代码和独立的 script-interface-doc.v1 JSON。",
      "调用 flow_preview_script_change，创建时 operation=create，不要带 script_id。",
      "向用户展示校验结果、敏感字段警告、代码 hash、规范化文档和变更摘要。",
      "只有用户明确确认后，才调用 flow_apply_script_change，传 preview_id 和 confirm=true。",
      "创建成功后读取返回的 script_id 和 version，再调用 flow_execute_script 做一次测试执行。",
      "执行完成后报告响应和配额结果；需要时调用 flow_script_stats。",
    ],
    script_request_body: {
      code_base64: "<Base64 编码的 JavaScript>",
      description: "<脚本描述>",
      ip_whitelist: "省略表示保持原值；null 表示清除白名单；数组表示设置白名单",
      interface_doc: interfaceDocTemplate,
    },
    interface_doc_template: interfaceDocTemplate,
    interface_doc_schema: interfaceDocSchema,
    interface_doc_rules: [
      "必须是一个独立 JSON 对象，不得写入 JavaScript 注释、Markdown 说明、注释或尾随逗号。",
      "必须包含 schema_version=script-interface-doc.v1 和 endpoint.methods。",
      "endpoint.methods 只能使用 GET、POST；path 可省略，更新时使用实际 /flow/codeblock/{script_id}。",
      "request.query、request.headers、request.body 必须与代码实际读取的 input.query、input.header、input.body 一致。",
      "脚本输入的 Cookie 通过 input.cookies 读取；文档中只能写字段名、类型、示例和脱敏占位符。",
      "responses.status 必须为 100-599；响应 Schema 和 example 必须与代码返回值一致。",
      "interface_doc 先提交给 flow_preview_script_change，校验通过且用户确认后才能发布。",
    ],
    input_contract: agentPromptRules.input.script,
    mcp_tools: [
      "flow_preview_script_change",
      "flow_apply_script_change",
      "flow_execute_script",
      "flow_script_stats",
    ],
  };
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    if ([
      "accesstoken",
      "access-token",
      "authorization",
      "cookie",
      "x-csrf-token",
      "x-flow-execution-origin",
      "x-flow-test-tool",
    ].includes(normalized)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

async function apiRequest(path: string, init: RequestInit = {}, execution = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("accessToken", accessToken!);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (execution) headers.set("X-Flow-Execution-Origin", "mcp");
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function apiError(error: unknown): never {
  if (error instanceof ApiError) {
    throw new Error(jsonText({ status: error.status, error: error.payload }));
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new Error("Flow-codeblock API request timed out");
  }
  throw error;
}

function encodeCode(code: string | undefined, codeBase64: string | undefined): string {
  if ((code === undefined) === (codeBase64 === undefined)) {
    throw new Error("Provide exactly one of code or code_base64");
  }
  return codeBase64 ?? Buffer.from(code!, "utf8").toString("base64");
}

function removeCreatePath(document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const copy = structuredClone(document) as Record<string, unknown>;
  const endpoint = copy.endpoint;
  if (endpoint && typeof endpoint === "object" && !Array.isArray(endpoint)) {
    delete (endpoint as Record<string, unknown>).path;
  }
  return copy;
}

function fingerprint(operation: "create" | "update", payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ operation, payload })).digest("hex");
}

function purgePreviews(): void {
  const now = Date.now();
  for (const [id, preview] of previewStore) {
    if (preview.expiresAt <= now) previewStore.delete(id);
  }
}

async function revalidatePreview(
  operation: "create" | "update",
  payload: Record<string, unknown>,
): Promise<unknown> {
  const hasCode = typeof payload.code_base64 === "string";
  const hasDocument = payload.interface_doc !== undefined && payload.interface_doc !== null;
  const hasWhitelist = payload.ip_whitelist !== undefined;
  if (!hasCode && !hasDocument && !hasWhitelist) return { valid: true, warnings: [] };
  return apiRequest("/flow/scripts/validate", {
    method: "POST",
    body: JSON.stringify({
      ...(hasCode ? { code_base64: payload.code_base64 } : {}),
      ...(operation === "update" ? { script_id: payload.script_id } : {}),
      ...(payload.ip_whitelist !== undefined ? { ip_whitelist: payload.ip_whitelist } : {}),
      ...(hasDocument ? { interface_doc: payload.interface_doc } : {}),
    }),
  });
}

const server = new McpServer({ name: "flow-codeblock", version: "0.2.0" });

server.registerTool(
  "flow_write_code",
  {
    description: "专门处理 Flow Codeblock 写代码请求。选择非脚本或脚本模式，返回代码约束、请求体模板和下一步工具链；本工具不写数据库、不执行代码。",
    inputSchema: {
      mode: z.enum(["non_script", "script"]),
      requirement: z.string().min(1).max(20_000),
      input_example: z.unknown().optional(),
    },
  },
  async ({ mode, requirement, input_example }) => result(codeWriterContext(mode, requirement, input_example)),
);

server.registerTool(
  "flow_token_info",
  { description: "查询当前 FLOW_CODEBLOCK_TOKEN 的状态、Token 元数据、配额、过期时间和脚本额度。", inputSchema: {} },
  async () => {
    try {
      const payload = await apiRequest("/flow/token/self");
      return result(payload);
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_list_scripts",
  {
    description: "分页查询当前 token 名下的脚本。",
    inputSchema: {
      page: z.number().int().positive().optional(),
      size: z.number().int().min(1).max(100).optional(),
      keyword: z.string().optional(),
      sort: z.enum(["updated_at", "created_at", "executions"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
  },
  async ({ page, size, keyword, sort, order }) => {
    try {
      const query = new URLSearchParams();
      if (page !== undefined) query.set("page", String(page));
      if (size !== undefined) query.set("size", String(size));
      if (keyword !== undefined) query.set("keyword", keyword);
      if (sort !== undefined) query.set("sort", sort);
      if (order !== undefined) query.set("order", order);
      const payload = await apiRequest(`/flow/scripts${query.size ? `?${query}` : ""}`);
      return result(payload);
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script",
  {
    description: "查询当前 token 名下脚本的当前或历史版本。",
    inputSchema: { script_id: z.string().min(1), version: z.number().int().positive().optional() },
  },
  async ({ script_id, version }) => {
    try {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}${query}`));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script_documentation",
  {
    description: "查询当前或历史脚本接口文档。",
    inputSchema: { script_id: z.string().min(1), version: z.number().int().positive().optional() },
  },
  async ({ script_id, version }) => {
    try {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/documentation${query}`));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_request_script_owner_challenge",
  {
    description: "申请脚本锁定或解锁验证码。验证码发送到指定邮箱，后续动作必须继续使用相同邮箱。",
    inputSchema: {
      script_id: z.string().min(1),
      action: z.enum(["lock", "unlock"]),
      email: z.string().min(1),
    },
  },
  async ({ script_id, action, email }) => {
    try {
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/owner-challenge`, {
        method: "POST",
        body: JSON.stringify({ action, email }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_lock_script",
  {
    description: "使用锁定验证码锁定脚本并设置所有者。锁定后代码、接口文档、描述和 IP 白名单均不可编辑。",
    inputSchema: {
      script_id: z.string().min(1),
      email: z.string().min(1),
      code: z.string().min(1),
      owner_name: z.string().min(1),
    },
  },
  async ({ script_id, email, code, owner_name }) => {
    try {
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/lock`, {
        method: "POST",
        body: JSON.stringify({ email, code, owner_name }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_unlock_script",
  {
    description: "使用所有者解锁验证码解除脚本锁定，保留脚本所有者信息。",
    inputSchema: {
      script_id: z.string().min(1),
      email: z.string().min(1),
      code: z.string().min(1),
    },
  },
  async ({ script_id, email, code }) => {
    try {
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/unlock`, {
        method: "POST",
        body: JSON.stringify({ email, code }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_start_ownership_transfer",
  {
    description: "发起脚本所有权转移。authorizer_email 必须是当前所有者邮箱或脚本 Token 登记邮箱，验证码发送给新所有者。",
    inputSchema: {
      script_id: z.string().min(1),
      authorizer_email: z.string().min(1),
      new_owner_email: z.string().min(1),
      new_owner_name: z.string().min(1),
    },
  },
  async ({ script_id, authorizer_email, new_owner_email, new_owner_name }) => {
    try {
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/ownership-transfers`, {
        method: "POST",
        body: JSON.stringify({ authorizer_email, new_owner_email, new_owner_name }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_confirm_ownership_transfer",
  {
    description: "使用新所有者邮箱收到的验证码完成脚本所有权转移。",
    inputSchema: {
      script_id: z.string().min(1),
      transfer_id: z.string().min(1),
      email: z.string().min(1),
      code: z.string().min(1),
    },
  },
  async ({ script_id, transfer_id, email, code }) => {
    try {
      return result(await apiRequest(
        `/flow/scripts/${encodeURIComponent(script_id)}/ownership-transfers/${encodeURIComponent(transfer_id)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ email, code }),
        },
      ));
    } catch (error) {
      return apiError(error);
    }
  },
);

const changeSchema = {
  operation: z.enum(["create", "update"]),
  script_id: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  code_base64: z.string().min(1).optional(),
  description: z.string().optional(),
  ip_whitelist: z.array(z.string()).nullable().optional(),
  interface_doc: z.unknown().optional(),
  expected_version: z.number().int().positive().optional(),
};

server.registerTool(
  "flow_preview_script_change",
  {
    description: "预览并校验脚本创建或更新。此工具不会写数据库，发布必须再调用 flow_apply_script_change 并显式确认。",
    inputSchema: changeSchema,
  },
  async (input) => {
    try {
      purgePreviews();
      if (input.operation === "update" && (!input.script_id || input.expected_version === undefined)) {
        throw new Error("Update preview requires script_id and expected_version");
      }
      if (input.operation === "create" && input.script_id !== undefined) {
        throw new Error("Create preview must not include script_id");
      }
      const hasCode = input.code !== undefined || input.code_base64 !== undefined;
      if (input.operation === "create" && !hasCode) {
        throw new Error("Create preview requires code or code_base64");
      }
      if (
        input.operation === "update" &&
        !hasCode &&
        input.description === undefined &&
        input.ip_whitelist === undefined &&
        input.interface_doc === undefined
      ) {
        throw new Error("Update preview must include code, description, ip_whitelist, or interface_doc");
      }
      const codeBase64 = hasCode ? encodeCode(input.code, input.code_base64) : undefined;
      const validation = hasCode || input.interface_doc !== undefined || input.ip_whitelist !== undefined
        ? await apiRequest("/flow/scripts/validate", {
            method: "POST",
            body: JSON.stringify({
              ...(codeBase64 !== undefined ? { code_base64: codeBase64 } : {}),
              ...(input.operation === "update" ? { script_id: input.script_id } : {}),
              ...(input.ip_whitelist !== undefined ? { ip_whitelist: input.ip_whitelist } : {}),
              ...(input.interface_doc !== undefined ? { interface_doc: input.interface_doc } : {}),
            }),
          })
        : { valid: true, warnings: [], message: "未提交代码或接口文档，仅更新描述/IP 白名单" };
      const payload: Record<string, unknown> = {
        ...(input.operation === "update" ? { script_id: input.script_id, expected_version: input.expected_version } : {}),
        ...(codeBase64 !== undefined ? { code_base64: codeBase64 } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.ip_whitelist !== undefined ? { ip_whitelist: input.ip_whitelist } : {}),
        ...(input.interface_doc !== undefined ? { interface_doc: input.interface_doc } : {}),
      };
      const previewId = randomUUID();
      const storedPayload = input.operation === "create" && input.interface_doc !== undefined
        ? { ...payload, interface_doc: removeCreatePath(input.interface_doc) }
        : payload;
      const preview = {
        preview_id: previewId,
        operation: input.operation,
        expires_at: new Date(Date.now() + previewTtlMs).toISOString(),
        validation,
        changes: {
          code: codeBase64 === undefined ? false : input.code !== undefined ? "provided" : "base64 provided",
          description: input.description !== undefined,
          ip_whitelist: input.ip_whitelist !== undefined,
          interface_doc: input.interface_doc !== undefined,
        },
      };
      previewStore.set(previewId, {
        expiresAt: Date.now() + previewTtlMs,
        fingerprint: fingerprint(input.operation, storedPayload),
        operation: input.operation,
        payload: storedPayload,
      });
      return result(preview);
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_apply_script_change",
  {
    description: "应用已预览的脚本变更。必须提供 preview_id 和 confirm=true；此工具不支持删除脚本。",
    inputSchema: { preview_id: z.string().uuid(), confirm: z.literal(true) },
  },
  async ({ preview_id }) => {
    try {
      purgePreviews();
      const preview = previewStore.get(preview_id);
      if (!preview) throw new Error("Preview is missing or expired");
      const currentFingerprint = fingerprint(preview.operation, preview.payload);
      if (currentFingerprint !== preview.fingerprint) throw new Error("Preview contents changed");
      await revalidatePreview(preview.operation, preview.payload);
      const path = preview.operation === "create"
        ? "/flow/scripts"
        : `/flow/scripts/${encodeURIComponent(String(preview.payload.script_id))}`;
      const body = { ...preview.payload };
      delete body.script_id;
      delete body.expected_version;
      const response = await apiRequest(path, {
        method: preview.operation === "create" ? "POST" : "PUT",
        body: JSON.stringify(preview.operation === "update"
          ? { ...body, expected_version: preview.payload.expected_version }
          : body),
      });
      previewStore.delete(preview_id);
      return result(response);
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_execute_script",
  {
    description: "执行当前脚本。该操作会进行正常配额扣减、限流和审计，并使用网页专用 Web worker 池。",
    inputSchema: {
      script_id: z.string().min(1),
      method: z.enum(["GET", "POST"]).default("POST"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
  },
  async ({ script_id, method, query, headers, body, timeout_ms }) => {
    try {
      const url = new URL(`${baseUrl}/flow/codeblock/${encodeURIComponent(script_id)}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (key.toLowerCase() === "qingcodetoken") {
          throw new Error("qingcodeToken is not accepted by the MCP execution tool; configure FLOW_CODEBLOCK_TOKEN");
        }
        if (key.toLowerCase() === "qingcodetimeout") {
          throw new Error("Use timeout_ms instead of qingcodeTimeout");
        }
        url.searchParams.set(key, String(value));
      }
      if (timeout_ms !== undefined) url.searchParams.set("qingcodeTimeout", String(timeout_ms));
      const safeHeaders = cleanHeaders(headers);
      const response = await apiRequest(url.pathname + url.search, {
        method,
        headers: safeHeaders,
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
      }, true);
      return result({ quota_notice: "本次执行已按普通执行请求处理并扣减配额。", response });
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_execute_code",
  {
    description: "执行非脚本 JavaScript。调用 POST /flow/codeblock，使用 MCP 标识进入 Web worker lane，并执行正常认证、配额、限流、危险模式、模块白名单、审计和统计。",
    inputSchema: {
      code: z.string().min(1).optional(),
      code_base64: z.string().min(1).optional(),
      input: z.unknown().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
  },
  async ({ code, code_base64, input: executionInput, timeout_ms }) => {
    try {
      const payload = {
        codebase64: encodeCode(code, code_base64),
        input: executionInput ?? {},
        ...(timeout_ms === undefined ? {} : { qingcodeTimeout: timeout_ms }),
      };
      const response = await apiRequest("/flow/codeblock", {
        method: "POST",
        body: JSON.stringify(payload),
      }, true);
      return result({
        mode: "non_script",
        quota_notice: "本次非脚本执行已按普通执行请求处理并扣减配额。",
        response,
      });
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_script_stats",
  {
    description: "查询当前 token 名下脚本的执行统计。",
    inputSchema: {
      script_id: z.string().min(1),
      date: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
    },
  },
  async ({ script_id, date, start_date, end_date }) => {
    try {
      const query = new URLSearchParams();
      if (date !== undefined) query.set("date", date);
      if (start_date !== undefined) query.set("start_date", start_date);
      if (end_date !== undefined) query.set("end_date", end_date);
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/stats${query.size ? `?${query}` : ""}`));
    } catch (error) {
      return apiError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
