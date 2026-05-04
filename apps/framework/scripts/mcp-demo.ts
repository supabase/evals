/**
 * Minimal demo: platform-lite + supabase-mcp + AI SDK
 *
 * Starts platform-lite in-process, spawns the real supabase-mcp server
 * pointed at it via stdio, then runs a one-shot agent using the MCP tools.
 *
 * Usage:
 *   node --env-file=../../.env --import tsx/esm scripts/mcp-demo.ts
 */

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { createApp, listen } from "platform-lite";

const ACCESS_TOKEN = "demo-token";

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
`;

// --- 1. Start platform-lite on a random port --------------------------------

const app = await createApp({
  accessToken: ACCESS_TOKEN,
  projects: [{ name: "demo-project", sql: SEED_SQL }],
});

const { port, close: closePlatform } = await listen(app, { port: 0 });
console.log(`platform-lite started on port ${port}`);

// --- 2. Connect AI SDK MCP client → supabase-mcp → platform-lite ------------

const transport = new Experimental_StdioMCPTransport({
  command: "npx",
  args: [
    "@supabase/mcp-server-supabase@0.7.0",
    "--access-token",
    ACCESS_TOKEN,
    "--api-url",
    `http://localhost:${port}`,
    "--features",
    "account,database,development,debugging,functions",
  ],
});

const mcp = await createMCPClient({ transport });
const tools = await mcp.tools();

console.log(`MCP tools available: ${Object.keys(tools).join(", ")}\n`);

// --- 4. Run a one-shot agent task -------------------------------------------

const { text, steps } = await generateText({
  model: anthropic("claude-haiku-4-5-20251001"),
  tools,
  stopWhen: stepCountIs(10),
  prompt:
    "List the projects, then query the todos table in the first project and give me a brief summary of what's there.",
});

console.log(`Agent completed in ${steps.length} step(s).\n`);
console.log("Response:\n", text);

// --- 5. Cleanup -------------------------------------------------------------

await mcp.close();
closePlatform();
process.exit(0);
