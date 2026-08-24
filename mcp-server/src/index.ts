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

const server = new McpServer({ name: "flow-codeblock", version: "0.1.0" });

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
