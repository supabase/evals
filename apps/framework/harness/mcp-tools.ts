import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolSet } from "ai";
import type { AgentMode } from "./types.js";

const MCP_SERVER_VERSION = "0.8.1";

export interface McpToolsHandle {
  tools: ToolSet;
  close: () => Promise<void>;
}

export async function createMcpTools(
  mode: AgentMode,
  port: number,
  accessToken: string
): Promise<McpToolsHandle> {
  return mode === "mcp"
    ? createSupabaseMcpTools(port, accessToken)
    : createExecutorTools(port, accessToken);
}

async function createSupabaseMcpTools(
  port: number,
  accessToken: string
): Promise<McpToolsHandle> {
  const transport = new StdioMCPTransport({
    command: "npx",
    args: [
      `@supabase/mcp-server-supabase@${MCP_SERVER_VERSION}`,
      "--access-token",
      accessToken,
      "--api-url",
      `http://localhost:${port}`,
      "--features",
      "account,database,development,debugging,functions",
    ],
    stderr: "ignore",
  });
  const mcp = await createMCPClient({ transport });
  const tools = await mcp.tools();
  return { tools, close: () => mcp.close() };
}

async function createExecutorTools(
  port: number,
  accessToken: string
): Promise<McpToolsHandle> {
  const scopeDir = mkdtempSync(join(tmpdir(), "eval-executor-scope-"));
  const dataDir = mkdtempSync(join(tmpdir(), "eval-executor-data-"));

  writeFileSync(
    join(scopeDir, "executor.jsonc"),
    JSON.stringify({
      sources: [
        {
          kind: "openapi",
          namespace: "platform",
          spec: `http://localhost:${port}/openapi.json`,
          baseUrl: `http://localhost:${port}`,
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      ],
    })
  );

  const transport = new StdioMCPTransport({
    command: "executor",
    args: ["mcp", "--scope", scopeDir],
    env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
    stderr: "ignore",
  });

  const mcp = await createMCPClient({ transport });
  const tools = await mcp.tools();
  return { tools, close: () => mcp.close() };
}
