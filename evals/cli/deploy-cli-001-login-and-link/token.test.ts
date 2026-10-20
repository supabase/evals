// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult } from '@supabase-evals/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commandResult,
  crash,
  FAKE_ACCESS_TOKEN,
  failure,
  fakeExec,
  controlRoute,
  type ExecCtx,
  grepRoute,
} from './fixtures.js';
import {
  ACCESS_TOKEN_PATTERN,
  checkTokenNotInRepo,
  findTokenLeaks,
  TOKEN_CHECK_NAME,
} from './token.js';

const V0_TOKEN = `sbp_v0_${'a'.repeat(40)}`;
const OAUTH_TOKEN = `sbp_oauth_${'0123456789'.repeat(4)}`;

describe('ACCESS_TOKEN_PATTERN', () => {
  const pattern = new RegExp(ACCESS_TOKEN_PATTERN);

  it.each([
    ['a plain sbp_ token', FAKE_ACCESS_TOKEN],
    ['a v0 token', V0_TOKEN],
    ['an oauth token', OAUTH_TOKEN],
    ['a token inside a shell assignment', `export TOKEN=${V0_TOKEN}`],
    [
      'a token inside a quoted TOML value',
      `access_token = "${FAKE_ACCESS_TOKEN}"`,
    ],
  ])('matches %s', (_, text) => {
    expect(pattern.test(text)).toBe(true);
  });

  it.each([
    ['the bare sbp_ prefix', 'sbp_'],
    ['sbp_ in prose', 'tokens start with sbp_... and are 44 characters long'],
    ['39 hex characters', `sbp_${'a'.repeat(39)}`],
    ['39 hex characters after v0', `sbp_v0_${'a'.repeat(39)}`],
    ['uppercase hex', `sbp_${'A'.repeat(40)}`],
    ['non-hex letters', `sbp_${'g'.repeat(40)}`],
    ['a missing sbp_ prefix', 'a'.repeat(40)],
    ['an unknown variant prefix', `sbp_other_${'a'.repeat(40)}`],
  ])('does not match %s', (_, text) => {
    expect(pattern.test(text)).toBe(false);
  });
});

describe('findTokenLeaks', () => {
  it('reports no files when the positive control passes and grep finds nothing', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute(failure(1)),
    ]);

    expect(await findTokenLeaks(ctx)).toEqual({ ok: true, files: [] });
  });

  it('lists offending files relative to the workspace, sorted, without ./', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute(
        commandResult('./supabase/config.toml\n./package.json\n./deploy.sh\n')
      ),
    ]);

    expect(await findTokenLeaks(ctx)).toEqual({
      ok: true,
      files: ['deploy.sh', 'package.json', 'supabase/config.toml'],
    });
  });

  it('accepts paths printed without a ./ prefix', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute(commandResult('deploy.sh\nsupabase/config.toml\n')),
    ]);

    expect(await findTokenLeaks(ctx)).toEqual({
      ok: true,
      files: ['deploy.sh', 'supabase/config.toml'],
    });
  });

  it('fails the probe when the positive control fails, even though grep found nothing', async () => {
    const { ctx } = fakeExec([controlRoute(failure(1)), grepRoute(failure(1))]);

    const probe = await findTokenLeaks(ctx);

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.notes).toContain('supabase/config.toml');
  });

  it('fails the probe when grep exits 2, carrying its error', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute({
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: 'grep: Unmatched ( or \\(',
      }),
    ]);

    const probe = await findTokenLeaks(ctx);

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.notes).toContain('grep: Unmatched');
  });

  it('fails the probe when grep never exits, rather than reporting a clean repo', async () => {
    const { ctx } = fakeExec([
      controlRoute(commandResult()),
      grepRoute({ ok: false, exitCode: null, stdout: '', stderr: '' }),
    ]);

    expect((await findTokenLeaks(ctx)).ok).toBe(false);
  });

  it.each([
    ['grep', grepRoute(crash('sandbox gone')), controlRoute(commandResult())],
    [
      'the positive control',
      controlRoute(crash('sandbox gone')),
      grepRoute(failure(1)),
    ],
  ])(
    'returns a failed probe instead of rejecting when %s throws',
    async (_, first, second) => {
      const { ctx } = fakeExec([first, second]);

      const probe = await findTokenLeaks(ctx);

      expect(probe.ok).toBe(false);
      if (probe.ok) return;
      expect(probe.notes).toContain('sandbox gone');
    }
  );
});

describe('findTokenLeaks against a real workspace', () => {
  const workspaces: string[] = [];

  afterAll(() => {
    for (const dir of workspaces) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function workspace(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-login-link-'));
    workspaces.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return dir;
  }

  function execIn(dir: string): ExecCtx {
    return {
      exec: async (command): Promise<CommandResult> => {
        const run = spawnSync('bash', ['-c', command], {
          cwd: dir,
          encoding: 'utf8',
        });
        return {
          ok: run.status === 0,
          exitCode: run.status,
          stdout: run.stdout,
          stderr: run.stderr,
        };
      },
    };
  }

  const CONFIG = { 'supabase/config.toml': 'project_id = "orders-app"\n' };

  it('lists a token written into project files and nothing else', async () => {
    const dir = workspace({
      'supabase/config.toml': `project_id = "orders-app"\naccess_token = "${FAKE_ACCESS_TOKEN}"\n`,
      'package.json': `{"scripts":{"deploy":"SUPABASE_ACCESS_TOKEN=${V0_TOKEN} supabase db push"}}\n`,
      'scripts/deploy.sh': `export SUPABASE_ACCESS_TOKEN=${OAUTH_TOKEN}\n`,
      'src/index.ts': 'export const answer = 42;\n',
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: ['package.json', 'scripts/deploy.sh', 'supabase/config.toml'],
    });
  });

  it('allows a token in the gitignored .env, .env.local and .env.*.local files', async () => {
    const dir = workspace({
      ...CONFIG,
      '.env': `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\n`,
      '.env.local': `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\n`,
      '.env.development.local': `SUPABASE_ACCESS_TOKEN=${V0_TOKEN}\n`,
      'apps/web/.env.local': `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('flags a token in committed env files such as .env.example and .env.production', async () => {
    const dir = workspace({
      ...CONFIG,
      '.env.example': `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\n`,
      '.env.production': `SUPABASE_ACCESS_TOKEN=${V0_TOKEN}\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: ['.env.example', '.env.production'],
    });
  });

  it("flags the harness's hosted token written into supabase/config.toml", async () => {
    const dir = workspace({
      'supabase/config.toml': `access_token = "sbp_${'0'.repeat(40)}"\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: ['supabase/config.toml'],
    });
  });

  it('ignores a token under .git and node_modules', async () => {
    const dir = workspace({
      ...CONFIG,
      '.git/config': `[credential]\n\ttoken = ${FAKE_ACCESS_TOKEN}\n`,
      'node_modules/pkg/index.js': `module.exports = "${FAKE_ACCESS_TOKEN}";\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('still reports a leak next to an allowed .env file', async () => {
    const dir = workspace({
      ...CONFIG,
      '.env': `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\n`,
      'README.md': `Run with ${FAKE_ACCESS_TOKEN}\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: ['README.md'],
    });
  });

  it('does not flag prose, short hex, or uppercase hex', async () => {
    const dir = workspace({
      ...CONFIG,
      'README.md': 'Your token looks like sbp_... and is shown once.\n',
      'notes.txt': `sbp_${'a'.repeat(39)}\nsbp_${'A'.repeat(40)}\n`,
    });

    expect(await findTokenLeaks(execIn(dir))).toEqual({
      ok: true,
      files: [],
    });
  });

  it('fails the probe when the workspace has no supabase/config.toml', async () => {
    const dir = workspace({ 'README.md': 'nothing here\n' });

    const probe = await findTokenLeaks(execIn(dir));

    expect(probe.ok).toBe(false);
    expect(checkTokenNotInRepo(probe).passed).toBe(false);
  });
});

describe('checkTokenNotInRepo', () => {
  it('passes when no file holds a token', () => {
    expect(checkTokenNotInRepo({ ok: true, files: [] })).toMatchObject({
      name: TOKEN_CHECK_NAME,
      passed: true,
    });
  });

  it('fails listing every offending file', () => {
    const check = checkTokenNotInRepo({
      ok: true,
      files: ['deploy.sh', 'package.json', 'supabase/config.toml'],
    });

    expect(check).toMatchObject({ name: TOKEN_CHECK_NAME, passed: false });
    expect(check.notes).toContain('deploy.sh');
    expect(check.notes).toContain('package.json');
    expect(check.notes).toContain('supabase/config.toml');
  });

  it('fails a probe that could not run instead of passing vacuously', () => {
    const check = checkTokenNotInRepo({
      ok: false,
      notes: 'supabase/config.toml is missing, so the search proves nothing',
    });

    expect(check).toMatchObject({ name: TOKEN_CHECK_NAME, passed: false });
    expect(check.notes).toContain('supabase/config.toml is missing');
  });
});
