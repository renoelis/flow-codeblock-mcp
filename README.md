# flow-codeblock-mcp

Local stdio MCP server and Codex Skill for Flow Codeblock. The MCP server calls the Flow Codeblock Rust REST API; it never executes user JavaScript on the user's computer. User code runs in the server's pinned Bun Supervisor.

## Installation

The deployed Flow Codeblock service runs Bun 1.4.1. The local MCP server requires Bun 1.4.0 or newer:

```bash
bunx --bun flow-codeblock-mcp@0.3.12
```

Required environment:

```bash
FLOW_CODEBLOCK_BASE_URL=https://qingcode.oalite.com
FLOW_CODEBLOCK_TOKEN=flow_xxx
# Optional default owner email for ownership operations
FLOW_CODEBLOCK_OWNER_EMAIL=owner@example.com
# Optional default owner name for first lock/claim
FLOW_CODEBLOCK_OWNER_NAME=Default Owner
```

`FLOW_CODEBLOCK_BASE_URL` is the deployed Flow Codeblock Rust API base URL and the base for returned call URLs. Non-script tools return `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock` as `execution_url`; script create, update, and execution tools return `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock/{script_id}` as `script_url`. Other management tools do not return a call URL. Use `https://qingcode.oalite.com` for the public service, or the matching localhost URL for a local Rust deployment. Store the token in the client's environment or secret manager; never put it in prompts, tool arguments, or public files.

When `FLOW_CODEBLOCK_OWNER_EMAIL` is configured, current-owner email arguments for challenge, lock, unlock, release, and transfer authorization may be omitted. Explicit arguments win. The new owner email in a transfer confirmation is always required. When `FLOW_CODEBLOCK_OWNER_NAME` is configured, `flow_lock_script.owner_name` may be omitted; `new_owner_name` in transfers is always required.

## Generic stdio configuration

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.3.12"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://qingcode.oalite.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>",
        "FLOW_CODEBLOCK_OWNER_EMAIL": "owner@example.com",
        "FLOW_CODEBLOCK_OWNER_NAME": "Default Owner"
      }
    }
  }
}
```

The npm package includes the MCP runtime, the `flow-codeblock` Skill, `AGENT_PROMPT.md`, the default module blacklist snapshot, dangerous-pattern rules, and interface-document Schemas. The default snapshot is guidance; the running Flow Codeblock service remains authoritative after startup configuration changes. Ordinary MCP clients do not install the Codex Skill automatically; `flow_write_code` reads the packaged authoring, module-blacklist, and dangerous-pattern rules at runtime and returns them.

## Calling rules

- Call `flow_write_code` before writing code. Non-script code reads `input.<field>`; script code reads `input.query/header/body/cookies` internally.
- After every non-script generation, fix, or update, return the complete latest JavaScript source; never return only a patch, fragment, explanation, or execution result.
- Script changes require `flow_preview_script_change`, display of the successful preview, explicit user confirmation, and then `flow_apply_script_change`. Code-only updates may omit `interface_doc` and `interface_doc_patch`, preserving the current interface document. A successful preview already contains all normalizations and does not need a second preview.
- Use `flow_get_script` with only `script_id` for the current version. Use history tools only for an explicitly requested version. The MCP server decodes valid `code_base64` to UTF-8 `code`.
- POST script execution receives the caller's business JSON directly as `body`; do not wrap it in `input` or `input.body`.
- Third-party API keys are business inputs supplied through the documented body, query, or business headers. User code must not read `process.env`; `FLOW_CODEBLOCK_TOKEN` is platform authentication only.
- In `interface_doc.usage_refs`, `app_name`, `app_id`, `location`, and `note` are strings; quote numeric-looking IDs such as `"98701"`.
- All JSON outputs recursively redact credential fields such as `token`, `access_token`, `authorization`, `refresh_token`, and `qingcodeToken`. Statistics such as `token_cache` and `unique_tokens` are not credentials.
- Release ownership by requesting a `release` challenge first, then using the same script, email, and code; the script must be unlocked. MCP has no deletion tool. Deletion requires the web UI or REST API after unlock and ownership release.
- Execution performs normal authentication, rate limiting, quota accounting, security validation, auditing, and statistics.

## License

MIT
