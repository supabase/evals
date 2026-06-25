/**
 * CLI-agent engine — the generic orchestration shared by every CLI agent.
 *
 * `aiSdkAgent` drives the model loop in-process: we own the tools and record
 * the transcript as it happens. A CLI agent (Claude Code, Codex, …) is the
 * opposite — its own harness with its own tools, loop, and MCP client. So we
 * run it inside the eval sandbox and parse the transcript it produces.
 *
 * Three concerns are split so each lives in one place:
 *   - runner (`./<agent>/runner.ts`): install + exec + permission flags + MCP
 *     config format/placement — everything CLI-shaped.
 *   - parser (`./<agent>/parser.ts`): raw transcript → canonical events.
 *   - composition (here): `createCliAgent(runner, parser)` does the generic
 *     orchestration (stage prompts, rewrite MCP hosts, run, parse, adapt) and
 *     produces an `AgentHarness`.
 *
 * Each agent's `./<agent>/index.ts` wires its own runner + parser into a public
 * factory by calling `createCliAgent`. This engine knows nothing about any
 * specific agent, so adding one never touches this file.
 */

import type { AgentHarness, AgentRunResult } from "../index.js";
import { adaptTranscript } from "../parsers/adapt.js";
import type { AgentTranscriptParser } from "../parsers/types.js";
import type { AgentRunner } from "./types.js";
import {
  SCRATCH,
  SYSTEM_PROMPT_PATH,
  USER_PROMPT_PATH,
  processStopReason,
  rewriteLoopback,
  writeSandboxFile,
} from "./shared.js";

/** Compose a runner + parser into an `AgentHarness`. */
export function createCliAgent<M extends string = string>(
  runner: AgentRunner<M>,
  parser: AgentTranscriptParser,
  options: { model: M; cliVersion?: string; reasoningEffort?: string },
): AgentHarness {
  const version = options.cliVersion ?? runner.defaultCliVersion;
  return {
    id: runner.id,
    modelId: options.model,
    runsInSandbox: true,
    assertReady() {
      requireApiKey(runner);
    },
    async run(args): Promise<AgentRunResult> {
      const apiKey = requireApiKey(runner);
      const sandbox = args.sandbox;
      if (!sandbox) {
        throw new Error(
          `${runner.displayName} is a CLI agent and needs a sandbox to run in.`,
        );
      }

      await runner.install(sandbox, version, apiKey);

      // Stage the prompts into the sandbox scratch dir (outside the workspace).
      await sandbox.exec(`mkdir -p ${SCRATCH}`);
      await writeSandboxFile(sandbox, SYSTEM_PROMPT_PATH, args.systemPrompt);
      await writeSandboxFile(sandbox, USER_PROMPT_PATH, args.userPrompt);

      const { command, raw } = await runner.exec({
        sandbox,
        model: options.model,
        apiKey,
        systemPromptPath: SYSTEM_PROMPT_PATH,
        userPromptPath: USER_PROMPT_PATH,
        // Rewrite loopback hosts so in-container MCP servers can reach host-side
        // platform-lite; the runner writes them in its own config format.
        mcpServers: rewriteLoopback(args.mcpServers ?? {}),
        reasoningEffort: options.reasoningEffort,
        timeoutSec: args.timeoutSec,
      });

      const { events } = raw ? parser.parseTranscript(raw) : { events: [] };
      const adapted = adaptTranscript(events);

      return {
        // The final report is the transcript's closing assistant message — the
        // CLI's stdout is JSONL, not prose.
        agentReport: adapted.agentReport,
        toolCalls: adapted.toolCalls,
        transcript: adapted.transcript,
        steps: adapted.steps,
        stoppedReason: runner.deriveStopReason?.(raw, command) ?? processStopReason(command),
      };
    },
  };
}

function requireApiKey(runner: AgentRunner): string {
  const apiKey = process.env[runner.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Missing ${runner.displayName} credentials. Set ${runner.apiKeyEnvVar} before running ${runner.id} evals.`,
    );
  }
  return apiKey;
}
