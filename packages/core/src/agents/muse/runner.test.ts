import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../index.js';
import type { AgentSandbox } from '../types.js';
import {
  MUSE_ENV,
  MUSE_RELEASES,
  READ_SESSION_LOGS_SCRIPT,
  buildInstallScript,
  buildMuseSettings,
  museDownloadUrl,
  museRunner,
} from './runner.js';

const ok = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

const timedOut: CommandResult = {
  ok: false,
  exitCode: 124,
  stdout: '',
  stderr: '',
};

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/**
 * The echo provider can't serve Muse's reminder agents, so the real echo log's
 * verify-reminder child fails with `config_error`. The runner rightly rejects
 * that as an unfair run (see the first exec test); the other tests use the log
 * without that one record.
 */
const ECHO_AS_RECORDED = fixture('echo-session.jsonl');
const ECHO = ECHO_AS_RECORDED.split('\n')
  .filter((line) => !line.includes('"kind":"run_fatal_error_classified"'))
  .join('\n');
const MAIN = '11111111-1111-4111-8111-111111111111';
const CHILD = 'f2a2cdf2-dd92-480c-9c81-c334c8e5ac80';

/** A run event in `session`, appended after the real echo log. */
function event(
  session: string,
  sequence: number,
  runEvent: Record<string, unknown>
): string {
  return JSON.stringify({
    schema_version: 1,
    stream: { kind: 'session', id: session },
    sequence,
    recorded_at: 1_791_400_860_000_000 + sequence,
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload: { kind: 'run', event: runEvent },
  });
}

/** The echo run's log with more events appended. */
const echoWith = (...events: string[]) =>
  [ECHO.trimEnd(), ...events].join('\n');

/** The echo run's main log cut before its terminal event. */
const ECHO_UNFINISHED = ECHO.split('\n')
  .filter((line) => !line.includes('"kind":"terminal"'))
  .join('\n');

/** The echo run ending in a failure, after an optional error class. */
const failedRun = (errorClass?: string) =>
  echoWith(
    ...(errorClass
      ? [
          event(MAIN, 999, {
            kind: 'run_fatal_error_classified',
            error_class: errorClass,
          }),
        ]
      : []),
    event(MAIN, 1000, { kind: 'terminal', terminal: 'failed' })
  );

/**
 * A sandbox that records every command and answers from `respond`, which sees
 * each command in turn. Unmatched commands succeed with no output.
 */
function recordingSandbox(
  respond: (command: string) => CommandResult | undefined = () => undefined
) {
  const calls: { command: string; env?: Record<string, string> }[] = [];
  const sandbox: AgentSandbox = {
    workspace: '/workspace',
    async exec(command, options) {
      calls.push({ command, env: options?.env });
      return respond(command) ?? ok();
    },
    async readFile() {
      return '';
    },
    async copyToHost() {},
  };
  return { sandbox, calls };
}

/** Run `museRunner.exec` against a sandbox whose session logs are `logs`. */
async function execWith(options: {
  logs: string;
  run?: CommandResult;
  stderr?: string;
  reasoningEffort?: string;
}) {
  const { sandbox, calls } = recordingSandbox((command) => {
    if (command.startsWith('find ')) return ok('/sessions/2026/10/07/id\n');
    if (command.startsWith('node -e')) return ok(options.logs);
    if (command.includes(' exec ')) {
      return { ...(options.run ?? ok()), stderr: options.stderr ?? '' };
    }
    return undefined;
  });
  const result = await museRunner.exec({
    sandbox,
    model: 'muse-spark-1.3',
    apiKey: 'meta-test',
    userPromptPath: '"$HOME/.eval/user-prompt.txt"',
    mcpServers: {
      supabase: {
        command: 'npx',
        args: ['@supabase/mcp-server-supabase'],
        env: { SUPABASE_ACCESS_TOKEN: 'sbp_test' },
      },
    },
    reasoningEffort: options.reasoningEffort,
    timeoutSec: 60,
  });
  return { result, calls };
}

describe('buildInstallScript', () => {
  const version = '1.4.3-R5018.1';
  const build = MUSE_RELEASES[version];

  it('downloads the pinned build for each arch and checks its sha256', () => {
    const script = buildInstallScript(version);
    for (const { file, sha256 } of [build.x86_64, build.aarch64]) {
      expect(script).toContain(museDownloadUrl(version, file));
      expect(script).toContain(`sha=${sha256}`);
    }
    expect(script).toContain('sha256sum -c');
    // The verified file only becomes the binary after the check passes.
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('mv '));
    expect(script).toContain('set -eu');
  });

  it('is valid bash', () => {
    const check = spawnSync('bash', ['-n'], {
      input: buildInstallScript(version),
      encoding: 'utf8',
    });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });

  it('refuses a build that has no recorded checksum', () => {
    expect(() => buildInstallScript('9.9.9-R1')).toThrow('has no pinned build');
  });

  it('downloads from the versioned URL, not a release channel', () => {
    expect(museDownloadUrl(version, 'muse-x86-linux')).toBe(
      'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.3-R5018.1&file=muse-x86-linux'
    );
  });
});

describe('museRunner.install', () => {
  it('checks the installed binary reports the pinned build', async () => {
    const { sandbox, calls } = recordingSandbox((command) =>
      command.endsWith('--version')
        ? ok('Muse Code 1.4.3 (1.4.3-R5018.1)\n')
        : undefined
    );
    await museRunner.install(sandbox, '1.4.3-R5018.1', 'meta-test');
    expect(calls.at(-1)?.command).toBe(
      `${MUSE_ENV} "$HOME/.eval/muse/bin/muse" --version`
    );
  });

  it('fails when the binary reports another build', async () => {
    const { sandbox } = recordingSandbox((command) =>
      command.endsWith('--version')
        ? ok('Muse Code 1.4.4 (1.4.4-R5100.1)\n')
        : undefined
    );
    await expect(
      museRunner.install(sandbox, '1.4.3-R5018.1', 'meta-test')
    ).rejects.toThrow('expected build 1.4.3-R5018.1');
  });
});

describe('museRunner.exec', () => {
  it('rejects the echo run as recorded, whose reminder could not run', async () => {
    await expect(execWith({ logs: ECHO_AS_RECORDED })).rejects.toThrow(
      `failed with config_error in child session ${CHILD}, which is not the agent's doing; rerun it. ` +
        'Muse reported: invalid run configuration: provider does not support base instructions'
    );
  });

  it('runs headless against Meta with the configured model and effort', async () => {
    const { calls } = await execWith({ logs: ECHO, reasoningEffort: 'high' });
    const run = calls.find((c) => c.command.includes(' exec '))!;
    expect(run.command).toMatch(
      /^XDG_CONFIG_HOME="\$HOME\/.eval\/muse\/config" XDG_DATA_HOME="\$HOME\/.eval\/muse\/data" XDG_CACHE_HOME="\$HOME\/.eval\/muse\/cache" MUSE_NO_AUTO_UPDATE=1 "\$HOME\/.eval\/muse\/bin\/muse" exec /
    );
    for (const flag of [
      '--json',
      '--prompt-file "$HOME/.eval/user-prompt.txt"',
      '--provider meta',
      "--model 'muse-spark-1.3'",
      "--reasoning-effort 'high'",
      '--yolo',
      '--no-foreign-personal-context',
    ]) {
      expect(run.command).toContain(flag);
    }
    expect(run.command).toMatch(/--session-id [0-9a-f-]{36} /);
    expect(run.command.endsWith('< /dev/null')).toBe(true);
    // Only the key goes through the sandbox env; $HOME paths must expand in
    // the shell (see the Grok runner for what happens otherwise).
    expect(run.env).toEqual({ META_API_KEY: 'meta-test' });
  });

  it("leaves reasoning effort to Muse when the experiment doesn't set it", async () => {
    const { calls } = await execWith({ logs: ECHO });
    const run = calls.find((c) => c.command.includes(' exec '))!;
    expect(run.command).not.toContain('--reasoning-effort');
  });

  it('returns the session logs as the transcript', async () => {
    const { result } = await execWith({ logs: ECHO });
    expect(result.raw).toBe(ECHO);
  });

  it('reads logs strictly unless the run timed out', async () => {
    const strict = await execWith({ logs: ECHO });
    expect(
      strict.calls.find((c) => c.command.startsWith('node -e'))?.command
    ).not.toMatch(/ partial-ok$/);
    const killed = await execWith({ logs: ECHO_UNFINISHED, run: timedOut });
    expect(
      killed.calls.find((c) => c.command.startsWith('node -e'))?.command
    ).toMatch(/ partial-ok$/);
  });

  it('fails when Muse ignored part of its settings', async () => {
    await expect(
      execWith({
        logs: ECHO,
        stderr:
          'tbh: ignoring unknown top-level member in settings file at /x/settings.json: reason=unknown_member location=mcp_servers',
      })
    ).rejects.toThrow('ignored part of its settings.json');
  });

  it('fails when the session never opened', async () => {
    await expect(
      execWith({ logs: fixture('bad-key-session.jsonl') })
    ).rejects.toThrow('never opened a session');
  });

  it('fails, rather than scoring, a run the provider refused', async () => {
    await expect(execWith({ logs: failedRun('rate_limited') })).rejects.toThrow(
      'failed with rate_limited in the main session'
    );
  });

  it('fails when a child session hit the provider limit', async () => {
    // The agent finished, but a reminder it would have had was cut off.
    const childLimited = echoWith(
      event(CHILD, 999, {
        kind: 'run_fatal_error_classified',
        error_class: 'rate_limited',
      })
    );
    await expect(execWith({ logs: childLimited })).rejects.toThrow(
      `failed with rate_limited in child session ${CHILD}`
    );
  });

  it('fails when the provider refused before any terminal event', async () => {
    const unterminated = [
      ECHO_UNFINISHED,
      event(MAIN, 999, {
        kind: 'run_fatal_error_classified',
        error_class: 'auth_error',
      }),
    ].join('\n');
    await expect(
      execWith({
        logs: unterminated,
        run: { ok: false, exitCode: 1, stdout: '', stderr: '' },
      })
    ).rejects.toThrow('failed with auth_error');
  });

  it('fails when a run that was not killed has no terminal event', async () => {
    await expect(execWith({ logs: ECHO_UNFINISHED })).rejects.toThrow(
      'ended without recording how the run finished'
    );
  });

  it("doesn't mistake a provider error that mentions a timeout for one", async () => {
    await expect(
      execWith({
        logs: ECHO_UNFINISHED,
        run: { ok: false, exitCode: 1, stdout: '', stderr: '' },
        stderr: 'model request timed out after 3 retries',
      })
    ).rejects.toThrow('ended without recording how the run finished');
  });

  it('returns a timed-out run, to be scored as a timeout', async () => {
    const { result } = await execWith({
      logs: ECHO_UNFINISHED,
      run: timedOut,
    });
    expect(museRunner.deriveStopReason?.(result.raw, result.command)).toBe(
      'timeout'
    );
  });

  it('fails a real run whose model request the provider refused', async () => {
    // Muse leaves this unclassified; the parser calls it provider_error.
    await expect(
      execWith({ logs: fixture('bad-model.jsonl') })
    ).rejects.toThrow(
      "failed with provider_error in the main session, which is not the agent's doing; rerun it. " +
        'Muse reported: model `muse-spark-9.9` does not exist or you lack access'
    );
  });

  it('returns a real run that hit the step limit, to be scored', async () => {
    const { result } = await execWith({ logs: fixture('step-limit.jsonl') });
    expect(museRunner.deriveStopReason?.(result.raw, result.command)).toBe(
      'step_limit'
    );
  });

  it('returns a real completed run', async () => {
    const { result } = await execWith({ logs: fixture('files.jsonl') });
    expect(museRunner.deriveStopReason?.(result.raw, result.command)).toBe(
      'stop'
    );
    expect(museRunner.extractStepCount?.(result.raw)).toBe(4);
  });

  it('returns a run that failed for its own reasons, to be scored', async () => {
    const { result } = await execWith({ logs: failedRun('context_length') });
    expect(result.raw).toContain('context_length');
  });
});

describe('museRunner.deriveStopReason', () => {
  it('maps a completed run to stop', () => {
    expect(museRunner.deriveStopReason?.(ECHO, ok())).toBe('stop');
  });

  it('reports the error class of a failed run', () => {
    expect(
      museRunner.deriveStopReason?.(failedRun('context_length'), ok())
    ).toBe('context_length');
    expect(museRunner.deriveStopReason?.(failedRun(), ok())).toBe(
      'muse_failed'
    );
  });

  it('keeps a cancelled run distinct', () => {
    const cancelled = echoWith(
      event(MAIN, 1000, { kind: 'terminal', terminal: 'cancelled' })
    );
    expect(museRunner.deriveStopReason?.(cancelled, ok())).toBe('cancelled');
  });

  it('falls back to the process result without a terminal event', () => {
    expect(museRunner.deriveStopReason?.(ECHO_UNFINISHED, timedOut)).toBe(
      'timeout'
    );
  });
});

describe('buildMuseSettings', () => {
  it('declares MCP servers as stdio and turns telemetry off', () => {
    expect(
      JSON.parse(
        buildMuseSettings({
          supabase: {
            command: 'npx',
            args: ['-y', '@supabase/mcp-server-supabase'],
            env: { SUPABASE_ACCESS_TOKEN: 'sbp_test' },
          },
          bare: { command: 'mcp-bare' },
        })
      )
    ).toEqual({
      schema_version: 1,
      telemetry: { enabled: false },
      mcp_servers: {
        supabase: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@supabase/mcp-server-supabase'],
          env: { SUPABASE_ACCESS_TOKEN: 'sbp_test' },
        },
        bare: { transport: 'stdio', command: 'mcp-bare', args: [] },
      },
    });
  });
});

describe('READ_SESSION_LOGS_SCRIPT', () => {
  /** Run the script with Node against a session directory on disk. */
  const read = (dir: string, mode?: string) =>
    spawnSync(
      process.execPath,
      ['-e', READ_SESSION_LOGS_SCRIPT, dir, ...(mode ? [mode] : [])],
      { encoding: 'utf8' }
    );

  /** A session dir whose main log was cut off mid-record. */
  function sessionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'muse-session-'));
    mkdirSync(join(dir, 'subagent', 'b'), { recursive: true });
    mkdirSync(join(dir, 'subagent', 'a'), { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), 'main-1\nmain-2\n{"partial');
    writeFileSync(join(dir, 'subagent', 'b', 'session.jsonl'), 'b-1\n');
    writeFileSync(join(dir, 'subagent', 'a', 'session.jsonl'), 'a-1\na-2\n');
    // Not a session log.
    writeFileSync(join(dir, 'cli-1.log'), 'noise\n');
    return dir;
  }

  it('drops a half-written record from a killed run, main log first', () => {
    const out = read(sessionDir(), 'partial-ok');
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('main-1\nmain-2\na-1\na-2\nb-1\n');
  });

  it('refuses a half-written record otherwise', () => {
    const out = read(sessionDir());
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('session.jsonl ends mid-record');
  });

  it('keeps a complete last record that only lacks its newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-session-'));
    writeFileSync(join(dir, 'session.jsonl'), '{"a":1}\n{"b":2}');
    const out = read(dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('{"a":1}\n{"b":2}\n');
  });

  it('reads complete logs unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-session-'));
    writeFileSync(join(dir, 'session.jsonl'), 'only\n');
    expect(
      execFileSync(process.execPath, ['-e', READ_SESSION_LOGS_SCRIPT, dir], {
        encoding: 'utf8',
      })
    ).toBe('only\n');
  });
});
