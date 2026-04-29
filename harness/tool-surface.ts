// Translate mgmt-api endpoint specs into AI SDK Core tools. Endpoint name
// `database.query` -> tool name `database_query` so the tool surface stays
// provider-neutral across Anthropic and OpenAI.

import { jsonSchema, tool, type ToolSet } from "ai";
import type { Endpoint, MgmtApiHandle } from "../shims/management-api.js";
import type { ToolCallRecord } from "./types.js";

export type AgentToolSet = ToolSet;

const toolNameFor = (endpoint: Endpoint): string => endpoint.replace(/\./g, "_");

const endpointFor = (toolName: string, allowed: Endpoint[]): Endpoint | undefined =>
  allowed.find((e) => toolNameFor(e) === toolName);

export function buildTools(
  mgmt: MgmtApiHandle,
  allowed: Endpoint[],
  toolCalls?: ToolCallRecord[]
): { tools: AgentToolSet; resolve: (toolName: string) => Endpoint | undefined } {
  const allEndpoints = mgmt.endpoints();
  const tools = Object.fromEntries(
    allEndpoints
      .filter((e) => allowed.includes(e.name))
      .map((e) => {
        const name = toolNameFor(e.name);
        return [
          name,
          tool({
            description: `${e.spec.description}\n\nMirrors: ${e.spec.http}`,
            inputSchema: jsonSchema(e.spec.inputSchema),
            execute: async (input) => {
              const rec: ToolCallRecord = {
                endpoint: e.name,
                body: (input as Record<string, unknown>) ?? {},
                ts: Date.now(),
              };
              try {
                const result = await mgmt.call(e.name, rec.body);
                rec.result = result;
                toolCalls?.push(rec);
                return result;
              } catch (error) {
                rec.error = error instanceof Error ? error.message : String(error);
                toolCalls?.push(rec);
                throw error;
              }
            },
          }),
        ] as const;
      })
  ) as AgentToolSet;

  return {
    tools,
    resolve: (toolName) => endpointFor(toolName, allowed),
  };
}
