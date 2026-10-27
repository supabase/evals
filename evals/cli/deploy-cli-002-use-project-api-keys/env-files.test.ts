// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-002-use-project-api-keys
import { describe, expect, it, vi } from 'vitest';
import {
  parseDotenv,
  readAppEnv,
  resolveViteEnv,
  VITE_DEV_ENV_FILES,
  VITE_PRODUCTION_ENV_FILES,
} from './env-files.js';
import {
  ANON_KEY,
  catRoute,
  commandResult,
  crash,
  fakeExec,
  KILLED,
  missingFile,
  type Route,
  SERVICE_ROLE_KEY,
  stderrFailure,
} from './fixtures.js';

describe('parseDotenv', () => {
  it.each([
    ['a plain assignment', 'KEY=value', { KEY: 'value' }],
    ['an export prefix', 'export KEY=value', { KEY: 'value' }],
    ['spaces around the equals sign', 'KEY = value', { KEY: 'value' }],
    ['a colon separator', 'KEY: value', { KEY: 'value' }],
    ['leading whitespace before the key', '   KEY=value', { KEY: 'value' }],
    [
      'trailing whitespace after an unquoted value',
      'KEY=value   ',
      { KEY: 'value' },
    ],
    ['dots and dashes in the key', 'A.B-C=1', { 'A.B-C': '1' }],
    ['an equals sign inside the value', 'KEY=a=b==', { KEY: 'a=b==' }],
    ['an empty value', 'KEY=', { KEY: '' }],
    ['an empty quoted value', 'KEY=""', { KEY: '' }],
    ['a JWT value', `KEY=${ANON_KEY}`, { KEY: ANON_KEY }],
  ])('parses %s', (_, text, expected) => {
    expect(parseDotenv(text)).toEqual(expected);
  });

  it.each([
    ['single quotes', "KEY='a b'", 'a b'],
    ['double quotes', 'KEY="a b"', 'a b'],
    ['backticks', 'KEY=`a b`', 'a b'],
    ['spaces kept inside double quotes', 'KEY=" a "', ' a '],
    ['an export prefix with double quotes', 'export KEY="value"', 'value'],
  ])('strips the surrounding %s', (_, text, expected) => {
    expect(parseDotenv(text)).toEqual({ KEY: expected });
  });

  it.each([
    [
      'an inline comment after an unquoted value',
      'KEY=value # comment',
      'value',
    ],
    [
      'an inline comment right after an unquoted value',
      'KEY=value#comment',
      'value',
    ],
    [
      'an inline comment after a double-quoted value',
      'KEY="value" # comment',
      'value',
    ],
    [
      'an inline comment after a single-quoted value',
      "KEY='value' # comment",
      'value',
    ],
    ['a # inside double quotes', 'KEY="a#b"', 'a#b'],
    ['a # inside single quotes', "KEY='a # b'", 'a # b'],
    ['a # inside backticks', 'KEY=`a#b`', 'a#b'],
  ])('handles %s', (_, text, expected) => {
    expect(parseDotenv(text)).toEqual({ KEY: expected });
  });

  it('reads CRLF files without leaving a carriage return in any value', () => {
    expect(parseDotenv('A=1\r\nB="2"\r\nC=three\r\n')).toEqual({
      A: '1',
      B: '2',
      C: 'three',
    });
  });

  it.each([
    ['a \\n', 'KEY="a\\nb"', 'a\nb'],
    ['a \\r', 'KEY="a\\rb"', 'a\rb'],
  ])('expands %s only inside double quotes', (_, text, expanded) => {
    expect(parseDotenv(text)).toEqual({ KEY: expanded });
  });

  it.each([
    ['single quotes', "KEY='a\\nb'"],
    ['backticks', 'KEY=`a\\nb`'],
    ['no quotes', 'KEY=a\\nb'],
  ])('keeps a backslash-n literal with %s', (_, text) => {
    expect(parseDotenv(text)).toEqual({ KEY: 'a\\nb' });
  });

  it('keeps a real newline inside a double-quoted value', () => {
    expect(parseDotenv('KEY="line1\nline2"\nNEXT=1')).toEqual({
      KEY: 'line1\nline2',
      NEXT: '1',
    });
  });

  it('lets the last duplicate key win', () => {
    expect(parseDotenv('KEY=first\nOTHER=x\nKEY="second"')).toEqual({
      KEY: 'second',
      OTHER: 'x',
    });
  });

  it('skips blank lines, comment lines, commented-out assignments and lines with no assignment', () => {
    const text = [
      '# Supabase settings',
      '',
      'A=1',
      '   ',
      '  # indented comment',
      '# B=commented-out',
      'just some words',
      'C=3',
    ].join('\n');

    expect(parseDotenv(text)).toEqual({ A: '1', C: '3' });
  });

  it.each(['', '\n', '   \n  ', '# only a comment'])(
    'returns no keys for %j',
    (text) => {
      expect(parseDotenv(text)).toEqual({});
    }
  );
});

describe('VITE_DEV_ENV_FILES', () => {
  it('lists the files `vite` loads in dev mode, lowest precedence first', () => {
    expect([...VITE_DEV_ENV_FILES]).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ]);
  });
});

describe('VITE_PRODUCTION_ENV_FILES', () => {
  it('lists the files `vite build` loads, lowest precedence first', () => {
    expect([...VITE_PRODUCTION_ENV_FILES]).toEqual([
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
    ]);
  });
});

describe('resolveViteEnv', () => {
  const resolved = (text: string) =>
    Object.fromEntries(
      Object.entries(resolveViteEnv([{ file: '.env', text }])).map(
        ([name, { value }]) => [name, value]
      )
    );

  it.each([
    ['a braced reference', 'A=1\nB=${A}', { A: '1', B: '1' }],
    ['an unbraced reference', 'A=1\nB=$A', { A: '1', B: '1' }],
    ['a reference to a key defined later', 'B=$A\nA=1', { B: '1', A: '1' }],
    [
      'a reference inside a longer value',
      'REF=abc\nURL=https://${REF}.supabase.co/x$REF',
      { REF: 'abc', URL: 'https://abc.supabase.co/xabc' },
    ],
    [
      'a chain of references',
      'C=${B}\nB=${A}\nA=1',
      { C: '${A}', B: '1', A: '1' },
    ],
    ['the same reference three times', 'A=1\nB=$A$A${A}', { A: '1', B: '111' }],
    ['a reference in single quotes', "A=1\nB='${A}'", { A: '1', B: '1' }],
    ['a reference in double quotes', 'A=1\nB="${A}x"', { A: '1', B: '1x' }],
    ['a reference in backticks', 'A=1\nB=`${A}`', { A: '1', B: '1' }],
    ['a reference to an unset key', 'B=${X}', { B: '' }],
    ['an unbraced reference to an unset key', 'B=a$X.b', { B: 'a.b' }],
  ])('expands %s', (_, text, expected) => {
    expect(resolved(text)).toEqual(expected);
  });

  it.each([
    ['${X:-d} with X unset', 'B=${X:-d}', { B: 'd' }],
    ['${X:-d} with X empty', 'X=\nB=${X:-d}', { X: '', B: 'd' }],
    ['${X:-d} with X set', 'X=v\nB=${X:-d}', { X: 'v', B: 'v' }],
    ['${X-d} with X unset', 'B=${X-d}', { B: 'd' }],
    [
      '${X-d} with X empty, unlike the shell',
      'X=\nB=${X-d}',
      { X: '', B: 'd' },
    ],
    ['${X-d} with X set', 'X=v\nB=${X-d}', { X: 'v', B: 'v' }],
    ['${X:+a} with X set', 'X=v\nB=${X:+a}', { X: 'v', B: 'a' }],
    ['${X:+a} with X unset', 'B=${X:+a}', { B: '' }],
    ['${X:+a} with X empty', 'X=\nB=${X:+a}', { X: '', B: '' }],
    ['${X+a} with X set', 'X=v\nB=${X+a}', { X: 'v', B: 'a' }],
    ['${X+a} with X unset', 'B=${X+a}', { B: '' }],
    [
      'a default that is itself a reference',
      'A=1\nB=${X:-$A}',
      { A: '1', B: '1' },
    ],
    [
      'an alternative that holds a reference',
      'A=1\nB=${A:+${A}z}',
      { A: '1', B: '1z' },
    ],
    ['a default holding more operators', 'B=${X:-a:-b}', { B: 'a:-b' }],
    ['a default holding dashes and plusses', 'B=${X:-a-b+c}', { B: 'a-b+c' }],
  ])('expands %s', (_, text, expected) => {
    expect(resolved(text)).toEqual(expected);
  });

  it.each([
    ['an escaped unbraced reference', 'A=1\nB=\\$A', { A: '1', B: '$A' }],
    ['an escaped braced reference', 'A=1\nB=\\${A}', { A: '1', B: '${A}' }],
    ['a dollar sign at the end of a value', 'A=cost$', { A: 'cost$' }],
    ['a dollar sign before a digit', 'A=$1abc', { A: '$1abc' }],
    ['an unclosed brace', 'A=1\nB=${A', { A: '1', B: '${A' }],
    ['empty braces', 'B=${}', { B: '${}' }],
  ])('leaves %s alone', (_, text, expected) => {
    expect(resolved(text)).toEqual(expected);
  });

  it('stops at the seen-set guard for keys that reference each other', () => {
    expect(resolved('A=${B}\nB=${A}')).toEqual({ A: '${A}', B: '' });
  });

  it('empties a key that references itself', () => {
    expect(resolved('A=${A}')).toEqual({ A: '' });
    expect(resolved('A=${A:-x}')).toEqual({ A: 'x' });
  });

  it('splits a reference with no operator on the string "null", like dotenv-expand', () => {
    expect(resolved('A=1\nB=${Anullx}')).toEqual({ A: '1', B: '1' });
    expect(resolved('B=${nullx}')).toEqual({ B: 'x' });
  });

  it('never reads the scorer process environment', () => {
    vi.stubEnv('EVAL_SCORER_ONLY_VAR', 'leaked');
    try {
      expect(
        resolved('B=${EVAL_SCORER_ONLY_VAR}x$EVAL_SCORER_ONLY_VAR')
      ).toEqual({
        B: 'x',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not resolve a reference to an inherited object property', () => {
    expect(resolved('B=${constructor}')).toEqual({ B: '' });
  });

  it('terminates on a value that re-inserts its own reference', () => {
    expect(Object.keys(resolved('A=a$&b\nB=${A}'))).toEqual(['A', 'B']);
  });

  it('expands across files after later files override earlier ones, attributing each key to the file that last set it', () => {
    expect(
      resolveViteEnv([
        { file: '.env', text: 'S=one\nV=${S}' },
        { file: '.env.local', text: 'S=two' },
      ])
    ).toEqual({
      S: { value: 'two', file: '.env.local' },
      V: { value: 'two', file: '.env' },
    });
  });

  it('lets a reference in a later file read a key from an earlier one', () => {
    expect(
      resolveViteEnv([
        { file: '.env', text: `SECRET=${SERVICE_ROLE_KEY}` },
        { file: '.env.local', text: 'VITE_KEY=${SECRET}' },
      ]).VITE_KEY
    ).toEqual({ value: SERVICE_ROLE_KEY, file: '.env.local' });
  });

  it('returns nothing for no files', () => {
    expect(resolveViteEnv([])).toEqual({});
  });
});

describe('readAppEnv', () => {
  const ENV_FILES = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
  ];

  const filesRoutes = (contents: Record<string, string>): Route[] =>
    ENV_FILES.map((file) =>
      catRoute(
        file,
        file in contents ? commandResult(contents[file]) : missingFile(file)
      )
    );

  it('returns ok with no values and no files when none of the files exist', async () => {
    const { ctx } = fakeExec(filesRoutes({}));

    expect(await readAppEnv(ctx)).toEqual({ ok: true, values: {}, files: [] });
  });

  it('reads each value with the file it came from', async () => {
    const { ctx } = fakeExec(
      filesRoutes({
        '.env.local': 'VITE_SUPABASE_URL=https://x.supabase.co\nOTHER=1\n',
      })
    );

    expect(await readAppEnv(ctx)).toEqual({
      ok: true,
      values: {
        VITE_SUPABASE_URL: {
          value: 'https://x.supabase.co',
          file: '.env.local',
        },
        OTHER: { value: '1', file: '.env.local' },
      },
      files: ['.env.local'],
    });
  });

  it.each([
    [['.env']],
    [['.env', '.env.local']],
    [['.env', '.env.local', '.env.development']],
    [['.env', '.env.local', '.env.development', '.env.development.local']],
    [['.env', '.env.development.local']],
    [['.env.local', '.env.development']],
  ])(
    'lets the last of %j win for a key set in each of them',
    async (present) => {
      const { ctx } = fakeExec(
        filesRoutes(
          Object.fromEntries(
            present.map((file) => [file, `KEY=from ${file}\n`])
          )
        )
      );
      const winner = present[present.length - 1];

      expect(await readAppEnv(ctx)).toEqual({
        ok: true,
        values: { KEY: { value: `from ${winner}`, file: winner } },
        files: present,
      });
    }
  );

  it('merges keys across files, attributing each to the file that last set it', async () => {
    const { ctx } = fakeExec(
      filesRoutes({
        '.env': 'A=env\nB=env\n',
        '.env.local': 'B=local\nC=local\n',
        '.env.development.local': 'C=dev-local\n',
      })
    );

    const env = await readAppEnv(ctx);

    expect(env.ok && env.values).toEqual({
      A: { value: 'env', file: '.env' },
      B: { value: 'local', file: '.env.local' },
      C: { value: 'dev-local', file: '.env.development.local' },
    });
  });

  it('lets an empty value in a later file override a filled one', async () => {
    const { ctx } = fakeExec(
      filesRoutes({ '.env': 'KEY=filled\n', '.env.local': 'KEY=\n' })
    );

    const env = await readAppEnv(ctx);

    expect(env.ok && env.values.KEY).toEqual({ value: '', file: '.env.local' });
  });

  it('returns the expanded values, each attributed to the file that set it', async () => {
    const { ctx } = fakeExec(
      filesRoutes({
        '.env': `SUPABASE_ANON_KEY=${ANON_KEY}\n`,
        '.env.local': 'VITE_SUPABASE_PUBLISHABLE_KEY=${SUPABASE_ANON_KEY}\n',
      })
    );

    expect(await readAppEnv(ctx)).toEqual({
      ok: true,
      values: {
        SUPABASE_ANON_KEY: { value: ANON_KEY, file: '.env' },
        VITE_SUPABASE_PUBLISHABLE_KEY: { value: ANON_KEY, file: '.env.local' },
      },
      files: ['.env', '.env.local'],
    });
  });

  it('expands a reference after a later dev file overrides the key it names', async () => {
    const { ctx } = fakeExec(
      filesRoutes({
        '.env': 'KEY=base\nVITE_COPY=$KEY\n',
        '.env.development': 'KEY=dev\n',
      })
    );

    const env = await readAppEnv(ctx);

    expect(env.ok && env.values.VITE_COPY).toEqual({
      value: 'dev',
      file: '.env',
    });
  });

  it('counts an existing empty file as present', async () => {
    const { ctx } = fakeExec(filesRoutes({ '.env.local': '' }));

    expect(await readAppEnv(ctx)).toEqual({
      ok: true,
      values: {},
      files: ['.env.local'],
    });
  });

  it('parses each file as dotenv', async () => {
    const { ctx } = fakeExec(
      filesRoutes({ '.env': `export KEY="${ANON_KEY}" # pasted\r\n` })
    );

    const env = await readAppEnv(ctx);

    expect(env.ok && env.values.KEY.value).toBe(ANON_KEY);
  });

  it('does not load .env.production, .env.example or any other file vite skips in dev', async () => {
    const { ctx, calls } = fakeExec([
      ...filesRoutes({}),
      [
        /\.env\.(production|example|test|staging)/,
        commandResult('KEY=must-not-load\n'),
      ],
    ]);

    const env = await readAppEnv(ctx);

    expect(env).toEqual({ ok: true, values: {}, files: [] });
    expect(
      calls.filter((call) => /production|example|test|staging/.test(call))
    ).toEqual([]);
  });

  it.each([
    [
      'permission denied',
      stderrFailure(1, 'cat: .env.local: Permission denied'),
    ],
    ['is a directory', stderrFailure(1, 'cat: .env.local: Is a directory')],
    ['exit code 2', stderrFailure(2, 'cat: .env.local: Input/output error')],
    ['killed with no exit code', KILLED],
  ])(
    'fails, naming the file, when reading it fails with %s',
    async (_, result) => {
      const { ctx } = fakeExec([
        catRoute('.env.local', result),
        ...filesRoutes({}),
      ]);

      const env = await readAppEnv(ctx);

      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.notes).toContain('.env.local');
    }
  );

  it('carries the cat error text into the notes', async () => {
    const { ctx } = fakeExec([
      catRoute(
        '.env.local',
        stderrFailure(1, 'cat: .env.local: Permission denied')
      ),
      ...filesRoutes({}),
    ]);

    const env = await readAppEnv(ctx);

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.notes).toContain('Permission denied');
  });

  it('fails, rather than treating it as absent, when the first file cannot be read', async () => {
    const { ctx } = fakeExec([
      catRoute('.env', stderrFailure(1, 'cat: .env: Permission denied')),
      ...filesRoutes({ '.env.local': 'KEY=x\n' }),
    ]);

    expect((await readAppEnv(ctx)).ok).toBe(false);
  });

  it('fails with the thrown message when exec throws', async () => {
    const { ctx } = fakeExec([
      catRoute('.env.local', crash('sandbox gone')),
      ...filesRoutes({}),
    ]);

    const env = await readAppEnv(ctx);

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.notes).toContain('sandbox gone');
  });
});
