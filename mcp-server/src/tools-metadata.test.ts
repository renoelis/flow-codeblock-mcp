import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const expectedToolNames = [
  "flow_apply_script_change",
  "flow_confirm_ownership_transfer",
  "flow_execute_code",
  "flow_execute_script",
  "flow_get_script",
  "flow_get_script_documentation",
  "flow_list_scripts",
  "flow_lock_script",
  "flow_preview_script_change",
  "flow_request_script_owner_challenge",
  "flow_script_stats",
  "flow_start_ownership_transfer",
  "flow_token_info",
  "flow_unlock_script",
  "flow_write_code",
];

const client = new Client({ name: "flow-codeblock-metadata-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: "http://127.0.0.1:1",
    FLOW_CODEBLOCK_TOKEN: "flow_metadata_test",
  },
  stderr: "pipe",
});

let tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];

beforeAll(async () => {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
});

afterAll(async () => {
  await client.close();
});

describe("MCP tool metadata", () => {
  test("publishes standalone server instructions and the complete safe tool set", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("不依赖 Skill");
    expect(instructions).toContain("先调用 flow_preview_script_change");
    expect(instructions).toContain("MCP 不提供删除工具");
    expect(tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames);
    expect(tools.some((tool) => tool.name.includes("delete"))).toBe(false);
  });

  test("every tool and exposed argument has an LLM-visible description", () => {
    for (const tool of tools) {
      expect(tool.title?.trim().length, `${tool.name} title`).toBeGreaterThan(0);
      expect(tool.description?.trim().length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();

      const properties = tool.inputSchema.properties ?? {};
      for (const [name, schema] of Object.entries(properties)) {
        const description = (schema as { description?: unknown }).description;
        expect(typeof description, `${tool.name}.${name} description type`).toBe("string");
        expect(String(description).trim().length, `${tool.name}.${name} description`).toBeGreaterThan(10);
      }
    }
  });

  test("publishes OpenAI-compatible email patterns", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const emailArguments = [
      ["flow_request_script_owner_challenge", "email"],
      ["flow_lock_script", "email"],
      ["flow_unlock_script", "email"],
      ["flow_start_ownership_transfer", "authorizer_email"],
      ["flow_start_ownership_transfer", "new_owner_email"],
      ["flow_confirm_ownership_transfer", "email"],
    ] as const;

    for (const [toolName, argumentName] of emailArguments) {
      const schema = byName.get(toolName)?.inputSchema.properties?.[argumentName] as
        | { format?: string; pattern?: string }
        | undefined;
      expect(schema?.format, `${toolName}.${argumentName} format`).toBe("email");
      expect(schema?.pattern, `${toolName}.${argumentName} pattern`).toBeDefined();
      for (const unsupported of ["(?=", "(?!", "(?<=", "(?<!", "*?", "+?", "??"]) {
        expect(
          schema!.pattern!.includes(unsupported),
          `${toolName}.${argumentName} unsupported regex token ${unsupported}`,
        ).toBe(false);
      }

      const pattern = new RegExp(schema!.pattern!);
      expect(pattern.test("owner.name+flow@example.com"), `${toolName}.${argumentName} valid email`).toBe(true);
      expect(pattern.test(".owner@example.com"), `${toolName}.${argumentName} leading dot`).toBe(false);
      expect(pattern.test("owner..name@example.com"), `${toolName}.${argumentName} repeated dot`).toBe(false);
    }
  });

  test("distinguishes both code input models and locks the preview/apply workflow", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("flow_write_code")?.description).toContain("AGENT_PROMPT.md 权威规则原文");
    expect(byName.get("flow_write_code")?.description).toContain("non_script 从全局 input.<业务字段>");
    expect(byName.get("flow_write_code")?.description).toContain("script 从 input.query/header/body/cookies");
    expect(byName.get("flow_execute_script")?.description).toContain("不要包装为 {input:...} 或 {body:...}");
    expect(byName.get("flow_execute_code")?.description).toContain("input 参数在此模式会原样成为全局 input");
    expect(byName.get("flow_preview_script_change")?.description).toContain("ip_whitelist=null 或 [] 表示清除");
    expect(byName.get("flow_apply_script_change")?.description).toContain("用户随后明确确认发布");

    const getScriptVersion = byName.get("flow_get_script")?.inputSchema.properties?.version as
      | { description?: string }
      | undefined;
    expect(getScriptVersion?.description).toContain("可选，默认省略");
    expect(getScriptVersion?.description).toContain("省略时查询脚本当前版本");
    expect(getScriptVersion?.description).toContain("仅在需要查看指定历史版本时传入");
    expect(getScriptVersion?.description).toContain("current_version 作为 expected_version");

    const interfaceDoc = byName.get("flow_preview_script_change")?.inputSchema.properties?.interface_doc as
      | { description?: string }
      | undefined;
    expect(interfaceDoc?.description).toContain("logic_description");
    expect(interfaceDoc?.description).toContain("request={query?,headers?,body?}");
    expect(interfaceDoc?.description).toContain("请求体或响应体的根 Schema 节点必须填写 type");
    expect(interfaceDoc?.description).toContain("items 本身必须填写 type、description 和 example");
    expect(byName.get("flow_apply_script_change")?.description).toContain("用户提供的公网域名 + /flow/codeblock/");
  });

  test("returns both authoritative files unchanged through the MCP transport", async () => {
    const response = await client.callTool({
      name: "flow_write_code",
      arguments: {
        mode: "script",
        requirement: "创建一个符合当前需求的脚本",
        include_full_schema: true,
      },
    });
    const textContent = response.content.find((item) => item.type === "text");
    if (!textContent || textContent.type !== "text") throw new Error("flow_write_code did not return text");
    const payload = JSON.parse(textContent.text) as Record<string, unknown>;
    const rules = payload.authoritative_rules as Record<string, unknown>;
    const schema = payload.interface_document_schema as Record<string, unknown>;
    const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);
    const expectedPrompt = await Bun.file(new URL("AGENT_PROMPT.md", referencesDirectory)).text();
    const expectedSchema = JSON.parse(
      await Bun.file(new URL("script-interface-doc.schema.json", referencesDirectory)).text(),
    );

    expect(rules.content).toBe(expectedPrompt);
    expect(schema.value).toEqual(expectedSchema);
  });
});
