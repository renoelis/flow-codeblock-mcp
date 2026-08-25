const agentPromptSource = "skills/flow-codeblock/references/AGENT_PROMPT.md";
const interfaceDocSchemaSource = "skills/flow-codeblock/references/script-interface-doc.schema.json";
const interfaceDocPatchSchemaSource = "skills/flow-codeblock/references/script-interface-doc.patch.schema.json";
const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);

async function readRequiredReference(fileName: string): Promise<string> {
  const contents = await Bun.file(new URL(fileName, referencesDirectory)).text();
  if (contents.trim().length === 0) {
    throw new Error(`Flow Codeblock reference file is empty: ${fileName}`);
  }
  return contents;
}

export const agentPrompt = await readRequiredReference("AGENT_PROMPT.md");

const interfaceDocSchemaText = await readRequiredReference("script-interface-doc.schema.json");
export const interfaceDocSchema: unknown = (() => {
  try {
    return JSON.parse(interfaceDocSchemaText);
  } catch (error) {
    throw new Error(`Flow Codeblock interface document schema is invalid JSON: ${String(error)}`);
  }
})();

const interfaceDocPatchSchemaText = await readRequiredReference("script-interface-doc.patch.schema.json");
export const interfaceDocPatchSchema: unknown = (() => {
  try {
    return JSON.parse(interfaceDocPatchSchemaText);
  } catch (error) {
    throw new Error(`Flow Codeblock interface document patch schema is invalid JSON: ${String(error)}`);
  }
})();

export function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  includeFullSchema = false,
): Record<string, unknown> {
  const common = {
    contract_version: "flow-code-writer.v3",
    mode,
    requirement,
    mutates_or_executes: false,
    instruction: "必须完整遵守 authoritative_rules.content；它直接读取权威规则文件，不是摘要。",
    authoritative_rules: {
      source: agentPromptSource,
      content: agentPrompt,
    },
  };

  if (mode === "non_script") {
    return {
      ...common,
      next_tools: {
        execute_only_when_requested: "flow_execute_code",
      },
    };
  }

  return {
    ...common,
    interface_document_schema: {
      source: interfaceDocSchemaSource,
      included: includeFullSchema,
      ...(includeFullSchema ? { value: interfaceDocSchema } : {}),
      loading: includeFullSchema
        ? "已直接读取并返回权威 JSON Schema"
        : "需要原始 JSON Schema 时重新调用 flow_write_code，并设置 include_full_schema=true",
    },
    interface_document_patch_schema: {
      source: interfaceDocPatchSchemaSource,
      included: includeFullSchema,
      ...(includeFullSchema ? { value: interfaceDocPatchSchema } : {}),
      loading: includeFullSchema
        ? "已直接读取并返回 RFC 6902 JSON Patch Schema"
        : "更新已有脚本文档时可使用 interface_doc_patch；需要原始 Patch Schema 时重新调用 flow_write_code，并设置 include_full_schema=true",
    },
    next_tools: {
      preview_after_recursive_self_check: "flow_preview_script_change",
      apply_only_after_explicit_user_confirmation: "flow_apply_script_change",
      execute_after_create_when_requested: "flow_execute_script",
    },
  };
}
