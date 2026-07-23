import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MCP_SERVER_VERSION, supabaseMcpServer } from "./index.js";

// Stub (not mutate) env so pre-existing SUPABASE_* values are restored per test.
function clearEnv() {
  vi.stubEnv("SUPABASE_MCP_SERVER_PATH", undefined);
}

// A real on-disk build layout: the override path is existence-checked, so the
// fixtures must actually exist for the happy paths (and not for the error one).
let fixtureDir: string;
let fixtureEntry: string;
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "mcp-override-"));
  fixtureEntry = join(fixtureDir, "dist", "transports", "stdio.js");
  mkdirSync(join(fixtureDir, "dist", "transports"), { recursive: true });
  writeFileSync(fixtureEntry, "");
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe("supabaseMcpServer().createConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the published package via npx", async () => {
    clearEnv();
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: "http://api.test",
    });
    expect(config.command).toBe("npx");
    expect(config.args[0]).toBe(
      `@supabase/mcp-server-supabase@${MCP_SERVER_VERSION}`,
    );
    expect(config.args).toContain("--api-url");
  });

  it("launches a local build dir with node when SUPABASE_MCP_SERVER_PATH is set", async () => {
    clearEnv();
    vi.stubEnv("SUPABASE_MCP_SERVER_PATH", fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.command).toBe(process.execPath);
    expect(config.args[0]).toBe(fixtureEntry);
  });

  it("uses a direct .js override path as-is", async () => {
    clearEnv();
    vi.stubEnv("SUPABASE_MCP_SERVER_PATH", fixtureEntry);
    const { config } = await supabaseMcpServer().createConfig({});
    expect(config.args[0]).toBe(fixtureEntry);
  });

  it("preserves --api-url on the local override path", async () => {
    clearEnv();
    vi.stubEnv("SUPABASE_MCP_SERVER_PATH", fixtureDir);
    const { config } = await supabaseMcpServer().createConfig({
      apiUrl: "http://api.test",
    });
    const i = config.args.indexOf("--api-url");
    expect(i).toBeGreaterThan(-1);
    expect(config.args[i + 1]).toBe("http://api.test");
  });

  it("fails fast with an actionable error when the override path does not exist", async () => {
    clearEnv();
    vi.stubEnv("SUPABASE_MCP_SERVER_PATH", join(fixtureDir, "not-built"));
    await expect(supabaseMcpServer().createConfig({})).rejects.toThrow(
      /does not exist.*build the server first/s,
    );
  });
});
