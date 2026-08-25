import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ApiRequest = {
  accessToken: string | null;
  body: unknown;
  method: string;
  path: string;
};

const apiRequests: ApiRequest[] = [];
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const bodyText = await request.text();
    apiRequests.push({
      accessToken: request.headers.get("accessToken"),
      body: bodyText ? JSON.parse(bodyText) : null,
      method: request.method,
      path: `${url.pathname}${url.search}`,
    });
    return Response.json({ success: true, data: { is_locked: false, owner_email_hint: null } });
  },
});

const client = new Client({ name: "flow-codeblock-ownership-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_ownership_test",
    FLOW_CODEBLOCK_OWNER_EMAIL: "owner@example.com",
    FLOW_CODEBLOCK_OWNER_NAME: "Default Owner",
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

describe("script ownership release tools", () => {
  test("requests a release challenge and confirms release against the matching API routes", async () => {
    await client.callTool({
      name: "flow_request_script_owner_challenge",
      arguments: {
        script_id: "script release",
        action: "release",
      },
    });
    await client.callTool({
      name: "flow_release_script_ownership",
      arguments: {
        script_id: "script release",
        code: "123456",
      },
    });

    expect(apiRequests).toEqual([
      {
        accessToken: "flow_ownership_test",
        body: { action: "release", email: "owner@example.com" },
        method: "POST",
        path: "/flow/scripts/script%20release/owner-challenge",
      },
      {
        accessToken: "flow_ownership_test",
        body: { email: "owner@example.com", code: "123456" },
        method: "POST",
        path: "/flow/scripts/script%20release/release-ownership",
      },
    ]);
  });

  test("prefers an explicitly supplied email over the configured default", async () => {
    await client.callTool({
      name: "flow_unlock_script",
      arguments: {
        script_id: "script explicit",
        email: "explicit@example.com",
        code: "654321",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { email: "explicit@example.com", code: "654321" },
      method: "POST",
      path: "/flow/scripts/script%20explicit/unlock",
    });
  });

  test("uses the configured owner name when locking without an owner_name", async () => {
    await client.callTool({
      name: "flow_lock_script",
      arguments: {
        script_id: "script default name",
        code: "123456",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { email: "owner@example.com", code: "123456", owner_name: "Default Owner" },
      method: "POST",
      path: "/flow/scripts/script%20default%20name/lock",
    });
  });

  test("prefers an explicitly supplied owner name over the configured default", async () => {
    await client.callTool({
      name: "flow_lock_script",
      arguments: {
        script_id: "script explicit name",
        code: "654321",
        owner_name: "Explicit Owner",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { email: "owner@example.com", code: "654321", owner_name: "Explicit Owner" },
      method: "POST",
      path: "/flow/scripts/script%20explicit%20name/lock",
    });
  });
});
