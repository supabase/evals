/**
 * Demo: platform-lite + executor (code mode) + AI SDK
 *
 * Starts platform-lite in-process, writes a temp executor.jsonc pointing at
 * it, spawns `executor mcp --scope <tmpdir>` over stdio, then runs a
 * one-shot agent that writes JS to call the Management API rather than
 * invoking individual tools directly.
 *
 * Usage:
 *   node --env-file=../../.env --import tsx/esm scripts/executor-demo.ts
 */

import { createMCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"
import { anthropic } from "@ai-sdk/anthropic"
import { generateText, stepCountIs } from "ai"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, listen } from "platform-lite"

const ACCESS_TOKEN = "demo-token"

const SEED_SQL = `
  CREATE TABLE todos (
    id   serial primary key,
    task text    not null,
    done boolean not null default false
  );
  INSERT INTO todos (task, done) VALUES
    ('Enable RLS on the todos table', false),
    ('Write a migration for user profiles', false),
    ('Deploy edge function for notifications', true);
`

// --- 1. Start platform-lite on a random port --------------------------------

const app = await createApp({
  accessToken: ACCESS_TOKEN,
  projects: [{ name: "demo-project", sql: SEED_SQL }],
})

const { port, close: closePlatform } = await listen(app, { port: 0 })
console.log(`platform-lite started on port ${port}`)

// --- 2. Write executor.jsonc pointing at platform-lite ----------------------

const scopeDir = mkdtempSync(join(tmpdir(), "executor-demo-"))
writeFileSync(
  join(scopeDir, "executor.jsonc"),
  JSON.stringify({
    sources: [
      {
        kind: "openapi",
        namespace: "platform",
        spec: `http://localhost:${port}/openapi.json`,
        baseUrl: `http://localhost:${port}`,
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      },
    ],
  }),
)
console.log(`executor config written to ${scopeDir}`)

// --- 3. Spawn executor MCP server -------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), "executor-data-"))

const transport = new StdioMCPTransport({
  command: "executor",
  args: ["mcp", "--scope", scopeDir],
  env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
})

const mcp = await createMCPClient({ transport })
const tools = await mcp.tools()

console.log(`MCP tools available: ${Object.keys(tools).join(", ")}\n`)

// --- 4. Run one-shot agent --------------------------------------------------

const { text, steps } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  tools,
  stopWhen: stepCountIs(20),
  system:
    "When execute returns a paused result containing an executionId, immediately call resume with that executionId and action=accept.",
  onStepFinish({ toolResults }) {
    for (const result of toolResults) {
      if (result.toolName === "execute") {
        const input = result.input as { code?: string }
        if (input?.code) {
          console.log("--- execute ---")
          console.log(input.code)
          console.log("---------------\n")
        }
      }
      if (result.toolName === "resume") {
        const input = result.input as { executionId?: string; action?: string }
        console.log(`--- resume (${input?.action}) → executionId: ${input?.executionId} ---\n`)
      }
    }
  },
  prompt:
    "List the projects, then query the todos table in the first project and give me a brief summary of what's there.",
})

console.log(`Agent completed in ${steps.length} step(s).\n`)
console.log("Response:\n", text)

// --- 5. Cleanup -------------------------------------------------------------

await mcp.close()
closePlatform()
process.exit(0)
