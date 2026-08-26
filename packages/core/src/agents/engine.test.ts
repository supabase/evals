import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../index.js';
import type { AgentTranscriptParser } from '../parsers/types.js';
import { createCliAgent } from './engine.js';
import { SYSTEM_PROMPT_PATH } from './shared.js';
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
 * Run a CLI agent against a fake sandbox, returning the `systemPromptPath` its
 * runner was handed plus every command the engine ran in the sandbox.
 */
async function runWithSystemPrompt(systemPrompt: string): Promise<{
  systemPromptPath: string | undefined;
  commands: string[];
}> {
  const commands: string[] = [];
  let systemPromptPath: string | undefined;
  const runner: AgentRunner = {
    id: 'claude-code',
    displayName: 'Fake CLI',
    apiKeyEnvVar: API_KEY_ENV_VAR,
    cliPackage: 'fake-cli',
    defaultCliVersion: '1.0.0',
    defaultModel: 'fake-model',
    install: async () => undefined,
    exec: async (args) => {
      systemPromptPath = args.systemPromptPath;
      return { command: ok, raw: '' };
    },
  };
  await createCliAgent(runner, parser, { model: 'fake-model' }).run({
    systemPrompt,
    userPrompt: 'the task',
    timeoutSec: 1,
    sandbox: {
      workspace: '/w',
      exec: async (command) => {
        commands.push(command);
        return ok;
      },
      readFile: async () => '',
    },
  });
  return { systemPromptPath, commands };
}

describe('createCliAgent prompt staging', () => {
  // The engine requires the runner's API key before it stages anything.
  beforeEach(() => {
    process.env[API_KEY_ENV_VAR] = 'k';
  });

  it('stages a system prompt and hands its path to the runner', async () => {
    const { systemPromptPath, commands } = await runWithSystemPrompt('Skills.');
    expect(systemPromptPath).toBe(SYSTEM_PROMPT_PATH);
    expect(commands.some((c) => c.includes(SYSTEM_PROMPT_PATH))).toBe(true);
  });

  it('stages no file at all when the harness has no system prompt', async () => {
    // The runner then omits its system-prompt plumbing, leaving the CLI's own
    // prompt untouched instead of pointing it at an empty file.
    const { systemPromptPath, commands } = await runWithSystemPrompt('');
    expect(systemPromptPath).toBeUndefined();
    expect(commands.some((c) => c.includes(SYSTEM_PROMPT_PATH))).toBe(false);
  });
});
