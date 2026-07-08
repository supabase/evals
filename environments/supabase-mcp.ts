import {
  defineEnvironment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

/**
 * The "with-what": the Supabase MCP tool surface + a local stack, and NO skills.
 * The baseline environment — reusable across any agent.
 */
export default defineEnvironment({
  runtime: platformLiteRuntime({ mcpServers: [supabaseMcpServer()] }),
  localStack: localStackRuntime(),
  skills: [],
});
