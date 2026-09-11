import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../index.js';
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
  }
): Promise<typeof effects> {
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
  await createCliAgent(runner, parser, { model: 'fake-model' }).run({
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
  return effects;
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
});
