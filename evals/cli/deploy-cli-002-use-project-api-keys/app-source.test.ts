// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_SOURCE_CHECK_NAME,
  type AppSource,
  checkAppReadsConfig,
  readAppSource,
} from './app-source.js';
import {
  ANON_KEY,
  APP_KEY_VAR,
  APP_URL_VAR,
  clientSource,
  crash,
  dotenv,
  expectNoKeyValues,
  failure,
  fakeExec,
  KILLED,
  PROJECT_URL,
  removeWorkspaces,
  stderrFailure,
  workspaceExec,
} from './fixtures.js';

afterAll(removeWorkspaces);

type Files = Record<string, string | null>;

const read = (files: Files = {}) => readAppSource(workspaceExec(files).ctx);

const READS_NEITHER = 'export const supabase = undefined;\n';
const MENTIONS_BOTH = `Set ${APP_URL_VAR} and ${APP_KEY_VAR} before running the app.\n`;

const BOTH: AppSource = { ok: true, missing: [] };

describe('APP_SOURCE_CHECK_NAME', () => {
  it('names what the check verifies', () => {
    expect(APP_SOURCE_CHECK_NAME).toBe(
      'the app still reads its URL and key from that config'
    );
  });
});

describe('readAppSource in a real workspace', () => {
  it.each([
    ['the seeded app', {}],
    [
      'the client moved to src/lib/client.ts',
      {
        'src/supabase.ts': "export { supabase } from './lib/client';\n",
        'src/lib/client.ts': clientSource(),
      },
    ],
    [
      'bracket access to import.meta.env',
      {
        'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env['${APP_URL_VAR}'],
  import.meta.env["${APP_KEY_VAR}"]
);
`,
      },
    ],
    [
      'destructuring import.meta.env',
      {
        'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';

const { ${APP_URL_VAR}: url, ${APP_KEY_VAR}: key } = import.meta.env;

export const supabase = createClient(url, key);
`,
      },
    ],
    [
      'the URL read through index.html and the key in src',
      {
        'index.html': `<base href="%${APP_URL_VAR}%" />\n`,
        'src/supabase.ts': clientSource('OTHER_URL'),
      },
    ],
    ['index.html deleted', { 'index.html': null }],
    [
      'a file name with spaces',
      {
        'src/supabase.ts': READS_NEITHER,
        'src/my lib/my client.ts': clientSource(),
      },
    ],
  ] as [string, Files][])('finds both variables in %s', async (_, files) => {
    expect(await read(files)).toEqual(BOTH);
  });

  it.each([
    [
      'the key renamed to VITE_SUPABASE_ANON_KEY',
      {
        'src/supabase.ts': clientSource(APP_URL_VAR, 'VITE_SUPABASE_ANON_KEY'),
      },
      [APP_KEY_VAR],
    ],
    [
      'the URL renamed',
      {
        'src/supabase.ts': clientSource(
          'VITE_SUPABASE_PROJECT_URL',
          APP_KEY_VAR
        ),
      },
      [APP_URL_VAR],
    ],
    [
      'both renamed',
      {
        'src/supabase.ts': clientSource(
          'VITE_SUPABASE_PROJECT_URL',
          'VITE_SUPABASE_ANON_KEY'
        ),
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'the values hard-coded with no env reference',
      {
        'src/supabase.ts': `import { createClient } from '@supabase/supabase-js';

export const supabase = createClient('${PROJECT_URL}', '${ANON_KEY}');
`,
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'only VITE_SUPABASE_URL_OLD, which is a different word',
      { 'src/supabase.ts': clientSource(`${APP_URL_VAR}_OLD`, APP_KEY_VAR) },
      [APP_URL_VAR],
    ],
    [
      'only VITE_SUPABASE_PUBLISHABLE_KEY_OLD, which is a different word',
      { 'src/supabase.ts': clientSource(APP_URL_VAR, `${APP_KEY_VAR}_OLD`) },
      [APP_KEY_VAR],
    ],
    [
      'only OLD_VITE_SUPABASE_URL, which is a different word',
      { 'src/supabase.ts': clientSource(`OLD_${APP_URL_VAR}`, APP_KEY_VAR) },
      [APP_URL_VAR],
    ],
    [
      'references only in node_modules at the root',
      {
        'src/supabase.ts': READS_NEITHER,
        'node_modules/dep/index.js': clientSource(),
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'references only in a node_modules inside src',
      {
        'src/supabase.ts': READS_NEITHER,
        'src/vendor/node_modules/dep/index.js': clientSource(),
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'references only in .env.local',
      {
        'src/supabase.ts': READS_NEITHER,
        '.env.local': dotenv({
          [APP_URL_VAR]: PROJECT_URL,
          [APP_KEY_VAR]: ANON_KEY,
        }),
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'references only in .env.example',
      {
        'src/supabase.ts': READS_NEITHER,
        '.env.example': dotenv({ [APP_URL_VAR]: '', [APP_KEY_VAR]: '' }),
      },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    [
      'references only in README.md',
      { 'src/supabase.ts': READS_NEITHER, 'README.md': MENTIONS_BOTH },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
    ['src/ deleted entirely', { src: null }, [APP_URL_VAR, APP_KEY_VAR]],
    [
      'src/ and index.html both deleted',
      { src: null, 'index.html': null },
      [APP_URL_VAR, APP_KEY_VAR],
    ],
  ] as [string, Files, string[]][])(
    'reports the missing variables, in URL then key order, for %s',
    async (_, files, missing) => {
      expect(await read(files)).toEqual({ ok: true, missing });
    }
  );

  it('answers with a single sandbox command whether or not the app reads the variables', async () => {
    const reads = workspaceExec();
    const renamed = workspaceExec({
      'src/supabase.ts': clientSource('A_URL', 'A_KEY'),
    });

    await readAppSource(reads.ctx);
    await readAppSource(renamed.ctx);

    expect(reads.calls).toHaveLength(1);
    expect(renamed.calls).toHaveLength(1);
  });
});

describe('readAppSource when the sandbox command fails', () => {
  it.each([
    ['exits with an error', stderrFailure(2, 'grep: src: Permission denied')],
    ['is killed with no exit code', KILLED],
  ])(
    'returns a failing read with notes when the command %s',
    async (_, result) => {
      const { ctx } = fakeExec([[/.*/, result]]);

      const source = await readAppSource(ctx);

      expect(source.ok).toBe(false);
      if (source.ok) return;
      expect(source.notes).not.toBe('');
    }
  );

  it('carries the error text of the failed command into the notes', async () => {
    const { ctx } = fakeExec([
      [/.*/, stderrFailure(2, 'grep: src: Permission denied')],
    ]);

    const source = await readAppSource(ctx);

    expect(source.ok).toBe(false);
    if (source.ok) return;
    expect(source.notes).toContain('Permission denied');
  });

  it('does not carry the output of a failed command, which may hold source lines with key values', async () => {
    const { ctx } = fakeExec([
      [/.*/, failure(2, `src/supabase.ts:const key = '${ANON_KEY}';`)],
    ]);

    const source = await readAppSource(ctx);

    expect(source.ok).toBe(false);
    if (source.ok) return;
    expectNoKeyValues(source.notes);
  });

  it('returns a failing read with the thrown message instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec([[/.*/, crash('sandbox gone')]]);

    const source = await readAppSource(ctx);

    expect(source.ok).toBe(false);
    if (source.ok) return;
    expect(source.notes).toContain('sandbox gone');
  });
});

describe('checkAppReadsConfig', () => {
  it('passes when the app reads both variables', () => {
    expect(checkAppReadsConfig(BOTH)).toEqual({
      name: APP_SOURCE_CHECK_NAME,
      passed: true,
    });
  });

  it.each([
    ['the URL variable', [APP_URL_VAR], APP_KEY_VAR],
    ['the key variable', [APP_KEY_VAR], APP_URL_VAR],
  ])(
    'fails naming only the variable the app no longer reads when %s is missing',
    (_, missing, present) => {
      const check = checkAppReadsConfig({ ok: true, missing });

      expect(check).toMatchObject({
        name: APP_SOURCE_CHECK_NAME,
        passed: false,
      });
      expect(check.notes).toContain(missing[0]);
      expect(check.notes).not.toContain(present);
      expect(check.notes).toContain('no longer reads');
    }
  );

  it('fails naming both variables when the app reads neither', () => {
    const check = checkAppReadsConfig({
      ok: true,
      missing: [APP_URL_VAR, APP_KEY_VAR],
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain(APP_URL_VAR);
    expect(check.notes).toContain(APP_KEY_VAR);
    expect(check.notes).toContain('no longer reads');
  });

  it('fails with the read notes, without blaming the app, when the source could not be read', () => {
    const notes =
      'could not search src/ (exit 2: grep: src: Permission denied)';

    const check = checkAppReadsConfig({ ok: false, notes });

    expect(check).toMatchObject({ name: APP_SOURCE_CHECK_NAME, passed: false });
    expect(check.notes).toContain(notes);
    expect(check.notes).not.toContain('no longer reads');
  });
});
