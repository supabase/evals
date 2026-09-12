import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunResult, CommandResult } from '../index.js';
import type { AgentTranscriptParser } from '../parsers/types.js';
import { createCliAgent } from './engine.js';
import { USER_PROMPT_PATH } from './shared.js';
import type { AgentRunner } from './types.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };

const API_KEY_ENV_VAR = 'ENGINE_TEST_API_KEY';

/** A parser that reports one assistant message, so the engine stays quiet. */
const parser: AgentTranscriptParser = {
  parseTranscript: () => ({
    events: [{ type: 'message', role: 'assistant', content: 'done' }],
  }),
};

/**
 * Run a CLI agent against a fake sandbox, returning every command it ran in
 * the sandbox and whether the runner's `install` was reached.
 */
async function runWithSystemPrompt(
  systemPrompt: string,
  effects: { commands: string[]; installed: boolean } = {
    commands: [],
    installed: false,
  },
  parse: AgentTranscriptParser = parser
): Promise<typeof effects & { result: AgentRunResult }> {
  const runner: AgentRunner = {
    id: 'claude-code',
    displayName: 'Fake CLI',
    apiKeyEnvVar: API_KEY_ENV_VAR,
    cliPackage: 'fake-cli',
    defaultCliVersion: '1.0.0',
    defaultModel: 'fake-model',
    install: async () => {
      effects.installed = true;
    },
    exec: async () => ({ command: ok, raw: '' }),
  };
  const run = () =>
    createCliAgent(runner, parse, { model: 'fake-model' }).run({
      systemPrompt,
      userPrompt: 'the task',
      timeoutSec: 1,
      sandbox: {
        workspace: '/w',
        exec: async (command) => {
          effects.commands.push(command);
          return ok;
        },
        readFile: async () => '',
      },
    });
  const result = await run();
  return { ...effects, result };
}

describe('createCliAgent prompt staging', () => {
  // The engine requires the runner's API key before it stages anything.
  beforeEach(() => {
    process.env[API_KEY_ENV_VAR] = 'k';
  });

  it('stages only the user prompt', async () => {
    const { commands } = await runWithSystemPrompt('');
    expect(commands.some((c) => c.includes(USER_PROMPT_PATH))).toBe(true);
    expect(commands.some((c) => c.includes('system-prompt'))).toBe(false);
  });

  it('refuses a system prompt before touching the sandbox', async () => {
    // A CLI agent runs with its own prompt. The refusal comes before install
    // and staging, so a misconfigured experiment fails without paying for them.
    const effects = { commands: [], installed: false };
    await expect(
      runWithSystemPrompt('Extra framing.', effects)
    ).rejects.toThrow(/runs with its own system prompt/);
    expect(effects.commands).toEqual([]);
    expect(effects.installed).toBe(false);
  });

  it('seeds the initiating prompt when the parser never echoed it', async () => {
    // Codex's --json stream carries no user message, so without the seed the
    // trace starts at the first assistant reply with no visible initiator.
    const { result } = await runWithSystemPrompt('');
    expect(result.transcript[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'the task',
    });
    // ts is the real run-initiation time, so the trace viewer can place and
    // size the prompt span rather than rendering it untimed.
    expect(result.transcript[0]!.ts).toBeGreaterThan(0);
  });

  it('does not duplicate the prompt the parser already surfaced', async () => {
    // Claude Code echoes the user prompt into its JSONL, so the transcript
    // already opens with a user part — the seed must not add a second one.
    const echoParser: AgentTranscriptParser = {
      parseTranscript: () => ({
        events: [
          { type: 'message', role: 'user', content: 'the task' },
          { type: 'message', role: 'assistant', content: 'done' },
        ],
      }),
    };
    const { result } = await runWithSystemPrompt('', undefined, echoParser);
    expect(
      result.transcript.filter((p) => p.type === 'message' && p.role === 'user')
    ).toHaveLength(1);
  });
});
