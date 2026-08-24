import { describe, expect, test } from "bun:test";
import { codeWriterContext } from "./code-writer";

const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${key} must be an object`);
  }
  return field as Record<string, unknown>;
}

describe("codeWriterContext", () => {
  test("does not include preset business examples", () => {
    const context = codeWriterContext("script", "按用户需求创建接口");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("u_10001");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("complete_example");
  });

  test("requires user domain when presenting the final script URL", () => {
    const context = codeWriterContext("script", "按用户需求创建接口");
    expect(JSON.stringify(context)).toContain("用户提供的域名");
    expect(JSON.stringify(context)).toContain("/flow/codeblock/{{脚本ID}}");
  });

  test("returns AGENT_PROMPT.md verbatim as the authoritative rule source", async () => {
    const expectedPrompt = await Bun.file(new URL("AGENT_PROMPT.md", referencesDirectory)).text();
    const context = codeWriterContext("non_script", "处理输入");
    const authoritativeRules = objectField(context, "authoritative_rules");

    expect(context.contract_version).toBe("flow-code-writer.v3");
    expect(authoritativeRules.source).toBe("skills/flow-codeblock/references/AGENT_PROMPT.md");
    expect(authoritativeRules.content).toBe(expectedPrompt);
  });

  test("returns the parsed authoritative interface schema only when requested", async () => {
    const expectedSchema = JSON.parse(
      await Bun.file(new URL("script-interface-doc.schema.json", referencesDirectory)).text(),
    );
    const compactContext = codeWriterContext("script", "创建脚本");
    const fullContext = codeWriterContext("script", "创建脚本", true);
    const compactSchema = objectField(compactContext, "interface_document_schema");
    const fullSchema = objectField(fullContext, "interface_document_schema");

    expect(compactSchema.included).toBe(false);
    expect(compactSchema).not.toHaveProperty("value");
    expect(fullSchema.included).toBe(true);
    expect(fullSchema.value).toEqual(expectedSchema);
  });
});
