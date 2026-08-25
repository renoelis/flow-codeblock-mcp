import { z } from "zod";

type JsonObject = Record<string, unknown>;

export type InterfaceDocRecoveryFields = {
  responses?: unknown;
  logic_description?: unknown;
};

export type InterfaceDocNormalization = {
  document: unknown;
  changes: string[];
  recovered: {
    description?: unknown;
    ip_whitelist?: unknown;
  };
};

export const interfaceDocRequiredFields = {
  document: ["schema_version", "title", "summary", "endpoint", "responses", "logic_description"],
  endpoint: ["methods", "description"],
  request: ["query/headers/body（仅在实际存在对应参数或 POST 请求体时填写）"],
  parameter: ["name", "type", "description", "example", "required（运行时是否必填）"],
  body: ["content_type", "schema", "example"],
  response: ["status", "description", "content_type", "schema", "example"],
  conditionally_optional: ["request（无查询参数、请求头和请求体时可省略）", "endpoint.path（创建可省略，更新必填实际路径）", "usage_refs（始终可省略）"],
};

export const interfaceDocNestedRules = [
  "请求体或响应体的根 Schema 节点必须填写 type；其所有嵌套 Schema 节点（包括 properties 字段、array.items 和对象形式 additionalProperties 的值 Schema）都必须填写 type、description 和 example。",
  "每个 Schema 节点自身的 example 都必须与该节点的 type、properties 和 required 一致；不能把外层完整响应示例误放进某个内层字段的 example。",
  "JSON Schema 关键字名称只能使用字母开头的标准/扩展标识形式（可带 $ 前缀、数字、下划线、点或连字符）；:{ 等损坏键名必须删除。properties 内的业务字段名不受此限制。",
  "代码或 example 中键名已知的对象必须用 properties 逐项描述；对象形式 additionalProperties 仅用于键名运行时才确定且所有值结构相同的动态字典，并描述单个动态值的完整 Schema。只有脚本原样透传且无法从代码、接口契约或示例确定结构的上游 JSON 对象，才使用 additionalProperties=true；不得用 type=object、example={} 的 additionalProperties 作为任意 JSON 值的兜底。",
  "每个 type=array 都必须有 items，且 items 本身必须填写 type、description 和 example；items.type=object 时还必须有完整 items.properties。数组 example 中的每个对象都必须覆盖 items.properties 的全部字段。",
  "任意层级 example 中出现的字段必须有对应 properties 或 additionalProperties，且 example 的 JSON 类型必须与 type 一致；properties 中列入 required 的字段必须出现在 example 中，运行时可选字段可以省略。",
  "JSON Schema 的 required 只表示运行时真正必填的业务字段；成功和错误结构不同应拆成不同 responses。",
];

export const interfaceDocRepairRules = [
  "保留原 interface_doc 中未报错的字段，只修正错误列表指出的路径；不要为了修复单个字段而重写或删减 responses、logic_description 或 request。",
  "responses 和 logic_description 属于 interface_doc 根对象，request.body.example 与 schema 同级，properties、required、items、additionalProperties 属于 schema。MCP 会兼容纠正常见错位、从父级或同名蛇形/驼峰别名补全可推导的节点 example，并移除 usage_refs 中无效的非对象说明。",
  "对象字段已能从代码或 example 确定时，在该对象上使用 properties 逐项描述；只有键名未知且每个动态值都符合同一 Schema 时才使用对象形式 additionalProperties。脚本原样透传且结构确实未知的上游 JSON 对象使用 additionalProperties=true；错误路径以 .additionalProperties 结尾且父对象键名已知时，应修正父对象的 properties，不要继续嵌套空 additionalProperties。",
  "每个 example 的类型必须与对应 type 一致；同一状态码存在字符串错误和对象错误等不同结构时，拆成多个 responses 分别描述。",
  "interface_doc 根对象只允许 schema_version/title/summary/endpoint/request/responses/logic_description/usage_refs；request 只允许 query/headers/body。ip_whitelist 是 flow_preview_script_change 的工具参数，不属于 interface_doc。",
  "schema.properties 只能放字段名到字段 Schema 的映射；schema.required 必须与 properties 同级，schema.additionalProperties 也必须与 properties 同级，不能把 required: [] 或布尔 additionalProperties 放进 properties。",
  "文档说明字段中的 input.query/input.header/input.body/input.cookies 等平台内部输入术语会自动转换为调用方 HTTP 术语；example、default 和 enum_values 中的业务值保持原样。新文档应直接使用 URL 查询参数、HTTP 请求头、HTTP 请求体和 Cookie。",
];

export const interfaceDocInputDescription = [
  "创建和代码更新时必填完整 script-interface-doc.v1；只改 description/ip_whitelist 时可省略。",
  "字段位置：根对象包含 schema_version='script-interface-doc.v1'、title、summary、endpoint、request?、responses、logic_description、usage_refs?；endpoint={methods,path?,description}；request={query?,headers?,body?}；query/headers 为 parameter 数组；body={content_type='application/json',schema,example}；responses 的每项={status,description,content_type='application/json',schema,example}。",
  "usage_refs 仅用于真实应用引用，每项必须是 {app_name,app_id?,location?,note?} 对象；普通说明写入 logic_description，不能把字符串数组放入 usage_refs。",
  `必填结构：${Object.entries(interfaceDocRequiredFields).map(([key, fields]) => `${key}=[${fields.join(",")}]`).join("；")}。`,
  ...interfaceDocRepairRules,
  ...interfaceDocNestedRules,
].join(" ");

const looseSchemaNode = z.looseObject({
  type: z.string().optional().describe("JSON Schema 类型，如 object、array、string、integer、number 或 boolean。"),
  description: z.string().optional().describe("该节点表示的业务字段或数据结构说明。"),
  example: z.unknown().optional().describe("与该节点 type 一致的具体示例值。"),
  properties: z.object({}).catchall(z.unknown()).optional().describe(
    "固定对象字段到子 Schema 的映射；字段名直接作为 properties 的键。",
  ),
  items: z.unknown().optional().describe("数组元素的完整子 Schema。"),
  additionalProperties: z.unknown().optional().describe(
    "对象 Schema 用于值结构相同的动态键字典；true 仅用于脚本原样透传且结构确实未知的上游 JSON 对象；false 表示不允许未声明字段。",
  ),
  required: z.array(z.string()).optional().describe("运行时真正必填的 properties 字段名。"),
});

const parameterInputSchema = z.looseObject({
  name: z.string().optional().describe("调用方使用的查询参数或请求头名称。"),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]).optional().describe(
    "参数 JSON 类型。",
  ),
  required: z.boolean().optional().describe("该参数在运行时是否必填。"),
  description: z.string().optional().describe("参数用途和约束说明。"),
  example: z.unknown().optional().describe("参数的具体示例值。"),
  default: z.unknown().optional().describe("可选默认值。"),
  format: z.string().optional().describe("可选格式提示。"),
  enum_values: z.array(z.unknown()).optional().describe("可选枚举值列表。"),
});

const bodyInputSchema = z.looseObject({
  content_type: z.literal("application/json").optional().describe("固定为 application/json。"),
  schema: looseSchemaNode.optional().describe("调用方 POST 请求体的 JSON Schema。"),
  example: z.unknown().optional().describe("与 schema 同级且结构一致的完整请求体示例。"),
});

const responseInputSchema = z.looseObject({
  status: z.number().int().min(100).max(599).optional().describe("HTTP 状态码，范围 100-599。"),
  description: z.string().optional().describe("该响应分支的业务含义。"),
  content_type: z.literal("application/json").optional().describe("固定为 application/json。"),
  schema: looseSchemaNode.optional().describe("响应体 JSON Schema。"),
  example: z.unknown().optional().describe("与 schema 同级且结构一致的完整响应示例。"),
});

const patchPathSchema = z.string().describe("RFC 6901 JSON Pointer 路径；数组路径使用当前 canonical 文档的索引。");
const interfaceDocPatchOperationSchema = z.union([
  z.object({ op: z.literal("add"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: patchPathSchema }).strict(),
  z.object({ op: z.literal("replace"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("move"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("copy"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("test"), path: patchPathSchema, value: z.unknown() }).strict(),
]);

export const interfaceDocPatchSchema = z.array(interfaceDocPatchOperationSchema)
  .min(1)
  .max(256)
  .describe("RFC 6902 JSON Patch 操作数组；按顺序应用，不能与完整 interface_doc 同时提供。");

export const interfaceDocToolInputSchema = z.looseObject({
  schema_version: z.literal("script-interface-doc.v1").optional().describe("固定文档契约版本。"),
  title: z.string().optional().describe("接口文档标题。"),
  summary: z.string().optional().describe("面向调用方的一句话摘要。"),
  endpoint: z.looseObject({
    methods: z.array(z.enum(["GET", "POST"])).optional().describe("接口支持的请求方法。"),
    path: z.string().optional().describe("更新时填写实际 /flow/codeblock/{script_id} 路径。"),
    description: z.string().optional().describe("接口用途说明。"),
  }).optional().describe("脚本 HTTP 端点契约。"),
  request: z.looseObject({
    query: z.array(parameterInputSchema).optional().describe("调用方 URL 查询参数。"),
    headers: z.array(parameterInputSchema).optional().describe("调用方业务请求头。"),
    body: bodyInputSchema.optional().describe("POST 请求体；example 必须与 schema 同级。"),
  }).optional().describe("调用方请求契约；只能包含 query、headers 和 body。"),
  responses: z.array(responseInputSchema).optional().describe("完整响应分支数组，属于 interface_doc 根对象。"),
  logic_description: z.string().optional().describe("接口处理逻辑，属于 interface_doc 根对象且至少 20 个字符。"),
  usage_refs: z.array(z.unknown()).optional().describe(
    "真实应用引用对象数组，每项为 {app_name,app_id?,location?,note?}；普通说明不要放在这里。",
  ),
}).describe(interfaceDocInputDescription);

export function assertInterfaceDocPatch(patch: unknown): void {
  const parsed = interfaceDocPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(`interface_doc_patch 格式无效：${parsed.error.message}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const schemaPlacementKeys = ["properties", "required", "items", "additionalProperties"] as const;

function comparableFieldName(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function normalizeSchemaNodeExamples(
  schema: JsonObject,
  example: unknown,
  path: string,
  changes: string[],
): void {
  if (schema.type === "array" && isObject(schema.items)) {
    if (!hasOwn(schema.items, "example") && Array.isArray(example) && example.length > 0) {
      schema.items.example = structuredClone(example[0]);
      changes.push(`${path}.items.example 已从数组示例首项补全`);
    }
    normalizeSchemaNodeExamples(schema.items, schema.items.example, `${path}.items`, changes);
    return;
  }

  if (schema.type !== "object") return;
  const misplacedRequired = isObject(schema.properties) && Array.isArray(schema.properties.required)
    ? schema.properties.required
    : undefined;
  if (misplacedRequired && misplacedRequired.every((field) => typeof field === "string")) {
    if (!hasOwn(schema, "required")) {
      schema.required = structuredClone(misplacedRequired);
      changes.push(`${path}.properties.required 已移入 ${path}.required`);
    } else {
      changes.push(`${path}.properties.required 已移除；${path}.required 已存在`);
    }
    delete (schema.properties as JsonObject).required;
  }
  const misplacedAdditionalProperties = isObject(schema.properties)
    ? schema.properties.additionalProperties
    : undefined;
  if (typeof misplacedAdditionalProperties === "boolean") {
    if (!hasOwn(schema, "additionalProperties")) {
      schema.additionalProperties = misplacedAdditionalProperties;
      changes.push(`${path}.properties.additionalProperties 已移入 ${path}.additionalProperties`);
    } else {
      changes.push(`${path}.properties.additionalProperties 已移除；${path}.additionalProperties 已存在`);
    }
    delete (schema.properties as JsonObject).additionalProperties;
  }
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const objectExample = isObject(example) ? example : undefined;
  if (properties) {
    const entries = Object.entries(properties);

    for (const [key, propertySchema] of entries) {
      if (
        isObject(propertySchema) &&
        !hasOwn(propertySchema, "example") &&
        objectExample &&
        hasOwn(objectExample, key)
      ) {
        propertySchema.example = structuredClone(objectExample[key]);
        changes.push(`${path}.properties.${key}.example 已从父级示例补全`);
      }
    }

    // Resolve aliases only after every property has had a chance to use the parent example.
    for (const [key, propertySchema] of entries) {
      if (!isObject(propertySchema)) continue;
      if (!hasOwn(propertySchema, "example")) {
        const alias = entries.find(([candidateKey, candidateSchema]) => (
          candidateKey !== key &&
          comparableFieldName(candidateKey) === comparableFieldName(key) &&
          isObject(candidateSchema) &&
          hasOwn(candidateSchema, "example")
        ));
        if (alias && isObject(alias[1])) {
          propertySchema.example = structuredClone(alias[1].example);
          changes.push(`${path}.properties.${key}.example 已从别名 ${path}.properties.${alias[0]}.example 补全`);
        }
      }
    }

    for (const [key, propertySchema] of entries) {
      if (!isObject(propertySchema)) continue;
      normalizeSchemaNodeExamples(
        propertySchema,
        propertySchema.example,
        `${path}.properties.${key}`,
        changes,
      );
    }
  }

  if (isObject(schema.additionalProperties)) {
    const knownKeys = new Set(properties ? Object.keys(properties) : []);
    const dynamicExample = objectExample
      ? Object.entries(objectExample).find(([key]) => !knownKeys.has(key))?.[1]
      : undefined;
    if (!hasOwn(schema.additionalProperties, "example") && dynamicExample !== undefined) {
      schema.additionalProperties.example = structuredClone(dynamicExample);
      changes.push(`${path}.additionalProperties.example 已从动态字段示例补全`);
    }
    normalizeSchemaNodeExamples(
      schema.additionalProperties,
      schema.additionalProperties.example,
      `${path}.additionalProperties`,
      changes,
    );
  }
}

function exampleMatchesType(type: unknown, example: unknown): boolean {
  switch (type) {
    case "array": return Array.isArray(example);
    case "object": return isObject(example);
    case "string": return typeof example === "string";
    case "integer": return typeof example === "number" && Number.isInteger(example);
    case "number": return typeof example === "number";
    case "boolean": return typeof example === "boolean";
    case "null": return example === null;
    default: return true;
  }
}

function isRootObjectExample(schema: JsonObject, example: unknown, ignoredProperty?: string): boolean {
  if (schema.type !== "object" || !isObject(schema.properties) || !isObject(example)) return false;
  const propertyNames = new Set(Object.keys(schema.properties).filter((name) => name !== ignoredProperty));
  const exampleNames = Object.keys(example);
  return exampleNames.length > 0 && exampleNames.every((name) => propertyNames.has(name));
}

function recoverMisplacedContainerExample(container: JsonObject, path: string, changes: string[]): void {
  if (hasOwn(container, "example") || !isObject(container.schema) || !isObject(container.schema.properties)) return;

  const schema = container.schema;
  const properties = schema.properties;
  if (
    hasOwn(properties, "example") &&
    isRootObjectExample(schema, properties.example, "example")
  ) {
    container.example = structuredClone(properties.example);
    delete properties.example;
    changes.push(`${path}.example 已从 ${path}.schema.properties.example 提升`);
    return;
  }

  for (const [name, propertySchema] of Object.entries(properties)) {
    if (
      !isObject(propertySchema) ||
      !hasOwn(propertySchema, "example") ||
      exampleMatchesType(propertySchema.type, propertySchema.example) ||
      !isRootObjectExample(schema, propertySchema.example)
    ) {
      continue;
    }
    container.example = structuredClone(propertySchema.example);
    delete propertySchema.example;
    changes.push(`${path}.example 已从误放的 ${path}.schema.properties.${name}.example 提升`);
    return;
  }
}

function normalizeSchemaContainer(container: JsonObject, path: string, changes: string[]): void {
  if (!isObject(container.schema)) return;

  for (const key of schemaPlacementKeys) {
    if (hasOwn(container, key) && !hasOwn(container.schema, key)) {
      container.schema[key] = container[key];
      delete container[key];
      changes.push(`${path}.${key} 已移入 ${path}.schema.${key}`);
    }
  }

  if (!hasOwn(container, "example") && hasOwn(container.schema, "example")) {
    container.example = structuredClone(container.schema.example);
    changes.push(`${path}.example 已从 ${path}.schema.example 提升`);
  }
  recoverMisplacedContainerExample(container, path, changes);
  normalizeSchemaNodeExamples(container.schema, container.example, `${path}.schema`, changes);
}

function normalizeUsageRefs(document: JsonObject, changes: string[]): void {
  if (!Array.isArray(document.usage_refs)) return;
  const validRefs = document.usage_refs.filter(isObject);
  const removedCount = document.usage_refs.length - validRefs.length;
  if (removedCount === 0) return;

  if (validRefs.length === 0) {
    delete document.usage_refs;
  } else {
    document.usage_refs = validRefs;
  }
  changes.push(
    `interface_doc.usage_refs 已移除 ${removedCount} 个非对象条目；普通说明应写入 logic_description`,
  );
}

const documentationProseKeys = new Set(["summary", "description", "logic_description", "note"]);
const documentationValueKeys = new Set(["example", "default", "enum_values"]);
const internalInputTermPattern = /\binput\.(?:query|header|body|cookies)\b/i;
const internalInputPhraseReplacements: Array<[RegExp, string]> = [
  [/从\s*\binput\.query\b\s*读取(?:URL\s*)?查询参数/gi, "读取 URL 查询参数"],
  [/从\s*\binput\.header\b\s*读取(?:HTTP\s*)?请求头/gi, "读取 HTTP 请求头"],
  [/从\s*\binput\.body\b\s*读取(?:HTTP\s*)?请求体/gi, "读取 HTTP 请求体"],
  [/从\s*\binput\.cookies\b\s*读取\s*Cookie/gi, "读取 Cookie"],
];
const internalInputTermReplacements: Array<[RegExp, string]> = [
  [/\binput\.query\b/gi, "URL 查询参数"],
  [/\binput\.header\b/gi, "HTTP 请求头"],
  [/\binput\.body\b/gi, "HTTP 请求体"],
  [/\binput\.cookies\b/gi, "Cookie"],
];

function publicDocumentationText(value: string): string {
  const phraseRewritten = internalInputPhraseReplacements.reduce(
    (rewritten, [pattern, replacement]) => rewritten.replace(pattern, replacement),
    value,
  );
  const rewritten = internalInputTermReplacements.reduce(
    (rewritten, [pattern, replacement]) => rewritten.replace(pattern, replacement),
    phraseRewritten,
  );
  return rewritten
    .replace(/(URL 查询参数|HTTP 请求头|HTTP 请求体|Cookie)\s+(?=[\u3400-\u9fff])/g, "$1");
}

function normalizeInternalInputTerms(value: unknown, path: string, changes: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => normalizeInternalInputTerms(item, `${path}[${index}]`, changes));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (documentationProseKeys.has(key) && typeof item === "string") {
      const rewritten = publicDocumentationText(item);
      if (rewritten !== item) {
        value[key] = rewritten;
        changes.push(`${itemPath} 已将平台内部输入术语转换为调用方 HTTP 术语`);
      }
      continue;
    }
    if (!documentationValueKeys.has(key)) {
      normalizeInternalInputTerms(item, itemPath, changes);
    }
  }
}

function recoverInterfaceDocRootFields(
  document: JsonObject,
  recoveryFields: InterfaceDocRecoveryFields,
  changes: string[],
): void {
  for (const key of ["responses", "logic_description"] as const) {
    if (recoveryFields[key] === undefined) continue;
    if (hasOwn(document, key)) {
      changes.push(`工具参数 ${key} 已忽略；interface_doc.${key} 已存在`);
      continue;
    }
    document[key] = structuredClone(recoveryFields[key]);
    changes.push(`工具参数 ${key} 已移入 interface_doc.${key}`);
  }
}

function recoverDocumentRootFields(
  document: JsonObject,
  container: JsonObject,
  path: string,
  changes: string[],
): void {
  for (const key of ["responses", "logic_description"] as const) {
    if (!hasOwn(container, key)) continue;
    if (hasOwn(document, key)) {
      delete container[key];
      changes.push(`${path}.${key} 已移除；interface_doc.${key} 已存在`);
      continue;
    }
    document[key] = container[key];
    delete container[key];
    changes.push(`${path}.${key} 已移入 interface_doc.${key}`);
  }
}

function recoverToolField(
  container: JsonObject,
  path: string,
  key: "description" | "ip_whitelist",
  recovered: InterfaceDocNormalization["recovered"],
  changes: string[],
): void {
  if (!hasOwn(container, key)) return;
  if (!hasOwn(recovered, key)) recovered[key] = container[key];
  delete container[key];
  changes.push(`${path}.${key} 已移回 flow_preview_script_change.${key}`);
}

export function normalizeInterfaceDocument(
  document: unknown,
  recoveryFields: InterfaceDocRecoveryFields = {},
): InterfaceDocNormalization {
  if (!isObject(document)) return { document, changes: [], recovered: {} };

  const normalized = structuredClone(document) as JsonObject;
  const changes: string[] = [];
  const recovered: InterfaceDocNormalization["recovered"] = {};
  recoverToolField(normalized, "interface_doc", "description", recovered, changes);
  recoverToolField(normalized, "interface_doc", "ip_whitelist", recovered, changes);
  const request = isObject(normalized.request) ? normalized.request : undefined;
  const body = request && isObject(request.body) ? request.body : undefined;
  const bodySchema = body && isObject(body.schema) ? body.schema : undefined;
  if (request) recoverToolField(request, "interface_doc.request", "description", recovered, changes);
  if (request) recoverToolField(request, "interface_doc.request", "ip_whitelist", recovered, changes);
  if (body) recoverToolField(body, "interface_doc.request.body", "description", recovered, changes);
  if (body) recoverToolField(body, "interface_doc.request.body", "ip_whitelist", recovered, changes);
  if (bodySchema) recoverToolField(bodySchema, "interface_doc.request.body.schema", "ip_whitelist", recovered, changes);
  if (request) recoverDocumentRootFields(normalized, request, "interface_doc.request", changes);
  if (body) recoverDocumentRootFields(normalized, body, "interface_doc.request.body", changes);
  if (bodySchema) recoverDocumentRootFields(normalized, bodySchema, "interface_doc.request.body.schema", changes);
  recoverInterfaceDocRootFields(normalized, recoveryFields, changes);
  normalizeUsageRefs(normalized, changes);
  if (isObject(normalized.request) && isObject(normalized.request.body)) {
    if (hasOwn(normalized.request, "example")) {
      if (!hasOwn(normalized.request.body, "example")) {
        normalized.request.body.example = structuredClone(normalized.request.example);
        changes.push("interface_doc.request.example 已移入 interface_doc.request.body.example");
      } else {
        changes.push("interface_doc.request.example 已移除；interface_doc.request.body.example 已存在");
      }
      delete normalized.request.example;
    }
    normalizeSchemaContainer(normalized.request.body, "interface_doc.request.body", changes);
  }
  if (Array.isArray(normalized.responses)) {
    normalized.responses.forEach((response, index) => {
      if (isObject(response)) {
        const responsePath = `interface_doc.responses[${index}]`;
        if (hasOwn(response, "responses_placeholder") && response.responses_placeholder === null) {
          delete response.responses_placeholder;
          changes.push(`${responsePath}.responses_placeholder 空占位字段已移除`);
        }
        normalizeSchemaContainer(response, responsePath, changes);
      }
    });
  }
  normalizeInternalInputTerms(normalized, "interface_doc", changes);
  return { document: normalized, changes, recovered };
}

function requireText(object: JsonObject, key: string, path: string, issues: string[], minLength = 1): void {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length < minLength) {
    issues.push(`${path}.${key} 必须是至少 ${minLength} 个字符的非空字符串`);
  }
}

function rejectUnsupportedFields(
  object: JsonObject,
  supportedFields: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!supportedFields.includes(key)) {
      issues.push(`${path}.${key} 不是支持的字段`);
    }
  }
}

function validateFieldSchemaMetadata(schema: JsonObject, schemaPath: string, issues: string[]): void {
  if (typeof schema.type !== "string" || schema.type.trim().length === 0) {
    issues.push(`${schemaPath}.type 必须填写`);
  }
  requireText(schema, "description", schemaPath, issues);
  if (!hasOwn(schema, "example")) {
    issues.push(`${schemaPath}.example 必须填写字段示例值`);
  }
}

function validateSchemaExampleCoverage(
  schema: JsonObject,
  example: unknown,
  schemaPath: string,
  examplePath: string,
  issues: string[],
  root = true,
  metadataValidated = false,
): void {
  if (root) {
    if (typeof schema.type !== "string" || schema.type.trim().length === 0) {
      issues.push(`${schemaPath}.type 必须填写`);
    }
  } else if (!metadataValidated) {
    validateFieldSchemaMetadata(schema, schemaPath, issues);
  }

  if (
    schema.type !== "array" &&
    schema.type !== "object" &&
    !exampleMatchesType(schema.type, example)
  ) {
    issues.push(`${examplePath} 类型必须与 ${schemaPath}.type=${String(schema.type)} 一致`);
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(example)) {
      issues.push(`${examplePath} 必须是数组`);
      return;
    }
    if (!isObject(schema.items) || Object.keys(schema.items).length === 0) {
      issues.push(`${schemaPath}.items 必须完整描述数组元素`);
      return;
    }
    validateFieldSchemaMetadata(schema.items, `${schemaPath}.items`, issues);
    example.forEach((item, index) => validateSchemaExampleCoverage(
      schema.items as JsonObject,
      item,
      `${schemaPath}.items`,
      `${examplePath}[${index}]`,
      issues,
      false,
      true,
    ));
    return;
  }

  if (schema.type !== "object") return;
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const additionalPropertiesValue = schema.additionalProperties;
  const additionalProperties = isObject(additionalPropertiesValue) ? additionalPropertiesValue : undefined;
  const allowsOpaqueProperties = additionalPropertiesValue === true;
  if (
    hasOwn(schema, "additionalProperties") &&
    typeof additionalPropertiesValue !== "boolean" &&
    !additionalProperties
  ) {
    issues.push(`${schemaPath}.additionalProperties 必须是布尔值或对象 Schema`);
  }
  if (!properties && !additionalProperties && !allowsOpaqueProperties) {
    issues.push(`${schemaPath} 必须使用 properties 描述固定字段、使用 additionalProperties 描述同构动态键，或对原样透传且结构未知的上游 JSON 使用 additionalProperties=true`);
    return;
  }
  if (!isObject(example)) {
    issues.push(`${examplePath} 必须是对象，并与 ${schemaPath}.properties 逐层对应`);
    return;
  }

  if (additionalProperties) {
    validateFieldSchemaMetadata(additionalProperties, `${schemaPath}.additionalProperties`, issues);
  }

  if (properties) {
    const requiredFields = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((field): field is string => typeof field === "string")
        : [],
    );
    for (const [key, propertySchema] of Object.entries(properties)) {
      const propertyPath = `${schemaPath}.properties.${key}`;
      if (!isObject(propertySchema)) {
        issues.push(`${propertyPath} 必须是对象 Schema，并填写 type、description、example`);
        continue;
      }
      validateFieldSchemaMetadata(propertySchema, propertyPath, issues);
      if (!hasOwn(example, key)) {
        if (requiredFields.has(key)) {
          issues.push(`${examplePath} 缺少 required 字段 ${key}`);
        }
      } else {
        validateSchemaExampleCoverage(propertySchema, example[key], propertyPath, `${examplePath}.${key}`, issues, false, true);
      }
    }
  }
  for (const [key, value] of Object.entries(example)) {
    if (properties && hasOwn(properties, key)) continue;
    if (additionalProperties) {
      validateSchemaExampleCoverage(
        additionalProperties,
        value,
        `${schemaPath}.additionalProperties`,
        `${examplePath}.${key}`,
        issues,
        false,
        true,
      );
    } else if (allowsOpaqueProperties) {
      continue;
    } else {
      issues.push(`${schemaPath}.properties 缺少字段 ${key} 的 Schema 描述`);
    }
  }
}

const schemaKeywordPattern = /^\$?[A-Za-z][A-Za-z0-9_.-]*$/;

function validateSchemaKeywordNames(schema: JsonObject, path: string, issues: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!schemaKeywordPattern.test(key)) {
      issues.push(`${path}.${key} 不是合法的 JSON Schema 关键字`);
    }
  }

  if (isObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (isObject(propertySchema)) {
        validateSchemaKeywordNames(propertySchema, `${path}.properties.${name}`, issues);
      }
    }
  }
  if (isObject(schema.items)) {
    validateSchemaKeywordNames(schema.items, `${path}.items`, issues);
  }
  if (isObject(schema.additionalProperties)) {
    validateSchemaKeywordNames(schema.additionalProperties, `${path}.additionalProperties`, issues);
  }
}

function validateDeclaredSchemaExamples(schema: JsonObject, path: string, issues: string[]): void {
  if (hasOwn(schema, "example")) {
    validateSchemaExampleCoverage(
      schema,
      schema.example,
      path,
      `${path}.example`,
      issues,
      false,
      true,
    );
  }

  if (isObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (isObject(propertySchema)) {
        validateDeclaredSchemaExamples(propertySchema, `${path}.properties.${name}`, issues);
      }
    }
  }
  if (isObject(schema.items)) {
    validateDeclaredSchemaExamples(schema.items, `${path}.items`, issues);
  }
  if (isObject(schema.additionalProperties)) {
    validateDeclaredSchemaExamples(schema.additionalProperties, `${path}.additionalProperties`, issues);
  }
}

function validateSchemaAndExample(object: JsonObject, path: string, issues: string[]): void {
  if (object.content_type !== "application/json") {
    issues.push(`${path}.content_type 必须是 application/json`);
  }
  if (!isObject(object.schema) || Object.keys(object.schema).length === 0) {
    issues.push(`${path}.schema 必须填写非空的响应体或请求体 JSON Schema`);
  }
  if (!hasOwn(object, "example")) {
    issues.push(`${path}.example 必须填写与 schema 一致的完整示例值`);
  }
  if (isObject(object.schema)) {
    validateSchemaKeywordNames(object.schema, `${path}.schema`, issues);
    validateDeclaredSchemaExamples(object.schema, `${path}.schema`, issues);
    if (hasOwn(object, "example")) {
      validateSchemaExampleCoverage(object.schema, object.example, `${path}.schema`, `${path}.example`, issues);
    }
  }
}

function validateParameters(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(`${path} 如填写必须是数组`);
    return;
  }
  value.forEach((parameter, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(parameter)) {
      issues.push(`${itemPath} 必须是对象`);
      return;
    }
    rejectUnsupportedFields(
      parameter,
      ["name", "type", "required", "description", "example", "default", "format", "enum_values"],
      itemPath,
      issues,
    );
    requireText(parameter, "name", itemPath, issues);
    requireText(parameter, "description", itemPath, issues);
    if (!["string", "integer", "number", "boolean", "array", "object"].includes(String(parameter.type))) {
      issues.push(`${itemPath}.type 必须填写支持的参数类型`);
    }
    if (typeof parameter.required !== "boolean") {
      issues.push(`${itemPath}.required 必须是布尔值`);
    }
    if (!hasOwn(parameter, "example")) {
      issues.push(`${itemPath}.example 必须填写具体示例值`);
    }
  });
}

function validateUsageRefs(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push("interface_doc.usage_refs 如填写必须是对象数组");
    return;
  }
  if (value.length > 100) {
    issues.push("interface_doc.usage_refs 最多填写 100 项");
  }
  value.forEach((usageRef, index) => {
    const path = `interface_doc.usage_refs[${index}]`;
    if (!isObject(usageRef)) {
      issues.push(`${path} 必须是对象`);
      return;
    }
    requireText(usageRef, "app_name", path, issues);
    for (const key of ["app_id", "location", "note"]) {
      if (usageRef[key] !== undefined && typeof usageRef[key] !== "string") {
        issues.push(`${path}.${key} 如填写必须是字符串`);
      }
    }
    for (const key of Object.keys(usageRef)) {
      if (!["app_id", "app_name", "location", "note"].includes(key)) {
        issues.push(`${path}.${key} 不是支持的字段`);
      }
    }
  });
}

function rejectInternalInputTerms(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInternalInputTerms(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (
      documentationProseKeys.has(key) &&
      typeof item === "string" &&
      internalInputTermPattern.test(item)
    ) {
      issues.push(`${itemPath} 面向接口调用方，不得出现 input.query/input.header/input.body/input.cookies 等平台内部结构`);
    }
    if (!documentationValueKeys.has(key)) {
      rejectInternalInputTerms(item, itemPath, issues);
    }
  }
}

export function interfaceDocCompletenessIssues(
  document: unknown,
  operation: "create" | "update",
): string[] {
  const issues: string[] = [];
  if (!isObject(document)) return ["interface_doc 必须是 JSON 对象"];

  rejectInternalInputTerms(document, "interface_doc", issues);
  rejectUnsupportedFields(
    document,
    ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description", "usage_refs"],
    "interface_doc",
    issues,
  );

  if (document.schema_version !== "script-interface-doc.v1") {
    issues.push("interface_doc.schema_version 必须是 script-interface-doc.v1");
  }
  requireText(document, "title", "interface_doc", issues);
  requireText(document, "summary", "interface_doc", issues);
  requireText(document, "logic_description", "interface_doc", issues, 20);
  validateUsageRefs(document.usage_refs, issues);

  let methods: unknown[] = [];
  if (!isObject(document.endpoint)) {
    issues.push("interface_doc.endpoint 必须是对象");
  } else {
    rejectUnsupportedFields(document.endpoint, ["methods", "path", "description"], "interface_doc.endpoint", issues);
    requireText(document.endpoint, "description", "interface_doc.endpoint", issues);
    if (!Array.isArray(document.endpoint.methods) || document.endpoint.methods.length === 0) {
      issues.push("interface_doc.endpoint.methods 必须包含 GET 或 POST");
    } else {
      methods = document.endpoint.methods;
      if (methods.some((method) => method !== "GET" && method !== "POST")) {
        issues.push("interface_doc.endpoint.methods 只能包含 GET 或 POST");
      }
    }
    if (operation === "update") {
      if (
        typeof document.endpoint.path !== "string" ||
        !document.endpoint.path.startsWith("/flow/codeblock/") ||
        document.endpoint.path.includes("{script_id}")
      ) {
        issues.push("更新脚本时 interface_doc.endpoint.path 必须填写实际 /flow/codeblock/{script_id} 路径");
      }
    } else if (
      document.endpoint.path !== undefined &&
      (typeof document.endpoint.path !== "string" || !document.endpoint.path.startsWith("/flow/codeblock/"))
    ) {
      issues.push("interface_doc.endpoint.path 如填写，必须以 /flow/codeblock/ 开头");
    }
  }

  const hasPost = methods.includes("POST");
  if (document.request === undefined) {
    // No request fields need documenting.
  } else if (!isObject(document.request)) {
    issues.push("interface_doc.request 如填写必须是对象");
  } else {
    rejectUnsupportedFields(document.request, ["query", "headers", "body"], "interface_doc.request", issues);
    validateParameters(document.request.query, "interface_doc.request.query", issues);
    validateParameters(document.request.headers, "interface_doc.request.headers", issues);
    if (document.request.body !== undefined) {
      if (!hasPost) {
        issues.push("仅 GET 接口不应填写 interface_doc.request.body");
      } else if (!isObject(document.request.body)) {
        issues.push("interface_doc.request.body 如填写必须是对象");
      } else {
        rejectUnsupportedFields(
          document.request.body,
          ["content_type", "schema", "example"],
          "interface_doc.request.body",
          issues,
        );
        validateSchemaAndExample(document.request.body, "interface_doc.request.body", issues);
      }
    }
  }

  if (!Array.isArray(document.responses) || document.responses.length === 0) {
    issues.push("interface_doc.responses 必须至少包含一个完整响应");
  } else {
    document.responses.forEach((response, index) => {
      const path = `interface_doc.responses[${index}]`;
      if (!isObject(response)) {
        issues.push(`${path} 必须是对象`);
        return;
      }
      rejectUnsupportedFields(response, ["status", "description", "content_type", "schema", "example"], path, issues);
      if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) {
        issues.push(`${path}.status 必须是 100-599 的整数`);
      }
      requireText(response, "description", path, issues);
      validateSchemaAndExample(response, path, issues);
    });
  }

  return [...new Set(issues)];
}

export function assertCompleteInterfaceDoc(document: unknown, operation: "create" | "update"): void {
  const issues = interfaceDocCompletenessIssues(document, operation);
  if (issues.length > 0) {
    throw new Error(
      `interface_doc 完整性校验失败：\n- ${issues.join("\n- ")}\n修复方式：\n- ${interfaceDocRepairRules.join("\n- ")}\n完整性规则：\n- ${interfaceDocNestedRules.join("\n- ")}`,
    );
  }
}
