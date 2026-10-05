import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../index.js';
import type { AgentTranscriptParser } from '../parsers/types.js';
import { createCliAgent, taskDurationMs } from './engine.js';
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
      copyToHost: async () => {},
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
  let home: string;

  beforeEach(() => {
    process.env[API_KEY_ENV_VAR] = 'k';
    home = mkdtempSync(join(tmpdir(), 'engine-session-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs a fake CLI whose sandbox is local bash with HOME set to `home`. */
  async function runWithSessionDir(sessionDir: string): Promise<string> {
    const runner: AgentRunner = {
      id: 'claude-code',
      displayName: 'Fake CLI',
      apiKeyEnvVar: API_KEY_ENV_VAR,
      cliPackage: 'fake-cli',
      defaultCliVersion: '1.0.0',
      defaultModel: 'fake-model',
      sessionDir,
      install: async () => {},
      exec: async () => ({ command: ok, raw: '' }),
    };
    const sessionArchivePath = join(home, 'run-1/session-archive.tar.gz');
    await createCliAgent(runner, parser, { model: 'fake-model' }).run({
      systemPrompt: '',
      userPrompt: 'the task',
      timeoutSec: 1,
      sessionArchivePath,
      sandbox: {
        workspace: home,
        exec: async (command) => {
          const r = spawnSync('bash', ['-c', command], {
            encoding: 'utf8',
            env: { ...process.env, HOME: home },
          });
          return {
            ok: r.status === 0,
            exitCode: r.status ?? 1,
            stdout: r.stdout,
            stderr: r.stderr,
          };
        },
        readFile: async () => '',
        copyToHost: async (path, hostDir) => {
          cpSync(path, hostDir, { recursive: true });
        },
      },
    });
    return sessionArchivePath;
  }

  it('archives sessionDir to sessionArchivePath', async () => {
    mkdirSync(join(home, 'sessions/subagents'), { recursive: true });
    writeFileSync(join(home, 'sessions/subagents/agent-1.jsonl'), '{}\n');
    writeFileSync(join(home, 'sessions/auth.json'), '{}\n');

    const listing = execFileSync(
      'tar',
      ['-tzf', await runWithSessionDir(`${home}/sessions`)],
      { encoding: 'utf8' }
    );
    expect(listing).toContain('./subagents/agent-1.jsonl');
    // OpenCode keeps API keys in auth.json. https://opencode.ai/docs/troubleshooting/
    expect(listing).not.toContain('auth.json');
  });

  it('drops a stale archive when archiving fails', async () => {
    mkdirSync(join(home, 'run-1'), { recursive: true });
    writeFileSync(join(home, 'run-1/session-archive.tar.gz'), 'stale');

    const sessionArchivePath = await runWithSessionDir(`${home}/missing`);
    expect(existsSync(sessionArchivePath)).toBe(false);
  });
});

describe('taskDurationMs', () => {
  const transcript = [
    {
      type: 'message' as const,
      role: 'assistant' as const,
      content: 'a',
      ts: 1_500,
    },
    {
      type: 'tool_call' as const,
      name: 'Bash',
      input: {},
      ts: 2_000,
      resultTs: 9_000,
    },
    {
      type: 'message' as const,
      role: 'assistant' as const,
      content: 'b',
      ts: 8_000,
    },
  ];

  it('spans the prompt to the latest event, including tool results', () => {
    expect(taskDurationMs(transcript, 1_000)).toBe(8_000);
  });

  it('is undefined without a prompt time or event times', () => {
    expect(taskDurationMs(transcript, undefined)).toBeUndefined();
    expect(
      taskDurationMs(
        [{ type: 'message', role: 'assistant', content: 'a' }],
        1_000
      )
    ).toBeUndefined();
  });
});
