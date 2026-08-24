import { describe, expect, test } from "bun:test";

describe("MCP startup configuration", () => {
  test("rejects startup without FLOW_CODEBLOCK_BASE_URL", () => {
    const environment = { ...process.env, FLOW_CODEBLOCK_TOKEN: "flow_test" };
    delete environment.FLOW_CODEBLOCK_BASE_URL;
    const processResult = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/index.ts"],
      cwd: import.meta.dir.replace(/\/src$/, ""),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(processResult.exitCode).not.toBe(0);
    expect(processResult.stderr.toString()).toContain("FLOW_CODEBLOCK_BASE_URL is required");
  });
});
