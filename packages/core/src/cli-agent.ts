/**
 * CLI-agent harnesses.
 *
 * `aiSdkAgent` drives the model loop in-process: we own the tools and record
 * the transcript as it happens. A CLI agent (Claude Code, and later Codex /
 * Gemini CLI / …) is the opposite — its own harness with its own tools, loop,
 * and MCP client. So we run it inside the eval sandbox and parse the transcript
 * it produces.
 *
 * Three concerns are split so each lives in one place:
 *   - runner (`./runners/<agent>.ts`): install + exec + permission flags + MCP
 *     config format/placement — everything CLI-shaped.
 *   - parser (`./parsers/<agent>.ts`): raw transcript → canonical events.
 *   - composition (here): `createCliAgent(runner, parser)` does the generic
 *     orchestration (stage prompts, rewrite MCP hosts, run, parse, adapt) and
 *     produces an `AgentHarness`.
 *
 * Adding an agent = a runner + a parser + a registry entry; the orchestration
 * never changes.
 */

import type { Model as AnthropicModel } from "@anthropic-ai/sdk/resources/messages";
import type { AgentHarness, AgentRunResult } from "./index.js";
import { adaptTranscript } from "./parsers/adapt.js";
import type { AgentTranscriptParser } from "./parsers/types.js";
import { claudeCodeParser } from "./parsers/claude-code.js";
import { claudeCodeRunner } from "./runners/claude-code.js";
import type { AgentRunner } from "./runners/types.js";
import {
  SCRATCH,
  SYSTEM_PROMPT_PATH,
  USER_PROMPT_PATH,
  processStopReason,
  rewriteLoopback,
  writeSandboxFile,
} from "./runners/shared.js";

export type {
  AgentSandbox,
  AgentRunner,
  RunnerExecArgs,
  RunnerExecResult,
} from "./runners/types.js";

/** Compose a runner + parser into an `AgentHarness`. */
export function createCliAgent<M extends string = string>(
  runner: AgentRunner<M>,
  parser: AgentTranscriptParser,
  options: { model: M; cliVersion?: string },
): AgentHarness {
  const version = options.cliVersion ?? runner.defaultCliVersion;
  return {
    id: runner.id,
    modelId: options.model,
    requiresSandbox: true,
    // Tools mode requires confining the CLI to the MCP surface; only runners
    // that can do so support it.
    supportsToolsMode: runner.canRestrictToMcp,
    assertReady() {
      requireApiKey(runner);
    },
    async run(args): Promise<AgentRunResult> {
      const apiKey = requireApiKey(runner);
      const sandbox = args.sandbox;
      if (!sandbox) {
        throw new Error(
          `${runner.displayName} is a CLI agent and needs a sandbox to run in. ` +
            `It runs against local-stack evals (and, when it can be confined to MCP, tools mode).`,
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
        restrictToMcp: args.restrictToMcp ?? false,
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

/** Claude Code as an `AgentHarness`. */
export function claudeCodeAgent(
  options: {
    /** Anthropic model id (typed from `@anthropic-ai/sdk`). Defaults to Sonnet. */
    model?: AnthropicModel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {},
): AgentHarness {
  return createCliAgent(claudeCodeRunner, claudeCodeParser, {
    model: options.model ?? claudeCodeRunner.defaultModel,
    cliVersion: options.cliVersion,
  });
}
