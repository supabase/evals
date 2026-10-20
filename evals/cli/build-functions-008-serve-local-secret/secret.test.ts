import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { parse } from 'shell-quote';
import { afterEach, describe, expect, it } from 'vitest';
import { DIGEST_SECRET } from './fixture.js';
import {
  checkSecretKeptOut,
  findFunctionSources,
  findSecretFiles,
  scanSecret,
  type SecretHit,
  type SecretScan,
} from './secret.js';

const SOURCE = 'supabase/functions/nightly-digest/index.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'serve-secret-'))
  );
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const withSecret = `DIGEST_SECRET=${DIGEST_SECRET}\nSITE_URL=http://localhost:3000\n`;

describe('findSecretFiles', () => {
  it('lists the files holding the literal as sorted relative posix paths', () => {
    const root = workspace({
      'supabase/functions/nightly-digest/index.ts': `const s = '${DIGEST_SECRET}';`,
      'supabase/functions/.env': withSecret,
      '.env.example': `DIGEST_SECRET=${DIGEST_SECRET}`,
      '.env': withSecret,
      'README.md': 'nothing to see',
      'docs/scheduler.md': 'the header carries the shared value',
    });

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual([
      '.env',
      '.env.example',
      'supabase/functions/.env',
      SOURCE,
    ]);
  });

  it('finds a literal in the middle of a line and in a dotfile under a nested folder', () => {
    const root = workspace({
      'supabase/functions/nightly-digest/.env.local': `x=1\nexport DIGEST_SECRET="${DIGEST_SECRET}" # shared\n`,
    });

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual([
      'supabase/functions/nightly-digest/.env.local',
    ]);
  });

  it('does not match a truncated copy of the secret', () => {
    const root = workspace({
      '.env': `DIGEST_SECRET=${DIGEST_SECRET.slice(0, -4)}`,
    });

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual([]);
  });

  it('returns nothing for a workspace that never holds the literal', () => {
    expect(findSecretFiles(workspace({ 'a.txt': 'x' }), DIGEST_SECRET)).toEqual(
      []
    );
  });

  it('skips node_modules, .git, supabase/.temp and supabase/.branches', () => {
    const root = workspace({
      '.env': withSecret,
      'node_modules/pkg/index.js': DIGEST_SECRET,
      'supabase/functions/nightly-digest/node_modules/dep/index.js':
        DIGEST_SECRET,
      '.git/config': DIGEST_SECRET,
      '.git/hooks/pre-commit': DIGEST_SECRET,
      'supabase/.temp/cli-latest': DIGEST_SECRET,
      'supabase/.branches/_current_branch': DIGEST_SECRET,
    });

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual(['.env']);
  });

  it('does not follow symlinks to files, to directories, to the root or to nothing', () => {
    const root = workspace({
      '.env': withSecret,
      'supabase/functions/nightly-digest/index.ts': 'export {};',
    });
    fs.symlinkSync('.env', path.join(root, 'linked.env'));
    fs.symlinkSync('supabase', path.join(root, 'linked-dir'));
    fs.symlinkSync('.', path.join(root, 'loop'));
    fs.symlinkSync('missing', path.join(root, 'dangling'));

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual(['.env']);
  });

  it('skips files over 1 MB and reads smaller ones', () => {
    const root = workspace({
      'big.log': `${DIGEST_SECRET}${'x'.repeat(2 * 1024 * 1024)}`,
      'medium.log': `${DIGEST_SECRET}${'x'.repeat(100 * 1024)}`,
    });

    expect(findSecretFiles(root, DIGEST_SECRET)).toEqual(['medium.log']);
  });
});

describe('findFunctionSources', () => {
  it('lists ts, tsx, js, mjs and jsx files under supabase/functions as sorted relative paths', () => {
    const root = workspace({
      'supabase/functions/nightly-digest/lib/util.js': '',
      'supabase/functions/nightly-digest/page.tsx': '',
      'supabase/functions/nightly-digest/index.ts': '',
      'supabase/functions/_shared/cors.ts': '',
      'supabase/functions/other/handler.mjs': '',
      'supabase/functions/other/view.jsx': '',
    });

    expect(findFunctionSources(root)).toEqual([
      'supabase/functions/_shared/cors.ts',
      SOURCE,
      'supabase/functions/nightly-digest/lib/util.js',
      'supabase/functions/nightly-digest/page.tsx',
      'supabase/functions/other/handler.mjs',
      'supabase/functions/other/view.jsx',
    ]);
  });

  it('leaves out config, env and docs files and sources outside supabase/functions', () => {
    const root = workspace({
      [SOURCE]: '',
      'supabase/functions/.env': withSecret,
      'supabase/functions/nightly-digest/.env': withSecret,
      'supabase/functions/nightly-digest/deno.json': '{}',
      'supabase/functions/nightly-digest/README.md': '',
      'supabase/seed.ts': '',
      'src/app.ts': '',
      'docs/scheduler.md': '',
    });

    expect(findFunctionSources(root)).toEqual([SOURCE]);
  });

  it('skips node_modules inside a function', () => {
    const root = workspace({
      [SOURCE]: '',
      'supabase/functions/nightly-digest/node_modules/dep/index.js': '',
    });

    expect(findFunctionSources(root)).toEqual([SOURCE]);
  });

  it('returns nothing when supabase/functions does not exist', () => {
    expect(
      findFunctionSources(workspace({ 'supabase/config.toml': '' }))
    ).toEqual([]);
  });
});

describe('scanSecret', () => {
  function checkedPaths(command: string): string[] {
    const list = /for \w+ in ([\s\S]*?)(?:;|\n)\s*do\b/.exec(command)?.[1];
    return parse(list ?? '').filter(
      (token): token is string => typeof token === 'string'
    );
  }

  function ctxFor(
    hostWorkspace: string,
    uncommittable: readonly string[],
    failure?: CommandResult | Error
  ) {
    const commands: string[] = [];
    const ctx = {
      hostWorkspace,
      exec: async (command: string): Promise<CommandResult> => {
        commands.push(command);
        if (failure instanceof Error) throw failure;
        if (failure !== undefined) return failure;
        if (!command.includes('check-ignore')) {
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        }
        const notIgnored = checkedPaths(command).filter((file) =>
          uncommittable.includes(file)
        );
        return {
          ok: true,
          exitCode: 0,
          stdout: notIgnored.map((file) => `${file}\n`).join(''),
          stderr: '',
        };
      },
    } as unknown as LocalStackEvalContext;
    return { ctx, commands };
  }

  it('reports the function sources and marks the ignored hits', async () => {
    const root = workspace({
      '.env': withSecret,
      'supabase/functions/.env': withSecret,
      [SOURCE]: "Deno.env.get('DIGEST_SECRET')",
    });

    const scan = await scanSecret(ctxFor(root, []).ctx);

    expect(scan).toEqual({
      ok: true,
      functionSources: [SOURCE],
      hits: [
        { file: '.env', ignored: true },
        { file: 'supabase/functions/.env', ignored: true },
      ],
    });
  });

  it('marks the hits that git check-ignore does not ignore as not ignored', async () => {
    const root = workspace({
      '.env': withSecret,
      '.env.example': `DIGEST_SECRET=${DIGEST_SECRET}`,
      [SOURCE]: `const s = '${DIGEST_SECRET}';`,
    });

    const scan = await scanSecret(ctxFor(root, [SOURCE, '.env.example']).ctx);

    expect(scan).toEqual({
      ok: true,
      functionSources: [SOURCE],
      hits: [
        { file: '.env', ignored: true },
        { file: '.env.example', ignored: false },
        { file: SOURCE, ignored: false },
      ],
    });
  });

  it('quotes hit paths so a name with a space and a quote still reaches git check-ignore intact', async () => {
    const odd = "supabase/functions/it's here/.env";
    const root = workspace({
      '.env': withSecret,
      [odd]: withSecret,
      [SOURCE]: '',
    });

    const scan = await scanSecret(ctxFor(root, [odd]).ctx);

    expect(scan.ok && scan.hits).toEqual([
      { file: '.env', ignored: true },
      { file: odd, ignored: false },
    ]);
  });

  it('reports no hits and the sources when the literal is nowhere', async () => {
    const root = workspace({ [SOURCE]: 'export {};' });

    const scan = await scanSecret(ctxFor(root, []).ctx);

    expect(scan).toEqual({ ok: true, functionSources: [SOURCE], hits: [] });
  });

  it('reports no function sources when supabase/functions holds none', async () => {
    const root = workspace({ '.env': withSecret });

    const scan = await scanSecret(ctxFor(root, []).ctx);

    expect(scan).toEqual({
      ok: true,
      functionSources: [],
      hits: [{ file: '.env', ignored: true }],
    });
  });

  it('fails with the sandbox error when the ignore check exits non-zero', async () => {
    const root = workspace({ '.env': withSecret, [SOURCE]: '' });

    const scan = await scanSecret(
      ctxFor(root, [], {
        ok: false,
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      }).ctx
    );

    expect(scan.ok).toBe(false);
    expect(!scan.ok && scan.notes).toContain('fatal: not a git repository');
  });

  it('fails with the error message when the sandbox exec throws', async () => {
    const root = workspace({ '.env': withSecret, [SOURCE]: '' });

    const scan = await scanSecret(
      ctxFor(root, [], new Error('sandbox gone')).ctx
    );

    expect(scan.ok).toBe(false);
    expect(!scan.ok && scan.notes).toContain('sandbox gone');
  });

  it('does not treat a config.toml that only references env(DIGEST_SECRET) as a hit', async () => {
    const root = workspace({
      '.env': withSecret,
      'supabase/config.toml':
        '[edge_runtime.secrets]\nDIGEST_SECRET = "env(DIGEST_SECRET)"\n',
      [SOURCE]: "Deno.env.get('DIGEST_SECRET')",
    });

    const scan = await scanSecret(ctxFor(root, []).ctx);

    expect(scan.ok && scan.hits).toEqual([{ file: '.env', ignored: true }]);
    expect(checkSecretKeptOut(scan).passed).toBe(true);
  });

  it('flags a config.toml that holds the literal as committed', async () => {
    const root = workspace({
      '.env': withSecret,
      'supabase/config.toml': `[edge_runtime.secrets]\nDIGEST_SECRET = "${DIGEST_SECRET}"\n`,
      [SOURCE]: "Deno.env.get('DIGEST_SECRET')",
    });

    const scan = await scanSecret(ctxFor(root, ['supabase/config.toml']).ctx);

    const check = checkSecretKeptOut(scan);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('supabase/config.toml');
  });
});

describe('checkSecretKeptOut', () => {
  const NAME = 'the secret stays out of committed files';

  const scan = (
    hits: SecretHit[],
    functionSources: string[] = [SOURCE]
  ): SecretScan => ({ ok: true, functionSources, hits });

  it('passes when the literal sits only in ignored files', () => {
    const check = checkSecretKeptOut(
      scan([
        { file: '.env', ignored: true },
        { file: 'supabase/functions/.env', ignored: true },
      ])
    );

    expect(check).toMatchObject({ name: NAME, passed: true });
  });

  it('passes when the literal is nowhere in the workspace', () => {
    expect(checkSecretKeptOut(scan([]))).toMatchObject({
      name: NAME,
      passed: true,
    });
  });

  it.each([
    ['a function source', SOURCE],
    ['an env example file', '.env.example'],
    ['a project config file', 'supabase/config.toml'],
  ])(
    'fails and names the file when %s holds the literal and is not ignored',
    (_name, file) => {
      const check = checkSecretKeptOut(
        scan([
          { file: '.env', ignored: true },
          { file, ignored: false },
        ])
      );

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toContain(file);
    }
  );

  it('fails when the project env file itself is not ignored', () => {
    const check = checkSecretKeptOut(scan([{ file: '.env', ignored: false }]));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('.env');
  });

  it('names every file that would be committed', () => {
    const check = checkSecretKeptOut(
      scan([
        { file: '.env.example', ignored: false },
        { file: SOURCE, ignored: false },
      ])
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('.env.example');
    expect(check.notes).toContain(SOURCE);
  });

  it.each([
    ['with an ignored hit', [{ file: '.env', ignored: true }]],
    ['with no hits', []],
  ])('fails when there is no function source, %s', (_name, hits) => {
    const check = checkSecretKeptOut(scan(hits, []));

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('supabase/functions');
  });

  it('fails with the scan notes when the scan could not run', () => {
    const check = checkSecretKeptOut({
      ok: false,
      notes: 'could not read ignore rules: sandbox gone',
    });

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('could not read ignore rules: sandbox gone');
  });
});
