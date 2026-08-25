import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let validationRequest: Record<string, unknown> | undefined;
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/flow/scripts/validate") {
      validationRequest = await request.json() as Record<string, unknown>;
      return Response.json({ success: true, data: { valid: true, warnings: [] } });
    }
    return Response.json({ success: false }, { status: 404 });
  },
});

const client = new Client({ name: "flow-codeblock-script-preview-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_script_preview_test",
  },
  stderr: "pipe",
});

function misplacedInterfaceDoc() {
  return {
    schema_version: "script-interface-doc.v1",
    title: "名称校验",
    summary: "校验名称并返回成功状态",
    endpoint: { methods: ["POST"], description: "接收名称并校验" },
    request: {
      body: {
        content_type: "application/json",
        schema: { type: "object", example: { name: "示例名称" } },
        properties: {
          name: { type: "string", description: "待校验名称", example: "示例名称" },
          store_info: {
            type: "object",
            description: "蛇形门店信息",
            example: { id: "STORE-001" },
            additionalProperties: { type: "string", description: "门店字段值", example: "STORE-001" },
          },
          storeInfo: {
            type: "object",
            description: "驼峰门店信息",
            additionalProperties: { type: "string", description: "门店字段值", example: "STORE-001" },
          },
        },
        required: ["name"],
      },
    },
    responses: [{
      status: 200,
      description: "校验成功",
      content_type: "application/json",
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", description: "是否成功", example: true },
        },
        example: { success: true },
      },
    }],
    logic_description: "读取并校验请求中的名称字段，不调用外部服务，成功时返回成功状态，失败时返回错误信息。",
    usage_refs: ["普通说明不属于应用引用"],
  };
}

beforeAll(async () => {
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await apiServer.stop(true);
});

describe("script preview tool", () => {
  test("normalizes common interface document placement errors before API validation", async () => {
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: misplacedInterfaceDoc(),
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.interface_doc_normalizations).toEqual([
      "interface_doc.usage_refs 已移除 1 个非对象条目；普通说明应写入 logic_description",
      "interface_doc.request.body.properties 已移入 interface_doc.request.body.schema.properties",
      "interface_doc.request.body.required 已移入 interface_doc.request.body.schema.required",
      "interface_doc.request.body.example 已从 interface_doc.request.body.schema.example 提升",
      "interface_doc.request.body.schema.properties.storeInfo.example 已从别名 interface_doc.request.body.schema.properties.store_info.example 补全",
      "interface_doc.responses[0].example 已从 interface_doc.responses[0].schema.example 提升",
    ]);

    const interfaceDoc = validationRequest?.interface_doc as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const bodySchema = body.schema as Record<string, unknown>;
    const responses = interfaceDoc.responses as Array<Record<string, unknown>>;
    expect(bodySchema.properties).toBeDefined();
    expect(bodySchema.required).toEqual(["name"]);
    expect(body.example).toEqual({ name: "示例名称" });
    expect(responses[0].example).toEqual({ success: true });
    expect(interfaceDoc.usage_refs).toBeUndefined();
    const properties = bodySchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.storeInfo.example).toEqual({ id: "STORE-001" });
  });

  test("reports applied normalizations when other document errors remain", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    delete interfaceDoc.logic_description;
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview error did not return text");
    expect(content.text).toContain("interface_doc.logic_description");
    expect(content.text).toContain("保留原 interface_doc");
    expect(content.text).toContain("本次已自动规范化");
    expect(content.text).toContain("interface_doc.request.body.properties 已移入");
  });

  test("recovers document fields misplaced at the tool argument level", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const responses = interfaceDoc.responses;
    const logicDescription = interfaceDoc.logic_description;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    const request = interfaceDoc.request as Record<string, unknown>;
    request.example = { name: "请求层示例" };

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
        responses,
        logic_description: logicDescription,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    const normalizations = preview.interface_doc_normalizations as string[];
    expect(normalizations).toContain("工具参数 responses 已移入 interface_doc.responses");
    expect(normalizations).toContain("工具参数 logic_description 已移入 interface_doc.logic_description");
    expect(normalizations).toContain("interface_doc.request.example 已移入 interface_doc.request.body.example");

    const normalizedDocument = validationRequest?.interface_doc as Record<string, unknown>;
    const normalizedRequest = normalizedDocument.request as Record<string, unknown>;
    const normalizedBody = normalizedRequest.body as Record<string, unknown>;
    const normalizedResponses = normalizedDocument.responses as Array<Record<string, unknown>>;
    expect(normalizedResponses).toHaveLength(1);
    expect(normalizedResponses[0].status).toBe(200);
    expect(normalizedResponses[0].example).toEqual({ success: true });
    expect(normalizedDocument.logic_description).toBe(logicDescription);
    expect(normalizedRequest.example).toBeUndefined();
    expect(normalizedBody.example).toEqual({ name: "请求层示例" });
  });

  test("recovers request root fields and whitelist misplaced inside interface_doc", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    request.responses = interfaceDoc.responses;
    request.logic_description = interfaceDoc.logic_description;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    interfaceDoc.ip_whitelist = ["203.0.113.10"];

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.request.responses 已移入 interface_doc.responses",
      "interface_doc.request.logic_description 已移入 interface_doc.logic_description",
      "interface_doc.ip_whitelist 已移回 flow_preview_script_change.ip_whitelist",
    ]));
    expect((validationRequest as Record<string, unknown>).ip_whitelist).toEqual(["203.0.113.10"]);
    const normalized = (validationRequest as Record<string, unknown>).interface_doc as Record<string, unknown>;
    expect(normalized.responses).toHaveLength(1);
    expect(normalized.logic_description).toBeDefined();
    expect(normalized.ip_whitelist).toBeUndefined();
  });

  test("recovers deeply nested document fields before preview validation", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const schema = body.schema as Record<string, unknown>;
    const properties = body.properties as Record<string, unknown>;
    schema.responses = interfaceDoc.responses;
    schema.logic_description = interfaceDoc.logic_description;
    properties.example = schema.example;
    delete schema.example;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    request.description = "名称校验脚本";
    body.ip_whitelist = ["203.0.113.30"];

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.changes).toMatchObject({ description: true, ip_whitelist: true, interface_doc: true });
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.request.description 已移回 flow_preview_script_change.description",
      "interface_doc.request.body.ip_whitelist 已移回 flow_preview_script_change.ip_whitelist",
      "interface_doc.request.body.schema.responses 已移入 interface_doc.responses",
      "interface_doc.request.body.schema.logic_description 已移入 interface_doc.logic_description",
      "interface_doc.request.body.example 已从 interface_doc.request.body.schema.properties.example 提升",
    ]));
    expect(validationRequest?.ip_whitelist).toEqual(["203.0.113.30"]);
    const normalized = validationRequest?.interface_doc as Record<string, unknown>;
    const normalizedRequest = normalized.request as Record<string, unknown>;
    const normalizedBody = normalizedRequest.body as Record<string, unknown>;
    expect(normalized.responses).toHaveLength(1);
    expect(normalized.logic_description).toBeDefined();
    expect(normalizedBody.example).toEqual({ name: "示例名称" });
  });

  test("rejects misplaced document fields when interface_doc is absent", async () => {
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        responses: [],
        logic_description: "这段说明不能替代完整的接口文档对象。",
      },
    });

    expect(response.isError).toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview error did not return text");
    expect(content.text).toContain("不能替代 interface_doc");
  });
});
