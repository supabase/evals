// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commandResult,
  crash,
  failure,
  fakeExec,
  HOSTED_ABSENT,
  HOSTED_OK,
  HOSTED_REF,
  MISSING_FILE,
  OTHER_REF,
  probeRoute,
  readLinkRoute,
  stderrFailure,
} from './fixtures.js';
import {
  checkLinkedCliWorks,
  checkLinkedToProject,
  LINK_CHECK_NAME,
  LINKED_CLI_CHECK_NAME,
  LINKED_CLI_PROBE,
  probeLinkedCli,
  readWorkspaceLink,
} from './link.js';

const MISSING_NOTES = 'supabase/.temp/project-ref is missing';
const EMPTY_NOTES = 'supabase/.temp/project-ref is empty';

describe('readWorkspaceLink', () => {
  it('reads the ref the CLI wrote, without its trailing newline', async () => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(`${HOSTED_REF}\n`))]);

    expect(await readWorkspaceLink(ctx)).toEqual({
      ok: true,
      ref: HOSTED_REF,
    });
  });

  it.each([
    ['no trailing newline', HOSTED_REF],
    ['a CRLF line ending', `${HOSTED_REF}\r\n`],
    ['surrounding whitespace', `  ${HOSTED_REF}  \n`],
  ])('trims the ref when the file has %s', async (_, content) => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(content))]);

    expect(await readWorkspaceLink(ctx)).toEqual({
      ok: true,
      ref: HOSTED_REF,
    });
  });

  it('reads the project-ref file with a single command', async () => {
    const { ctx, calls } = fakeExec([
      readLinkRoute(commandResult(`${HOSTED_REF}\n`)),
    ]);

    await readWorkspaceLink(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('cat supabase/.temp/project-ref');
  });

  it('reports a missing file', async () => {
    const { ctx } = fakeExec([readLinkRoute(MISSING_FILE)]);

    expect(await readWorkspaceLink(ctx)).toEqual({
      ok: false,
      notes: MISSING_NOTES,
    });
  });

  it.each([
    [
      'permission denied',
      stderrFailure(1, 'cat: supabase/.temp/project-ref: Permission denied'),
      'could not read supabase/.temp/project-ref (exit 1: cat: supabase/.temp/project-ref: Permission denied)',
    ],
    [
      'a directory',
      stderrFailure(1, 'cat: supabase/.temp/project-ref: Is a directory'),
      'could not read supabase/.temp/project-ref (exit 1: cat: supabase/.temp/project-ref: Is a directory)',
    ],
    [
      'a killed cat',
      { ok: false, exitCode: null, stdout: '', stderr: '' },
      'could not read supabase/.temp/project-ref (exit null)',
    ],
  ])(
    'does not call an unreadable file missing: %s',
    async (_, result, notes) => {
      const { ctx } = fakeExec([readLinkRoute(result)]);

      expect(await readWorkspaceLink(ctx)).toEqual({ ok: false, notes });
    }
  );

  it.each([
    ['empty', ''],
    ['a lone newline', '\n'],
    ['whitespace only', '  \n\t\n'],
  ])('reports a file that is %s as empty', async (_, content) => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(content))]);

    expect(await readWorkspaceLink(ctx)).toEqual({
      ok: false,
      notes: EMPTY_NOTES,
    });
  });

  it('returns the exec error instead of rejecting', async () => {
    const { ctx } = fakeExec([readLinkRoute(crash('sandbox gone'))]);

    const link = await readWorkspaceLink(ctx);

    expect(link.ok).toBe(false);
    if (link.ok) return;
    expect(link.notes).toContain('sandbox gone');
  });
});

describe('checkLinkedToProject', () => {
  it('passes when the workspace is linked to the hosted project', () => {
    expect(
      checkLinkedToProject(HOSTED_OK, { ok: true, ref: HOSTED_REF })
    ).toMatchObject({ name: LINK_CHECK_NAME, passed: true });
  });

  it('fails naming both refs when the workspace is linked to another project', () => {
    const check = checkLinkedToProject(HOSTED_OK, {
      ok: true,
      ref: OTHER_REF,
    });

    expect(check).toMatchObject({ name: LINK_CHECK_NAME, passed: false });
    expect(check.notes).toContain(HOSTED_REF);
    expect(check.notes).toContain(OTHER_REF);
  });

  it('passes a hand-written ref with no trailing newline', async () => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(HOSTED_REF))]);

    const link = await readWorkspaceLink(ctx);

    expect(checkLinkedToProject(HOSTED_OK, link)).toMatchObject({
      name: LINK_CHECK_NAME,
      passed: true,
    });
  });

  it('fails a ref that only extends the hosted ref', () => {
    const check = checkLinkedToProject(HOSTED_OK, {
      ok: true,
      ref: `${HOSTED_REF}x`,
    });

    expect(check.passed).toBe(false);
  });

  it('fails a ref that differs from the hosted ref only in case', () => {
    const check = checkLinkedToProject(HOSTED_OK, {
      ok: true,
      ref: HOSTED_REF.toUpperCase(),
    });

    expect(check.passed).toBe(false);
  });

  it('fails when the project-ref file is missing', () => {
    const check = checkLinkedToProject(HOSTED_OK, {
      ok: false,
      notes: MISSING_NOTES,
    });

    expect(check).toMatchObject({ name: LINK_CHECK_NAME, passed: false });
    expect(check.notes).toContain(MISSING_NOTES);
  });

  it('fails when the project-ref file is empty', () => {
    const check = checkLinkedToProject(HOSTED_OK, {
      ok: false,
      notes: EMPTY_NOTES,
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(EMPTY_NOTES);
  });

  it('fails when no hosted project exists, even though the file holds a ref', () => {
    const check = checkLinkedToProject(HOSTED_ABSENT, {
      ok: true,
      ref: OTHER_REF,
    });

    expect(check).toMatchObject({ name: LINK_CHECK_NAME, passed: false });
    expect(check.notes).toContain(OTHER_REF);
  });

  it('fails when no hosted project exists and nothing is linked', () => {
    expect(
      checkLinkedToProject(HOSTED_ABSENT, { ok: false, notes: MISSING_NOTES })
        .passed
    ).toBe(false);
  });
});

describe('LINKED_CLI_PROBE in a real shell', () => {
  const dirs: string[] = [];
  const hasTimeout =
    spawnSync('bash', ['-c', 'command -v timeout']).status === 0;

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasTimeout)(
    'runs the CLI without SUPABASE_PROJECT_ID and with stdin closed',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-login-probe-'));
      dirs.push(dir);
      fs.writeFileSync(
        path.join(dir, 'supabase'),
        [
          '#!/bin/sh',
          'echo "project_id=${SUPABASE_PROJECT_ID-unset}"',
          'echo "stdin_bytes=$(wc -c | tr -d \' \')"',
        ].join('\n'),
        { mode: 0o755 }
      );

      const run = spawnSync('bash', ['-c', LINKED_CLI_PROBE], {
        cwd: dir,
        encoding: 'utf8',
        input: 'typed by a user',
        env: {
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          SUPABASE_PROJECT_ID: HOSTED_REF,
        },
      });

      expect(run.stdout.trim().split('\n')).toEqual([
        'project_id=unset',
        'stdin_bytes=0',
      ]);
    }
  );
});

describe('probeLinkedCli', () => {
  it('returns the exit code and output of a successful probe', async () => {
    const { ctx } = fakeExec([probeRoute(commandResult('NAME  DIGEST\n'))]);

    const probe = await probeLinkedCli(ctx);

    expect(probe.exitCode).toBe(0);
    expect(probe.output).toContain('NAME  DIGEST');
  });

  it('returns the exit code and output of a failed probe', async () => {
    const output = 'Cannot find project ref. Have you run supabase link?';
    const { ctx } = fakeExec([probeRoute(failure(1, output))]);

    const probe = await probeLinkedCli(ctx);

    expect(probe.exitCode).toBe(1);
    expect(probe.output).toContain(output);
  });

  it('keeps the timeout exit code', async () => {
    const { ctx } = fakeExec([probeRoute(failure(124))]);

    expect((await probeLinkedCli(ctx)).exitCode).toBe(124);
  });

  it('reports a null exit code when the process was killed', async () => {
    const { ctx } = fakeExec([
      probeRoute({ ok: false, exitCode: null, stdout: '', stderr: '' }),
    ]);

    expect((await probeLinkedCli(ctx)).exitCode).toBeNull();
  });

  it('returns a null exit code and the error message when exec throws', async () => {
    const { ctx } = fakeExec([probeRoute(crash('sandbox gone'))]);

    expect(await probeLinkedCli(ctx)).toEqual({
      exitCode: null,
      output: 'sandbox gone',
    });
  });
});

describe('checkLinkedCliWorks', () => {
  it('passes when the probe exits 0 against a hosted project', () => {
    expect(
      checkLinkedCliWorks(HOSTED_OK, { exitCode: 0, output: 'NAME  DIGEST' })
    ).toMatchObject({ name: LINKED_CLI_CHECK_NAME, passed: true });
  });

  it('fails with the probe output in the notes when the probe exits non-zero', () => {
    const output = 'Cannot find project ref. Have you run supabase link?';

    const check = checkLinkedCliWorks(HOSTED_OK, { exitCode: 1, output });

    expect(check).toMatchObject({ name: LINKED_CLI_CHECK_NAME, passed: false });
    expect(check.notes).toContain(output);
  });

  it('says the probe timed out on exit 124', () => {
    const check = checkLinkedCliWorks(HOSTED_OK, { exitCode: 124, output: '' });

    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/timed out/i);
  });

  it('does not call a non-timeout failure a timeout', () => {
    const check = checkLinkedCliWorks(HOSTED_OK, {
      exitCode: 1,
      output: 'Access token not provided.',
    });

    expect(check.notes).not.toMatch(/timed out/i);
  });

  it('fails when the probe never ran, carrying the error', () => {
    const check = checkLinkedCliWorks(HOSTED_OK, {
      exitCode: null,
      output: 'sandbox gone',
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('sandbox gone');
  });

  it('fails without a hosted project even when the probe exits 0', () => {
    const check = checkLinkedCliWorks(HOSTED_ABSENT, {
      exitCode: 0,
      output: 'NAME  DIGEST',
    });

    expect(check).toMatchObject({ name: LINKED_CLI_CHECK_NAME, passed: false });
    expect(check.notes).toContain('NAME  DIGEST');
  });

  it('fails without a hosted project and carries the probe output when the probe failed', () => {
    const output = 'Access token not provided.';

    const check = checkLinkedCliWorks(HOSTED_ABSENT, { exitCode: 1, output });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(output);
  });
});
