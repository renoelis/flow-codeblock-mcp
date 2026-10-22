import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ApiRequest = {
  body: unknown;
  executionOrigin: string | null;
  method: string;
  target: string;
};

const apiRequests: ApiRequest[] = [];
let apiResponse: () => Response = () => Response.json({ success: true, result: { ok: true } });
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const bodyText = await request.text();
    apiRequests.push({
      body: bodyText ? JSON.parse(bodyText) : null,
      executionOrigin: request.headers.get("x-flow-execution-origin"),
      method: request.method,
      target: `${url.pathname}${url.search}`,
    });
    return apiResponse();
  },
});

const client = new Client({ name: "flow-codeblock-execution-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_execution_test",
  },
  stderr: "pipe",
});

beforeAll(async () => {
  await client.connect(transport);
});

beforeEach(() => {
  apiRequests.length = 0;
  apiResponse = () => Response.json({ success: true, result: { ok: true } });
});

afterAll(async () => {
  await client.close();
  await apiServer.stop(true);
});

describe("execution tool call URLs", () => {
  test("returns the non-script execution URL", async () => {
    const response = await client.callTool({
      name: "flow_execute_code",
      arguments: {
        code: "return { value: input.value };",
        input: { value: 7 },
      },
    });

    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].type === "text" ? response.content[0].text : "{}");
    expect(payload.execution_url).toBe(`${apiServer.url.origin}/flow/codeblock`);
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]).toMatchObject({
      executionOrigin: "mcp",
      method: "POST",
      target: "/flow/codeblock",
    });
  });

  test("returns the encoded script execution URL", async () => {
    const response = await client.callTool({
      name: "flow_execute_script",
      arguments: {
        script_id: "script with space",
        method: "POST",
        query: { source: "mcp" },
        body: { value: 7 },
      },
    });

    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].type === "text" ? response.content[0].text : "{}");
    expect(payload.script_url).toBe(`${apiServer.url.origin}/flow/codeblock/script%20with%20space`);
    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0]).toMatchObject({
      body: { value: 7 },
      executionOrigin: "mcp",
      method: "POST",
      target: "/flow/codeblock/script%20with%20space?source=mcp",
    });
  });

  test("rejects process.env without calling the execution API", async () => {
    const response = await client.callTool({
      name: "flow_execute_code",
      arguments: {
        code_base64: Buffer.from("return process?.[\"env\"]?.BAIDU_MAP_AK;", "utf8").toString("base64"),
        input: {},
      },
    });

    expect(response.isError).toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("execution error did not return text");
    expect(content.text).toContain("third-party API keys must be supplied by the caller");
    expect(apiRequests).toHaveLength(0);
  });

  test("passes a later quota-exhausted 429 through both execution tools", async () => {
    apiResponse = () => Response.json({
      success: false,
      error: {
        type: "QuotaExceededError",
        message: "配额已用尽",
        details: { remaining: 0, quota_type: "count" },
      },
    }, { status: 429 });

    for (const [name, arguments_] of [
      ["flow_execute_code", { code: "return 1;", input: {} }],
      ["flow_execute_script", { script_id: "quota-exhausted-script", method: "POST", body: {} }],
    ] as const) {
      const response = await client.callTool({ name, arguments: arguments_ });
      expect(response.isError).toBe(true);
      const content = response.content.find((item) => item.type === "text");
      if (!content || content.type !== "text") throw new Error(`${name} did not return error text`);
      expect(content.text).toContain('"status": 429');
      expect(content.text).toContain('"type": "QuotaExceededError"');
      expect(content.text).toContain("配额已用尽");
    }
    expect(apiRequests).toHaveLength(2);
  });

  test("preserves unconfirmed accounting errors without retrying either execution tool", async () => {
    const payload = {
      success: false,
      request_id: "server-generated-request-id",
      error: {
        type: "ServiceUnavailableError",
        message: "代码已执行，记账持久化未确认，请勿自动重试",
        retryable: false,
        details: {
          execution_id: "unconfirmed-execution",
          execution_completed: true,
          accounting_persistence: "unconfirmed",
        },
      },
    };
    apiResponse = () => Response.json(payload, { status: 503 });
    for (const [name, arguments_] of [
      ["flow_execute_code", { code: "return 1;", input: {} }],
      ["flow_execute_script", { script_id: "unconfirmed-script", method: "POST", body: {} }],
    ] as const) {
      apiRequests.length = 0;
      const response = await client.callTool({ name, arguments: arguments_ });
      expect(response.isError).toBe(true);
      const content = response.content.find((item) => item.type === "text");
      if (!content || content.type !== "text") throw new Error(`${name} did not return error text`);
      const error = JSON.parse(content.text);
      expect(error.status).toBe(503);
      expect(error.error).toEqual(payload);
      expect(error.error.request_id).toBe(payload.request_id);
      expect(apiRequests).toHaveLength(1);
    }
  });

  test("passes quota-store recovery failures through both execution tools", async () => {
    apiResponse = () => Response.json({
      success: false,
      error: { type: "ServiceUnavailableError", message: "Quota state is temporarily unavailable" },
    }, { status: 503 });

    for (const [name, arguments_] of [
      ["flow_execute_code", { code: "return 1;", input: {} }],
      ["flow_execute_script", { script_id: "recovering-quota-script", method: "POST", body: {} }],
    ] as const) {
      const response = await client.callTool({ name, arguments: arguments_ });
      expect(response.isError).toBe(true);
      const content = response.content.find((item) => item.type === "text");
      if (!content || content.type !== "text") throw new Error(`${name} did not return error text`);
      expect(content.text).toContain('"status": 503');
      expect(content.text).toContain('"type": "ServiceUnavailableError"');
      expect(content.text).not.toContain("QuotaExceededError");
    }
    expect(apiRequests).toHaveLength(2);
  });
});
