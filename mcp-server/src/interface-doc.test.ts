import { describe, expect, test } from "bun:test";
import {
  assertCompleteInterfaceDoc,
  interfaceDocCompletenessIssues,
  normalizeInterfaceDocument,
} from "./interface-doc";

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

  test("deduplicates invalid additionalProperties errors and gives a targeted repair rule", () => {
    const document = completePostDocument();
    document.request.body.schema.properties.detail = {
      type: "object",
      description: "订单详情",
      example: { invoice_id: "INV-001", note: "测试订单" },
      additionalProperties: {
        type: "object",
        description: "任意详情字段",
        example: {},
      },
    };
    document.request.body.example.detail = { invoice_id: "INV-001", note: "测试订单" };

    const issues = interfaceDocCompletenessIssues(document, "create");
    const additionalPropertiesIssues = issues.filter((issue) => (
      issue.includes("properties.detail.additionalProperties 必须使用 properties")
    ));
    expect(additionalPropertiesIssues).toHaveLength(1);
    expect(() => assertCompleteInterfaceDoc(document, "create")).toThrow(
      "错误路径以 .additionalProperties 结尾且父对象键名已知时，应修正父对象的 properties",
    );
  });

  test("allows explicitly opaque upstream JSON objects", () => {
    const document = completePostDocument();
    document.responses[0].schema.properties.data = {
      type: "object",
      description: "脚本原样透传且结构由上游接口决定的响应对象",
      example: { code: 0, message: "success", payload: { user_id: 1 } },
      additionalProperties: true,
    };
    document.responses[0].schema.required.push("data");
    document.responses[0].example.data = {
      code: 0,
      message: "success",
      payload: { user_id: 1 },
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

  test("recovers required arrays misplaced inside schema properties", () => {
    const document = completePostDocument();
    const bodySchema = document.request.body.schema as Record<string, unknown>;
    const properties = bodySchema.properties as Record<string, unknown>;
    properties.required = ["queryText"];
    delete bodySchema.required;
    const responseSchema = document.responses[0].schema as Record<string, unknown>;
    const responseProperties = responseSchema.properties as Record<string, unknown>;
    responseProperties.required = ["success"];
    delete responseSchema.required;

    const normalized = normalizeInterfaceDocument(document);
    expect(normalized.changes).toContain(
      "interface_doc.request.body.schema.properties.required 已移入 interface_doc.request.body.schema.required",
    );
    expect(normalized.changes).toContain(
      "interface_doc.responses[0].schema.properties.required 已移入 interface_doc.responses[0].schema.required",
    );
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("recovers root fields and tool fields misplaced inside interface_doc", () => {
    const document = completePostDocument() as Record<string, unknown>;
    const request = document.request as Record<string, unknown>;
    request.responses = document.responses;
    request.logic_description = document.logic_description;
    delete document.responses;
    delete document.logic_description;
    document.ip_whitelist = ["203.0.113.10"];

    const normalized = normalizeInterfaceDocument(document);
    const normalizedDocument = normalized.document as Record<string, unknown>;
    expect(normalized.changes).toContain("interface_doc.request.responses 已移入 interface_doc.responses");
    expect(normalized.changes).toContain("interface_doc.request.logic_description 已移入 interface_doc.logic_description");
    expect(normalized.changes).toContain("interface_doc.ip_whitelist 已移回 flow_preview_script_change.ip_whitelist");
    expect(normalizedDocument.responses).toHaveLength(1);
    expect(normalizedDocument.logic_description).toBeDefined();
    expect(normalizedDocument.ip_whitelist).toBeUndefined();
    expect(normalized.recovered.ip_whitelist).toEqual(["203.0.113.10"]);
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("recovers document fields and wrapper examples misplaced below request.body", () => {
    const document = completePostDocument() as Record<string, unknown>;
    const request = document.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const schema = body.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    schema.responses = document.responses;
    schema.logic_description = document.logic_description;
    properties.queryText.example = body.example;
    delete body.example;
    delete document.responses;
    delete document.logic_description;
    request.description = "数据处理脚本";
    body.ip_whitelist = ["203.0.113.20"];

    const normalized = normalizeInterfaceDocument(document);
    const normalizedDocument = normalized.document as Record<string, unknown>;
    const normalizedRequest = normalizedDocument.request as Record<string, unknown>;
    const normalizedBody = normalizedRequest.body as Record<string, unknown>;
    expect(normalized.changes).toEqual(expect.arrayContaining([
      "interface_doc.request.description 已移回 flow_preview_script_change.description",
      "interface_doc.request.body.ip_whitelist 已移回 flow_preview_script_change.ip_whitelist",
      "interface_doc.request.body.schema.responses 已移入 interface_doc.responses",
      "interface_doc.request.body.schema.logic_description 已移入 interface_doc.logic_description",
      "interface_doc.request.body.example 已从误放的 interface_doc.request.body.schema.properties.queryText.example 提升",
    ]));
    expect(normalized.recovered.description).toBe("数据处理脚本");
    expect(normalized.recovered.ip_whitelist).toEqual(["203.0.113.20"]);
    expect(normalizedBody.example).toEqual({ queryText: "待处理内容" });
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("recovers body-level root fields and examples stored as a properties entry", () => {
    const document = completePostDocument() as Record<string, unknown>;
    const request = document.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const schema = body.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    body.responses = document.responses;
    body.logic_description = document.logic_description;
    properties.example = body.example;
    delete body.example;
    delete document.responses;
    delete document.logic_description;

    const normalized = normalizeInterfaceDocument(document);
    expect(normalized.changes).toEqual(expect.arrayContaining([
      "interface_doc.request.body.responses 已移入 interface_doc.responses",
      "interface_doc.request.body.logic_description 已移入 interface_doc.logic_description",
      "interface_doc.request.body.example 已从 interface_doc.request.body.schema.properties.example 提升",
    ]));
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

  test("removes string usage notes and copies examples between snake and camel aliases", () => {
    const document = completePostDocument();
    const properties = document.request.body.schema.properties as Record<string, unknown>;
    properties.store_info = {
      type: "object",
      description: "蛇形门店信息",
      example: { id: "STORE-001" },
      additionalProperties: field("string", "门店字段值", "STORE-001"),
    };
    properties.storeInfo = {
      type: "object",
      description: "驼峰门店信息",
      additionalProperties: field("string", "门店字段值", "STORE-001"),
    };
    (document as Record<string, unknown>).usage_refs = ["普通安全说明不属于应用引用"];

    const normalized = normalizeInterfaceDocument(document);
    expect(normalized.changes).toContain(
      "interface_doc.usage_refs 已移除 1 个非对象条目；普通说明应写入 logic_description",
    );
    expect(normalized.changes).toContain(
      "interface_doc.request.body.schema.properties.storeInfo.example 已从别名 interface_doc.request.body.schema.properties.store_info.example 补全",
    );
    expect((normalized.document as Record<string, unknown>).usage_refs).toBeUndefined();
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("validates structured usage references before calling the API", () => {
    const document = completePostDocument();
    (document as Record<string, unknown>).usage_refs = [{ note: "缺少应用名称", unsupported: true }];
    const issues = interfaceDocCompletenessIssues(document, "create");
    expect(issues).toContain("interface_doc.usage_refs[0].app_name 必须是至少 1 个字符的非空字符串");
    expect(issues).toContain("interface_doc.usage_refs[0].unsupported 不是支持的字段");
  });

  test("normalizes nested examples independently of property order", () => {
    const document = completePostDocument();
    const properties = document.request.body.schema.properties as Record<string, unknown>;
    properties.settleInfo = {
      type: "object",
      description: "驼峰结算信息",
      additionalProperties: { type: "boolean", description: "结算字段值" },
    };
    properties.settle_info = {
      type: "object",
      description: "蛇形结算信息",
      additionalProperties: { type: "boolean", description: "结算字段值" },
    };
    properties.rows = {
      type: "array",
      description: "结算信息列表",
      example: [{ profitSharing: false }],
      items: {
        type: "object",
        description: "单条结算信息",
        properties: {
          profitSharing: { type: "boolean", description: "是否分账" },
        },
        required: ["profitSharing"],
      },
    };
    document.request.body.example = {
      queryText: "待处理内容",
      settle_info: { profit_sharing: false },
    };

    const normalized = normalizeInterfaceDocument(document);
    const normalizedDocument = normalized.document as typeof document;
    const normalizedProperties = normalizedDocument.request.body.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(normalizedProperties.settleInfo.example).toEqual({ profit_sharing: false });
    expect(normalizedProperties.settle_info.example).toEqual({ profit_sharing: false });
    expect((normalizedProperties.settleInfo.additionalProperties as Record<string, unknown>).example).toBe(false);
    expect((normalizedProperties.rows.items as Record<string, unknown>).example).toEqual({ profitSharing: false });
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);
  });

  test("moves request-level examples into the body and reports unsupported fields locally", () => {
    const document = completePostDocument() as Record<string, unknown>;
    const request = document.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    request.example = { queryText: "请求层示例" };
    delete body.example;

    const normalized = normalizeInterfaceDocument(document);
    expect(normalized.changes).toContain(
      "interface_doc.request.example 已移入 interface_doc.request.body.example",
    );
    expect(interfaceDocCompletenessIssues(normalized.document, "create")).toEqual([]);

    const invalidDocument = normalized.document as Record<string, unknown>;
    (invalidDocument.endpoint as Record<string, unknown>).unsupported = true;
    (invalidDocument.request as Record<string, unknown>).unsupported = true;
    const issues = interfaceDocCompletenessIssues(invalidDocument, "create");
    expect(issues).toContain("interface_doc.endpoint.unsupported 不是支持的字段");
    expect(issues).toContain("interface_doc.request.unsupported 不是支持的字段");
  });
});
