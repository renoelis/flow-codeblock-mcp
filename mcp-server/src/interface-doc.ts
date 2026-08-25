type JsonObject = Record<string, unknown>;

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
  "请求体或响应体的根 Schema 节点必须填写 type；其所有嵌套 Schema 节点（包括 properties 字段、array.items 和 additionalProperties 的值 Schema）都必须填写 type、description 和 example。",
  "固定字段对象必须有 properties，并为每个字段填写名称、type、description、example；动态键字典必须用 additionalProperties 描述完整的值 Schema；二者不能同时缺失。",
  "每个 type=array 都必须有 items，且 items 本身必须填写 type、description 和 example；items.type=object 时还必须有完整 items.properties。数组 example 中的每个对象都必须覆盖 items.properties 的全部字段。",
  "任意层级 example 中出现的字段必须有对应 properties 或 additionalProperties；properties 中列入 required 的字段必须出现在 example 中，运行时可选字段可以省略。",
  "JSON Schema 的 required 只表示运行时真正必填的业务字段；成功和错误结构不同应拆成不同 responses。",
];

export const interfaceDocRepairRules = [
  "保留原 interface_doc 中未报错的字段，只修正错误列表指出的路径；不要为了修复单个字段而重写或删减 responses、logic_description 或 request。",
  "规范结构中 request.body 和每个 response 的 example 与 schema 同级；properties、required、items、additionalProperties 属于 schema。MCP 会兼容纠正常见错位、从父级或同名蛇形/驼峰别名补全可推导的节点 example，并移除 usage_refs 中无效的非对象说明。",
];

export const interfaceDocInputDescription = [
  "创建和代码更新时必填完整 script-interface-doc.v1；只改 description/ip_whitelist 时可省略。",
  "字段位置：根对象包含 schema_version='script-interface-doc.v1'、title、summary、endpoint、request?、responses、logic_description、usage_refs?；endpoint={methods,path?,description}；request={query?,headers?,body?}；query/headers 为 parameter 数组；body={content_type='application/json',schema,example}；responses 的每项={status,description,content_type='application/json',schema,example}。",
  "usage_refs 仅用于真实应用引用，每项必须是 {app_name,app_id?,location?,note?} 对象；普通说明写入 logic_description，不能把字符串数组放入 usage_refs。",
  `必填结构：${Object.entries(interfaceDocRequiredFields).map(([key, fields]) => `${key}=[${fields.join(",")}]`).join("；")}。`,
  ...interfaceDocRepairRules,
  ...interfaceDocNestedRules,
].join(" ");

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

export function normalizeInterfaceDocument(document: unknown): { document: unknown; changes: string[] } {
  if (!isObject(document)) return { document, changes: [] };

  const normalized = structuredClone(document) as JsonObject;
  const changes: string[] = [];
  normalizeUsageRefs(normalized, changes);
  if (isObject(normalized.request) && isObject(normalized.request.body)) {
    normalizeSchemaContainer(normalized.request.body, "interface_doc.request.body", changes);
  }
  if (Array.isArray(normalized.responses)) {
    normalized.responses.forEach((response, index) => {
      if (isObject(response)) {
        normalizeSchemaContainer(response, `interface_doc.responses[${index}]`, changes);
      }
    });
  }
  return { document: normalized, changes };
}

function requireText(object: JsonObject, key: string, path: string, issues: string[], minLength = 1): void {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length < minLength) {
    issues.push(`${path}.${key} 必须是至少 ${minLength} 个字符的非空字符串`);
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
  const additionalProperties = isObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
  if (!properties && !additionalProperties) {
    issues.push(`${schemaPath} 必须使用 properties 描述固定字段，或使用 additionalProperties 描述动态键的值 Schema`);
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
    } else {
      issues.push(`${schemaPath}.properties 缺少字段 ${key} 的 Schema 描述`);
    }
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
  if (isObject(object.schema) && hasOwn(object, "example")) {
    validateSchemaExampleCoverage(object.schema, object.example, `${path}.schema`, `${path}.example`, issues);
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
  if (typeof value === "string") {
    if (/\binput\.(?:query|header|body|cookies)\b/i.test(value)) {
      issues.push(`${path} 面向接口调用方，不得出现 input.query/input.header/input.body/input.cookies 等平台内部结构`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInternalInputTerms(item, `${path}[${index}]`, issues));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      rejectInternalInputTerms(item, `${path}.${key}`, issues);
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
    validateParameters(document.request.query, "interface_doc.request.query", issues);
    validateParameters(document.request.headers, "interface_doc.request.headers", issues);
    if (document.request.body !== undefined) {
      if (!hasPost) {
        issues.push("仅 GET 接口不应填写 interface_doc.request.body");
      } else if (!isObject(document.request.body)) {
        issues.push("interface_doc.request.body 如填写必须是对象");
      } else {
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
      if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) {
        issues.push(`${path}.status 必须是 100-599 的整数`);
      }
      requireText(response, "description", path, issues);
      validateSchemaAndExample(response, path, issues);
    });
  }

  return issues;
}

export function assertCompleteInterfaceDoc(document: unknown, operation: "create" | "update"): void {
  const issues = interfaceDocCompletenessIssues(document, operation);
  if (issues.length > 0) {
    throw new Error(
      `interface_doc 完整性校验失败：\n- ${issues.join("\n- ")}\n修复方式：\n- ${interfaceDocRepairRules.join("\n- ")}\n完整性规则：\n- ${interfaceDocNestedRules.join("\n- ")}`,
    );
  }
}
