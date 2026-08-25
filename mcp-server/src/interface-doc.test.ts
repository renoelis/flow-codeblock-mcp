import { describe, expect, test } from "bun:test";
import { interfaceDocCompletenessIssues, normalizeInterfaceDocument } from "./interface-doc";

function field(type: string, description: string, example: unknown) {
  return { type, description, example };
}

function completePostDocument() {
  return {
    schema_version: "script-interface-doc.v1",
    title: "数据处理接口",
    summary: "接收业务字段并返回处理结果",
    endpoint: {
      methods: ["POST"],
      description: "校验请求体并返回处理结果",
    },
    request: {
      body: {
        content_type: "application/json",
        schema: {
          type: "object",
          properties: {
            queryText: field("string", "需要处理的文本", "待处理内容"),
          },
          required: ["queryText"],
          additionalProperties: false,
        },
        example: { queryText: "待处理内容" },
      },
    },
    responses: [
      {
        status: 200,
        description: "处理成功",
        content_type: "application/json",
        schema: {
          type: "object",
          properties: {
            success: field("boolean", "是否处理成功", true),
          },
          required: ["success"],
          additionalProperties: false,
        },
        example: { success: true },
      },
    ],
    logic_description: "读取并校验请求体中的业务字段，不调用外部服务，处理成功时返回结果，失败时返回明确错误。",
  };
}

describe("interfaceDocCompletenessIssues", () => {
  test("accepts complete required metadata", () => {
    expect(interfaceDocCompletenessIssues(completePostDocument(), "create")).toEqual([]);
  });

  test("allows request to be omitted when a GET endpoint has no inputs", () => {
    const document = completePostDocument();
    document.endpoint.methods = ["GET"];
    delete (document as Record<string, unknown>).request;
    expect(interfaceDocCompletenessIssues(document, "create")).toEqual([]);
  });

  test("allows request to be omitted when a POST endpoint has no inputs", () => {
    const document = completePostDocument();
    delete (document as Record<string, unknown>).request;
    expect(interfaceDocCompletenessIssues(document, "create")).toEqual([]);
  });

  test("requires name, type, description and example for actual parameters", () => {
    const document = completePostDocument();
    document.request.query = [{ name: "keyword", type: "string", required: false }];
    const issues = interfaceDocCompletenessIssues(document, "create");
    expect(issues.some((issue) => issue.includes("query[0].description"))).toBe(true);
    expect(issues.some((issue) => issue.includes("query[0].example"))).toBe(true);
  });

  test("requires type, description and example for response fields", () => {
    const document = completePostDocument();
    document.responses[0].schema.properties.success = { type: "boolean" };
    const issues = interfaceDocCompletenessIssues(document, "create");
    expect(issues.some((issue) => issue.includes("properties.success.description"))).toBe(true);
    expect(issues.some((issue) => issue.includes("properties.success.example"))).toBe(true);
  });

  test("requires description and example on array items", () => {
    const document = completePostDocument();
    document.responses[0].schema.properties.values = {
      type: "array",
      description: "结果值列表",
      example: [1],
      items: { type: "integer" },
    };
    document.responses[0].example.values = [1];
    const incompleteIssues = interfaceDocCompletenessIssues(document, "create");
    expect(incompleteIssues.some((issue) => issue.includes("properties.values.items.description"))).toBe(true);
    expect(incompleteIssues.some((issue) => issue.includes("properties.values.items.example"))).toBe(true);

    document.responses[0].schema.properties.values.items = {
      type: "integer",
      description: "单个结果值",
      example: 1,
    };
    expect(interfaceDocCompletenessIssues(document, "create")).toEqual([]);
  });

  test("normalizes misplaced schema fields and promotes schema root examples", () => {
    const document = completePostDocument();
    const body = document.request.body as Record<string, unknown>;
    const bodySchema = body.schema as Record<string, unknown>;
    bodySchema.example = body.example;
    body.properties = bodySchema.properties;
    body.required = bodySchema.required;
    delete body.example;
    delete bodySchema.properties;
    delete bodySchema.required;

    const response = document.responses[0] as Record<string, unknown>;
    const responseSchema = response.schema as Record<string, unknown>;
    responseSchema.example = response.example;
    delete response.example;

    const normalized = normalizeInterfaceDocument(document);
    expect(normalized.changes).toEqual([
      "interface_doc.request.body.properties 已移入 interface_doc.request.body.schema.properties",
      "interface_doc.request.body.required 已移入 interface_doc.request.body.schema.required",
      "interface_doc.request.body.example 已从 interface_doc.request.body.schema.example 提升",
      "interface_doc.responses[0].example 已从 interface_doc.responses[0].schema.example 提升",
    ]);
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("allows optional properties to be omitted from wrapper examples", () => {
    const document = completePostDocument();
    document.request.body.schema.properties.optionalNote = field("string", "可选备注", "示例备注");
    expect(interfaceDocCompletenessIssues(document, "create")).toEqual([]);

    document.request.body.schema.required.push("optionalNote");
    const issues = interfaceDocCompletenessIssues(document, "create");
    expect(issues).toContain("interface_doc.request.body.example 缺少 required 字段 optionalNote");
  });
});
