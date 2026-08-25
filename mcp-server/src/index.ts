#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codeWriterContext } from "./code-writer";
import { interfaceDocInputDescription } from "./interface-doc";
import { assertScriptChangeInput } from "./script-change";

const configuredBaseUrl = process.env.FLOW_CODEBLOCK_BASE_URL?.trim();
const accessToken = process.env.FLOW_CODEBLOCK_TOKEN?.trim();
const previewTtlMs = 10 * 60 * 1000;
const requestTimeoutMs = 30_000;
const openAiCompatibleEmailPattern =
  /^[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

function emailInput(description: string) {
  // Zod's default email regex uses lookahead, which OpenAI Responses tool schemas reject.
  return z.email({ pattern: openAiCompatibleEmailPattern }).describe(description);
}

if (!configuredBaseUrl) {
  throw new Error("FLOW_CODEBLOCK_BASE_URL is required; configure https://qingcode.oalite.com or an explicit local Flow Codeblock API URL");
}

let baseUrl: string;
try {
  const parsedBaseUrl = new URL(configuredBaseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  baseUrl = configuredBaseUrl.replace(/\/+$/, "");
} catch {
  throw new Error("FLOW_CODEBLOCK_BASE_URL must be a valid HTTP(S) URL");
}

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

async function assertUpdateTarget(scriptId: string, expectedVersion: number): Promise<void> {
  const response = await apiRequest(`/flow/scripts/${encodeURIComponent(scriptId)}`);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Flow-codeblock API returned an invalid script detail response");
  }
  const data = (response as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Flow-codeblock API returned an invalid script detail response");
  }
  const currentVersion = (data as Record<string, unknown>).current_version;
  if (typeof currentVersion !== "number" || !Number.isInteger(currentVersion) || currentVersion <= 0) {
    throw new Error("Flow-codeblock API returned an invalid current script version");
  }
  if (currentVersion !== expectedVersion) {
    throw new ApiError(409, {
      success: false,
      error: {
        type: "VersionConflictError",
        message: "脚本版本已变化，请重新读取脚本后再预览",
        details: {
          script_id: scriptId,
          expected_version: expectedVersion,
          current_version: currentVersion,
        },
      },
    });
  }
}

async function revalidatePreview(
  operation: "create" | "update",
  payload: Record<string, unknown>,
): Promise<unknown> {
  assertScriptChangeInput({ operation, ...payload });
  if (operation === "update") {
    await assertUpdateTarget(String(payload.script_id), Number(payload.expected_version));
  }
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

const serverInstructions = [
  "Flow Codeblock MCP 可独立使用，不依赖 Skill。写代码前先调用 flow_write_code 获取对应模式的完整代码与输入契约。",
  "非脚本模式：代码读取全局 input.<字段>；只写代码时不要执行，用户要求测试时调用 flow_execute_code。",
  "脚本模式：代码读取 input.query/input.header/input.body/input.cookies；调用方 POST 时直接发送业务 JSON，不包装 input 或 input.body。创建或修改代码时必须同时生成完整 interface_doc。",
  "任何脚本变更都先调用 flow_preview_script_change；只有向用户展示预览且获得明确确认后，才调用 flow_apply_script_change。不得把用户要求预览或修改视为发布确认。",
  "MCP 不提供删除工具。遇到删除请求必须拒绝调用其他工具替代删除，并告知用户通过 Flow Codeblock 网页或 REST DELETE /flow/scripts/{scriptId} 自行删除。",
  "读取当前版本后再更新；版本冲突、404、锁定、限流、配额或校验失败时根据错误处理，不要用反复试调用探测参数。",
].join("\n");

const server = new McpServer(
  { name: "flow-codeblock", version: "0.2.9" },
  { instructions: serverInstructions },
);

server.registerTool(
  "flow_write_code",
  {
    title: "获取 Flow JavaScript 编写契约",
    description: "写任何 Flow Codeblock JavaScript 时首先调用。根据 mode 返回 AGENT_PROMPT.md 权威规则原文及后续工具流程，大模型必须完整遵守后再依据 requirement 生成代码；规则由文件运行时直接读取，不维护第二份摘要。本工具本身不生成、保存或执行代码。用户未指定模式时选 non_script；要求创建/更新持久脚本或 HTTP 重定向时选 script。non_script 从全局 input.<业务字段> 取值；script 从 input.query/header/body/cookies 取值并独立输出完整 script-interface-doc.v1。完整接口文档 JSON Schema 体积较大，仅确实需要时设置 include_full_schema=true，此时同样直接读取权威 Schema 文件。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      mode: z.enum(["non_script", "script"]).describe(
        "生成模式。用户未说明时使用 non_script；non_script=即时执行且不保存。创建/更新持久脚本或要求 HTTP 重定向时必须使用 script，并生成独立接口文档。",
      ),
      requirement: z.string().min(1).max(20_000).describe(
        "用户的完整业务需求、输入字段、预期输出、外部接口及边界条件。script 模式还应包含用户提供的公网调用域名；缺少时先询问，不能用 API 服务地址猜测。不要在这里放 access token。",
      ),
      include_full_schema: z.boolean().optional().describe(
        "是否额外返回权威 script-interface-doc.schema.json 的完整对象。通常省略或 false 以节省 Token；需要逐字段构造复杂接口文档时设 true。",
      ),
    },
  },
  async ({ mode, requirement, include_full_schema }) => result(
    codeWriterContext(mode, requirement, include_full_schema ?? false),
  ),
);

server.registerTool(
  "flow_token_info",
  {
    title: "查询当前 Token 信息",
    description: "只读查询 MCP 环境变量 FLOW_CODEBLOCK_TOKEN 对应的状态、元数据、执行配额、过期时间和脚本额度。无需参数；不要让用户把 token 作为工具参数重复传入。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  },
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
    title: "查询脚本列表",
    description: "只读分页查询当前 token 名下的脚本，用于按名称/脚本 ID 定位目标并获取当前版本摘要。省略参数时使用服务端默认值；keyword 同时匹配描述和脚本 ID。需要代码、IP 白名单或准确 current_version 时继续调用 flow_get_script。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      page: z.number().int().positive().optional().describe("页码，从 1 开始；省略时为第 1 页。"),
      size: z.number().int().min(1).max(100).optional().describe("每页条数，1-100；省略时服务端默认 20。"),
      keyword: z.string().optional().describe("可选搜索词，同时模糊匹配脚本 description 和 script_id。"),
      sort: z.enum(["updated_at", "created_at", "executions"]).optional().describe(
        "排序字段：更新时间、创建时间或执行次数；省略时为 updated_at。",
      ),
      order: z.enum(["asc", "desc"]).optional().describe("排序方向；省略时为 desc。"),
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
    title: "读取脚本详情",
    description: "只读查询当前 token 名下一个脚本的当前或指定历史版本，包括代码、描述、IP 白名单、锁定状态、current_version 和可用版本。准备更新时必须先调用且省略 version，以其 current_version 作为预览的 expected_version；历史版本只读。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("目标脚本 ID；来自 flow_list_scripts、创建结果或用户明确提供的 ID。"),
      version: z.number().int().positive().optional().describe(
        "可选，默认省略。省略时查询脚本当前版本；仅在需要查看指定历史版本时传入对应版本号。准备更新时必须省略，并使用响应中的 current_version 作为 expected_version。",
      ),
    },
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
    title: "读取脚本接口文档",
    description: "只读查询脚本当前或指定历史版本的 script-interface-doc.v1。修改代码或文档前先读取当前文档，保留仍然有效的字段并与新代码同步；未保存文档时 document 可能为 null。历史文档只读。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("目标脚本 ID；来自脚本列表、创建结果或用户明确提供的 ID。"),
      version: z.number().int().positive().optional().describe("可选历史版本号；省略则读取当前版本文档。"),
    },
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
    title: "申请锁定或解锁验证码",
    description: "锁定/解锁两步流程的第 1 步：向脚本所有者邮箱发送一次性验证码。随后分别调用 flow_lock_script 或 flow_unlock_script，并使用完全相同的 script_id、action 对应操作和 email。已有所有者时邮箱必须匹配；首次锁定可认领尚无所有者的脚本。发送验证码会产生外部邮件副作用，须基于用户明确请求调用。",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      script_id: z.string().min(1).describe("要锁定或解锁的脚本 ID。"),
      action: z.enum(["lock", "unlock"]).describe("验证码用途；必须与下一步调用的 lock 或 unlock 工具一致。"),
      email: emailInput("接收验证码的所有者邮箱；下一步必须原样使用。"),
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
    title: "锁定脚本",
    description: "锁定流程第 2 步：使用 flow_request_script_owner_challenge(action=lock) 发到同一 email 的验证码锁定脚本并设置所有者姓名。锁定后代码、接口文档、描述和 IP 白名单均不可编辑，直到成功解锁；只在用户明确要求锁定并提供验证码后调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("申请 lock 验证码时使用的同一脚本 ID。"),
      email: emailInput("申请 lock 验证码时使用的同一邮箱。"),
      code: z.string().min(1).describe("邮箱收到的一次性 lock 验证码，不是 JavaScript 代码。"),
      owner_name: z.string().trim().min(1).max(100).describe("脚本所有者显示名称，去除首尾空白后 1-100 个字符。"),
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
    title: "解锁脚本",
    description: "解锁流程第 2 步：使用 flow_request_script_owner_challenge(action=unlock) 发到同一 email 的验证码解除锁定。解锁后可再次编辑，但所有者身份和姓名保留；只在用户明确要求解锁并提供验证码后调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("申请 unlock 验证码时使用的同一脚本 ID。"),
      email: emailInput("申请 unlock 验证码时使用的同一所有者邮箱。"),
      code: z.string().min(1).describe("邮箱收到的一次性 unlock 验证码。"),
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
    title: "发起脚本所有权转移",
    description: "所有权转移两步流程的第 1 步。校验 authorizer_email 是当前所有者邮箱或脚本创建 Token 的登记邮箱，然后仅向 new_owner_email 发送验证码并返回 transfer_id；不会向授权邮箱发送验证码。只在用户明确要求转移且已确认新所有者信息后调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      script_id: z.string().min(1).describe("要转移所有权的脚本 ID。"),
      authorizer_email: emailInput("当前所有者邮箱或创建该脚本的 Token 登记邮箱，仅用于授权校验。"),
      new_owner_email: emailInput("新所有者邮箱；验证码将发送到这里，确认步骤必须使用同一邮箱。"),
      new_owner_name: z.string().trim().min(1).max(100).describe("新所有者显示名称，去除首尾空白后 1-100 个字符。"),
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
    title: "确认脚本所有权转移",
    description: "所有权转移第 2 步：使用 flow_start_ownership_transfer 返回的 transfer_id，以及发到同一 new_owner_email 的验证码，原子完成所有者切换；脚本原有锁定状态保持不变。只在用户提供验证码并明确确认转移后调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("发起转移时使用的同一脚本 ID。"),
      transfer_id: z.string().min(1).describe("flow_start_ownership_transfer 成功响应返回的不透明 transfer_id。"),
      email: emailInput("发起转移时的 new_owner_email，必须完全相同。"),
      code: z.string().min(1).describe("新所有者邮箱收到的一次性转移验证码。"),
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
  operation: z.enum(["create", "update"]).describe(
    "create=创建新脚本；update=修改现有脚本。create 必须带 code/code_base64 和完整 interface_doc，且不得带 script_id/expected_version；update 必须带 script_id/expected_version。",
  ),
  script_id: z.string().min(1).optional().describe("仅 update 必填；目标脚本 ID。create 时必须省略。"),
  code: z.string().min(1).optional().describe(
    "UTF-8 JavaScript 源码，与 code_base64 二选一。脚本代码从 input.query/header/body/cookies 读取请求，并以顶层 return 返回可 JSON 序列化结果；更新代码时必须同时提交完整 interface_doc。",
  ),
  code_base64: z.string().min(1).optional().describe(
    "已 Base64 编码的 UTF-8 JavaScript，与 code 二选一；通常优先直接传 code。更新代码时必须同时提交完整 interface_doc。",
  ),
  description: z.string().optional().describe(
    "脚本列表展示名称/描述。创建时用户未指定则概括为 15 个字符以内；用户明确指定较长名称时不要擅自截断。单独修改 description 不生成新版本。",
  ),
  ip_whitelist: z.array(z.string()).nullable().optional().describe(
    "允许调用脚本的 IP/CIDR 列表。省略=保持原值（创建时使用服务端默认）；null 或 []=清除限制；非空数组=设置白名单。单独修改不生成新版本。",
  ),
  interface_doc: z.unknown().optional().describe(interfaceDocInputDescription),
  expected_version: z.number().int().positive().optional().describe(
    "仅 update 必填；必须取自刚刚 flow_get_script 返回的 current_version。版本变化会返回 409，此时重新读取并重新预览。create 时必须省略。",
  ),
};

server.registerTool(
  "flow_preview_script_change",
  {
    title: "预览并校验脚本变更",
    description: "任何脚本创建或更新的必经第 1 步，不写数据库、不扣执行配额，返回 10 分钟有效的 preview_id。若本轮还没有脚本代码与文档契约，先调用 flow_write_code(mode=script)，再一次性自检代码和完整 interface_doc，避免依靠重复预览逐项修错。create：必须带 code/code_base64 和 interface_doc，不带 script_id/expected_version；description 未指定时建议不超过 15 个字符。update：先 flow_get_script 读取当前版本，必须带 script_id、expected_version 和至少一个变更；代码变化必须同时带完整文档，文档或代码变化生成新版本，仅 description/IP 变化不生成版本；ip_whitelist=null 或 [] 表示清除。更新会先校验脚本存在且版本未变。预览成功后先向用户展示结果，不能自动发布。MCP 不支持删除。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: changeSchema,
  },
  async (input) => {
    try {
      purgePreviews();
      assertScriptChangeInput(input);
      if (input.operation === "update") {
        await assertUpdateTarget(input.script_id!, input.expected_version!);
      }
      const hasCode = input.code !== undefined || input.code_base64 !== undefined;
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
    title: "确认发布脚本变更",
    description: "脚本变更第 2 步：仅在 flow_preview_script_change 成功、已向用户展示预览且用户随后明确确认发布时调用。传同一 MCP 进程最近 10 分钟内返回的 preview_id 和字面量 confirm=true；会重新校验内容与 update 版本，过期、变化、404、锁定或 409 均拒绝，需重新读取并预览。成功后创建或原子更新脚本。创建成功后，最终地址必须写成用户提供的公网域名 + /flow/codeblock/{返回的脚本ID}；若用户未提供域名则先询问，不得使用 FLOW_CODEBLOCK_BASE_URL 猜测。本工具不能删除脚本，也不能把用户最初的创建/更新请求推定为发布确认。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      preview_id: z.string().uuid().describe("flow_preview_script_change 成功响应中的 preview_id；10 分钟有效且仅限当前 MCP 进程。"),
      confirm: z.literal(true).describe("必须为 true，并且只能在用户看过预览后明确确认发布时提交。"),
    },
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
    title: "执行已发布脚本",
    description: "按 GET/POST 调用已发布脚本进行真实测试或业务执行。调用前优先读取 flow_get_script_documentation，严格按文档传参。POST 的 body 就是调用方业务 JSON，不要包装为 {input:...} 或 {body:...}；平台运行时才把它构建到代码的 input.body。query/header 分别构建到 input.query/input.header。不得传 accessToken、Cookie、CSRF 或 MCP lane 标识，认证由环境变量自动注入。每次调用都会扣配额、限流、审计并进入 Web worker lane；只在用户要求执行/测试时调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      script_id: z.string().min(1).describe("要执行的已发布脚本 ID。"),
      method: z.enum(["GET", "POST"]).default("POST").describe("接口请求方法，必须符合该脚本接口文档；默认 POST。"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
        "调用方 URL 查询参数对象；值支持字符串/数字/布尔值。不得包含 qingcodeToken；超时请用 timeout_ms。",
      ),
      headers: z.record(z.string(), z.string()).optional().describe(
        "调用方业务请求头。不得包含 accessToken、Authorization、Cookie、CSRF 或 x-flow-* 内部头，这些会被过滤。",
      ),
      body: z.unknown().optional().describe(
        "仅 POST 使用的调用方业务 JSON，结构必须符合接口文档。直接传业务对象，不包装 input、input.body 或 body；GET 应省略。",
      ),
      timeout_ms: z.number().int().positive().optional().describe("可选脚本执行超时毫秒数，仍受服务端最小/最大限制。"),
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
    title: "执行非脚本 JavaScript",
    description: "真实执行一次不保存的非脚本 JavaScript。代码必须先按 flow_write_code(mode=non_script) 返回的契约生成：业务数据从全局 input.<字段> 读取，以顶层 return 返回可 JSON 序列化值；input 参数在此模式会原样成为全局 input。code 与 code_base64 必须且只能提供一个。调用会扣配额、限流、执行安全校验、审计并进入 Web worker lane；只写代码时不要调用，用户明确要求测试/执行时才调用。",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      code: z.string().min(1).optional().describe("UTF-8 JavaScript 源码，与 code_base64 二选一；通常优先直接传 code。"),
      code_base64: z.string().min(1).optional().describe("已 Base64 编码的 UTF-8 JavaScript，与 code 二选一。"),
      input: z.unknown().optional().describe("业务输入对象，会原样成为代码中的全局 input；省略时为 {}。不要包装成 {input: ...}。"),
      timeout_ms: z.number().int().positive().optional().describe("可选执行超时毫秒数，仍受服务端最小/最大限制。"),
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
    title: "查询脚本执行统计",
    description: "只读查询当前 token 名下一个脚本的执行统计。date 与 start_date/end_date 二选一：查询单日只传 date，查询范围同时传 start_date 和 end_date；全部省略时服务端返回最近 7 天。日期格式均为 YYYY-MM-DD。",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("要查询统计的脚本 ID。"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("单日统计日期，YYYY-MM-DD；使用时不得再传 start_date/end_date。"),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("范围开始日期，YYYY-MM-DD；必须与 end_date 同时提供。"),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("范围结束日期，YYYY-MM-DD；必须与 start_date 同时提供。"),
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
