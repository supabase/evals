import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('createCliAgent session archive', () => {
  beforeEach(() => {
    process.env[API_KEY_ENV_VAR] = 'k';
  });

  it("returns a gzipped tar of the runner's sessionDir", async () => {
    const home = mkdtempSync(join(tmpdir(), 'engine-session-'));
    mkdirSync(join(home, 'sessions/subagents'), { recursive: true });
    writeFileSync(join(home, 'sessions/subagents/agent-1.jsonl'), '{}\n');
    const runner: AgentRunner = {
      id: 'claude-code',
      displayName: 'Fake CLI',
      apiKeyEnvVar: API_KEY_ENV_VAR,
      cliPackage: 'fake-cli',
      defaultCliVersion: '1.0.0',
      defaultModel: 'fake-model',
      sessionDir: `${home}/sessions`,
      install: async () => {},
      exec: async () => ({ command: ok, raw: '' }),
    };

    const { sessionArchive } = await createCliAgent(runner, parser, {
      model: 'fake-model',
    }).run({
      systemPrompt: '',
      userPrompt: 'the task',
      timeoutSec: 1,
      sandbox: {
        workspace: home,
        exec: async (command) => {
          const r = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
          return {
            ok: r.status === 0,
            exitCode: r.status ?? 1,
            stdout: r.stdout,
            stderr: r.stderr,
          };
        },
        readFile: async () => '',
      },
    });

    const archivePath = join(home, 'out.tar.gz');
    writeFileSync(archivePath, sessionArchive ?? '');
    expect(
      execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    ).toContain('./subagents/agent-1.jsonl');
  });
});
