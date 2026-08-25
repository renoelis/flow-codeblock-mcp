import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requestTargets: string[] = [];
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requestTargets.push(`${url.pathname}${url.search}`);
    return Response.json({ success: true, data: {} });
  },
});

const client = new Client({ name: "flow-codeblock-script-read-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_script_read_test",
  },
  stderr: "pipe",
});

beforeAll(async () => {
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await apiServer.stop(true);
});

describe("script read tool routes", () => {
  test("keeps current reads version-free and adds version only for explicit history tools", async () => {
    await client.callTool({ name: "flow_get_script", arguments: { script_id: "script-current" } });
    await client.callTool({
      name: "flow_get_script_version",
      arguments: { script_id: "script-history", version: 3 },
    });
    await client.callTool({
      name: "flow_get_script_documentation",
      arguments: { script_id: "document-current" },
    });
    await client.callTool({
      name: "flow_get_script_documentation_version",
      arguments: { script_id: "document-history", version: 2 },
    });

    expect(requestTargets).toEqual([
      "/flow/scripts/script-current",
      "/flow/scripts/script-history?version=3",
      "/flow/scripts/document-current/documentation",
      "/flow/scripts/document-history/documentation?version=2",
    ]);
  });
});
