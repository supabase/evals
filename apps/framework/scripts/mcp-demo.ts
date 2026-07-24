/**
 * Minimal demo: platform-lite + supabase-mcp + AI SDK
 *
 * Starts platform-lite in-process, spawns the real supabase-mcp server
 * pointed at it via stdio, then runs a one-shot agent using the MCP tools.
 *
 * Usage:
 *   node --env-file=../../.env --import tsx/esm scripts/mcp-demo.ts
 */

import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { openai } from '@ai-sdk/openai';
import { generateText, stepCountIs } from 'ai';
import { createPlatform } from '@supabase-evals/platform-lite';
import { MCP_SERVER_VERSION } from '../harness/mcp-tools.js';

const ACCESS_TOKEN = 'demo-token';

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

await using platform = await createPlatform({
  accessToken: ACCESS_TOKEN,
  projects: [{ name: 'demo-project', sql: SEED_SQL }],
});

await using server = await platform.listen();
console.log(`platform-lite started at ${server.url}`);

// --- 2. Connect AI SDK MCP client → supabase-mcp → platform-lite ------------

const transport = new StdioMCPTransport({
  command: 'npx',
  args: [
    `@supabase/mcp-server-supabase@${MCP_SERVER_VERSION}`,
    '--access-token',
    ACCESS_TOKEN,
    '--api-url',
    server.url,
    '--features',
    'account,database,development,debugging,functions',
  ],
});

const mcp = await createMCPClient({ transport });
const tools = await mcp.tools();

console.log(`MCP tools available: ${Object.keys(tools).join(', ')}\n`);

// --- 4. Run a one-shot agent task -------------------------------------------

const { text, steps } = await generateText({
  model: openai('gpt-5.4-mini'),
  tools,
  stopWhen: stepCountIs(10),
  providerOptions: {
    openai: { store: false },
  },
  prompt:
    "List the projects, then query the todos table in the first project and give me a brief summary of what's there.",
});

console.log(`Agent completed in ${steps.length} step(s).\n`);
console.log('Response:\n', text);

// --- 5. Cleanup -------------------------------------------------------------

await mcp.close();
// server and platform disposed automatically via await using
