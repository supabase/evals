// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADD_STALE,
  fixedTasks,
  LABEL_FIXED,
  LABEL_STALE,
  lineOf,
  makeWorkspace,
  rawCliTypes,
  readLocal,
  regeneratedTypes,
  regeneratedWorkspace,
  removeWorkspaces,
  replaceOnce,
  SEEDED_SUPABASE,
  SEEDED_TYPES,
  STALE_TASKS,
  withoutFunction,
} from './fixtures.js';
import {
  analyseProject,
  APP_EXPORTS,
  checkAppNotSilenced,
  checkAppTypeChecks,
  checkTypesDescribeSchema,
  type ProjectAnalysis,
} from './typecheck.js';

vi.setConfig({ testTimeout: 60_000 });

const blindChecker = vi.hoisted(() => ({ on: false }));

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  const real = actual.default;
  return {
    ...actual,
    default: {
      ...real,
      createProgram: (...args: Parameters<typeof real.createProgram>) => {
        const program = real.createProgram(...args);
        if (blindChecker.on) program.getSemanticDiagnostics = () => [];
        return program;
      },
    },
  };
});

afterEach(() => {
  blindChecker.on = false;
  removeWorkspaces();
});

type OkAnalysis = Extract<ProjectAnalysis, { ok: true }>;

const TYPES_CHECK = 'generated types describe the new schema';
const TYPECHECK_CHECK = 'app code type-checks against the generated types';
const SILENCED_CHECK = 'app code was fixed, not silenced or removed';

function analyse(dir: string): OkAnalysis {
  const analysis = analyseProject(dir);
  if (!analysis.ok) throw new Error(`analysis failed: ${analysis.notes}`);
  return analysis;
}

function expectAllChecksPass(analysis: ProjectAnalysis) {
  expect(checkTypesDescribeSchema(analysis)).toMatchObject({
    name: TYPES_CHECK,
    passed: true,
  });
  expect(checkAppTypeChecks(analysis)).toMatchObject({
    name: TYPECHECK_CHECK,
    passed: true,
  });
  expect(checkAppNotSilenced(analysis)).toMatchObject({
    name: SILENCED_CHECK,
    passed: true,
  });
}

function expectCleanAnalysis(analysis: OkAnalysis, typesPath: string) {
  expect(analysis.typesModules).toEqual([{ path: typesPath, problems: [] }]);
  expect(analysis.diagnostics).toEqual([]);
  expect(analysis.suppressions).toEqual([]);
  expect(analysis.missingExports).toEqual([]);
}

function tsconfigWith(
  compilerOptions: Record<string, unknown>,
  include: string[] = ['src']
): string {
  const base = JSON.parse(readLocal('tsconfig.json'));
  return JSON.stringify({
    ...base,
    compilerOptions: { ...base.compilerOptions, ...compilerOptions },
    include,
  });
}

const RELOCATED_IMPORTS = {
  'src/database.types.ts': null,
  'src/types/supabase.ts': regeneratedTypes(),
  'src/supabase.ts': replaceOnce(
    SEEDED_SUPABASE,
    './database.types',
    './types/supabase'
  ),
  'src/tasks.ts': replaceOnce(
    fixedTasks(),
    './database.types',
    './types/supabase'
  ),
};

describe('analyseProject on the seeded project', () => {
  it('judges the stale types as not describing the new schema while the untouched app still type-checks', () => {
    const analysis = analyse(makeWorkspace());

    expect(analysis.typesModules.map((module) => module.path)).toEqual([
      'src/database.types.ts',
    ]);
    expect([...analysis.typesModules[0].problems].sort()).toEqual([
      'task_status enum',
      'tasks Insert',
      'tasks Row',
      'tasks Update',
    ]);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expect(analysis.missingExports).toEqual([]);

    const types = checkTypesDescribeSchema(analysis);
    expect(types).toMatchObject({ name: TYPES_CHECK, passed: false });
    expect(types.notes).toContain('src/database.types.ts');
    for (const problem of [
      'tasks Row',
      'tasks Insert',
      'tasks Update',
      'task_status enum',
    ]) {
      expect(types.notes).toContain(problem);
    }
    expect(checkAppTypeChecks(analysis)).toMatchObject({
      name: TYPECHECK_CHECK,
      passed: true,
    });
    expect(checkAppNotSilenced(analysis)).toMatchObject({
      name: SILENCED_CHECK,
      passed: true,
    });
  });
});

describe('regenerated types with the app left stale', () => {
  it('passes the types check but fails the type-check on is_complete usages in src/tasks.ts', () => {
    const analysis = analyse(
      makeWorkspace({ 'src/database.types.ts': regeneratedTypes() })
    );

    expect(analysis.typesModules).toEqual([
      { path: 'src/database.types.ts', problems: [] },
    ]);
    expect(analysis.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of analysis.diagnostics) {
      expect(diagnostic).toMatch(/^src\/tasks\.ts:\d+ /);
    }
    expect(
      analysis.diagnostics.some((diagnostic) =>
        diagnostic.includes('is_complete')
      )
    ).toBe(true);

    expect(checkTypesDescribeSchema(analysis).passed).toBe(true);
    const typecheck = checkAppTypeChecks(analysis);
    expect(typecheck).toMatchObject({ name: TYPECHECK_CHECK, passed: false });
    expect(typecheck.notes).toContain('src/tasks.ts');
    expect(typecheck.notes).toContain('is_complete');
  });

  it('reports diagnostics from nested source files too', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/lib/format.ts':
          "import type { Task } from '../tasks';\nexport const isDone = (task: Task) => task.is_complete;\n",
      })
    );

    expect(
      analysis.diagnostics.some((diagnostic) =>
        diagnostic.startsWith('src/lib/format.ts:2 ')
      )
    ).toBe(true);
    expect(checkAppTypeChecks(analysis).passed).toBe(false);
  });
});

describe('regenerated types with the app fixed', () => {
  it('passes every check', () => {
    const analysis = analyse(regeneratedWorkspace());

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expectAllChecksPass(analysis);
  });

  it('passes with types in the raw CLI style: double quotes, no semicolons, no graphql_public, no Constants', () => {
    const types = rawCliTypes();
    expect(types).toContain('"public"');
    expect(types).not.toContain("'");
    expect(types).not.toMatch(/;$/m);
    expect(types).not.toContain('graphql_public');
    expect(types).not.toContain('Constants');

    const analysis = analyse(
      regeneratedWorkspace({ 'src/database.types.ts': types })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });

  it('passes with types written to src/types/supabase.ts and the app imports updated', () => {
    const analysis = analyse(regeneratedWorkspace(RELOCATED_IMPORTS));

    expectCleanAnalysis(analysis, 'src/types/supabase.ts');
    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expectAllChecksPass(analysis);
  });

  it('passes with types written to src/database.d.ts and the app imports updated', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/database.types.ts': null,
        'src/database.d.ts': rawCliTypes(),
        'src/supabase.ts': replaceOnce(
          SEEDED_SUPABASE,
          './database.types',
          './database'
        ),
        'src/tasks.ts': replaceOnce(
          fixedTasks(),
          './database.types',
          './database'
        ),
      })
    );

    expectCleanAnalysis(analysis, 'src/database.d.ts');
    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expectAllChecksPass(analysis);
  });

  it('passes under a NodeNext tsconfig with .js relative imports', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'tsconfig.json': tsconfigWith({
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        }),
        'src/supabase.ts': replaceOnce(
          SEEDED_SUPABASE,
          './database.types',
          './database.types.js'
        ),
        'src/tasks.ts': replaceOnce(
          replaceOnce(
            fixedTasks(),
            "from './supabase'",
            "from './supabase.js'"
          ),
          './database.types',
          './database.types.js'
        ),
      })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });

  it('judges only the modules the app imports when a stale types file is left unimported', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        ...RELOCATED_IMPORTS,
        'src/database.types.ts': SEEDED_TYPES,
      })
    );

    expectCleanAnalysis(analysis, 'src/types/supabase.ts');
    expect(analysis.appFiles).not.toContain('src/types/supabase.ts');
    expectAllChecksPass(analysis);
  });

  it('keeps a stale unimported types file out of the app files and the suppression scan', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        ...RELOCATED_IMPORTS,
        'src/database.types.ts': `${SEEDED_TYPES}\nexport type Loose = any;\n`,
      })
    );

    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expect(analysis.suppressions).toEqual([]);
  });

  it('judges every types module the app imports, so a stale one in use fails the check', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/types/supabase.ts': regeneratedTypes(),
        'src/tasks.ts': replaceOnce(
          fixedTasks(),
          "import type { Tables } from './database.types';",
          "import type { Tables } from './types/supabase';"
        ),
      })
    );

    expect(analysis.typesModules.map((module) => module.path).sort()).toEqual([
      'src/database.types.ts',
      'src/types/supabase.ts',
    ]);
    const byPath = new Map(
      analysis.typesModules.map((module) => [module.path, module.problems])
    );
    expect(byPath.get('src/database.types.ts')).toContain('tasks Row');
    expect(byPath.get('src/types/supabase.ts')).toEqual([]);
    const types = checkTypesDescribeSchema(analysis);
    expect(types.passed).toBe(false);
    expect(types.notes).toContain('src/database.types.ts');
  });
});

describe('regenerated types that are wrong', () => {
  it.each([
    [
      'Row still has the is_complete column',
      { rowExtra: ['is_complete: boolean;'] },
      'tasks Row',
    ],
    [
      'Insert requires status instead of making it optional',
      { insertStatusRequired: true },
      'tasks Insert',
    ],
    [
      'Insert lacks the optional due_on column',
      { insertOmit: ['due_on'] },
      'tasks Insert',
    ],
    [
      'Update lacks the optional status column',
      { updateOmit: ['status'] },
      'tasks Update',
    ],
    [
      'Update keeps an extra optional is_complete column',
      { updateExtra: ['is_complete?: boolean;'] },
      'tasks Update',
    ],
    [
      'the task_status enum lacks in_progress',
      {
        statusType: "'todo' | 'in_progress' | 'done'",
        enumValues: ['todo', 'done'],
      },
      'task_status enum',
    ],
  ])('flags only the offending part when %s', (_name, options, label) => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/database.types.ts': regeneratedTypes(options),
      })
    );

    expect(analysis.typesModules).toEqual([
      { path: 'src/database.types.ts', problems: [label] },
    ]);
    const types = checkTypesDescribeSchema(analysis);
    expect(types).toMatchObject({ name: TYPES_CHECK, passed: false });
    expect(types.notes).toContain(label);
  });

  it('flags status columns typed any in Row, Insert and Update', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/database.types.ts': regeneratedTypes({ statusType: 'any' }),
      })
    );

    expect(analysis.typesModules).toEqual([
      {
        path: 'src/database.types.ts',
        problems: ['tasks Row', 'tasks Insert', 'tasks Update'],
      },
    ]);
  });

  it.each(['string', 'any'])(
    'flags a task_status enum typed as %s',
    (enumType) => {
      const analysis = analyse(
        regeneratedWorkspace({
          'src/database.types.ts': regeneratedTypes({
            statusType: "'todo' | 'in_progress' | 'done'",
            enumType,
          }),
        })
      );

      expect(analysis.typesModules).toEqual([
        { path: 'src/database.types.ts', problems: ['task_status enum'] },
      ]);
    }
  );

  it('fails the types check without throwing when the types file has a syntax error', () => {
    const truncated = regeneratedTypes();
    const analysis = analyse(
      regeneratedWorkspace({
        'src/database.types.ts': truncated.slice(
          0,
          truncated.indexOf('        Insert: {')
        ),
      })
    );

    expect(checkTypesDescribeSchema(analysis).passed).toBe(false);
    expect(checkAppTypeChecks(analysis).passed).toBe(false);
    expect(analysis.diagnostics.join('\n')).toContain('src/database.types.ts');
  });
});

describe('silencing instead of fixing', () => {
  const staleLabel = fixedTasks(['label']);
  const staleList = fixedTasks(['list']);

  const silenced: {
    name: string;
    tasks: string;
    kind: string;
    needle: string;
  }[] = [
    {
      name: '// @ts-ignore above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `// @ts-ignore\n  ${LABEL_STALE}`
      ),
      kind: '@ts-ignore',
      needle: '// @ts-ignore',
    },
    {
      name: '// @ts-expect-error above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `// @ts-expect-error\n  ${LABEL_STALE}`
      ),
      kind: '@ts-expect-error',
      needle: '// @ts-expect-error',
    },
    {
      name: '/// @ts-ignore above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `/// @ts-ignore\n  ${LABEL_STALE}`
      ),
      kind: '@ts-ignore',
      needle: '/// @ts-ignore',
    },
    {
      name: '/** @ts-ignore */ above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `/** @ts-ignore */\n  ${LABEL_STALE}`
      ),
      kind: '@ts-ignore',
      needle: '/** @ts-ignore */',
    },
    {
      name: 'a block comment ending in @ts-expect-error above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `/*\n   the label reads a column that is gone\n   @ts-expect-error */\n  ${LABEL_STALE}`
      ),
      kind: '@ts-expect-error',
      needle: '@ts-expect-error */',
    },
    {
      name: '/* @ts-ignore */ above a stale line',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        `/* @ts-ignore */\n  ${LABEL_STALE}`
      ),
      kind: '@ts-ignore',
      needle: '/* @ts-ignore */',
    },
    {
      name: '// @ts-nocheck at the top of a stale file',
      tasks: `// @ts-nocheck\n${STALE_TASKS}`,
      kind: '@ts-nocheck',
      needle: '// @ts-nocheck',
    },
    {
      name: '/// @ts-nocheck at the top of a stale file',
      tasks: `/// @ts-nocheck\n${STALE_TASKS}`,
      kind: '@ts-nocheck',
      needle: '/// @ts-nocheck',
    },
    {
      name: 'an (db as any) cast',
      tasks: replaceOnce(
        staleList,
        "await db\n    .from('tasks')\n    .select('*')",
        "await (db as any)\n    .from('tasks')\n    .select('*')"
      ),
      kind: 'any',
      needle: '(db as any)',
    },
    {
      name: 'a double assertion through unknown',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        "return `${(task as unknown as { is_complete: boolean }).is_complete ? '[x]' : '[ ]'} ${task.title}`;"
      ),
      kind: 'as unknown as',
      needle: 'as unknown as',
    },
    {
      name: 'an as never cast on the stale insert',
      tasks: replaceOnce(
        fixedTasks(['add']),
        ADD_STALE,
        '.insert({ title, is_complete: false } as never)'
      ),
      kind: 'as never',
      needle: 'as never',
    },
    {
      name: 'an angle-bracket double assertion through unknown',
      tasks: replaceOnce(
        staleLabel,
        LABEL_STALE,
        "return `${(<{ is_complete: boolean }><unknown>task).is_complete ? '[x]' : '[ ]'} ${task.title}`;"
      ),
      kind: 'double assertion through unknown',
      needle: '<unknown>task',
    },
    {
      name: 'an explicit any parameter',
      tasks: replaceOnce(
        staleLabel,
        'export function label(task: Task)',
        'export function label(task: any)'
      ),
      kind: 'any',
      needle: 'task: any',
    },
  ];

  it.each(silenced)(
    'passes the type-check but fails the silenced check for $name',
    ({ tasks, kind, needle }) => {
      const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));
      const entry = `src/tasks.ts:${lineOf(tasks, needle)} ${kind}`;

      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.suppressions).toEqual([entry]);
      expect(checkTypesDescribeSchema(analysis).passed).toBe(true);
      expect(checkAppTypeChecks(analysis).passed).toBe(true);
      const check = checkAppNotSilenced(analysis);
      expect(check).toMatchObject({ name: SILENCED_CHECK, passed: false });
      expect(check.notes).toContain(entry);
    }
  );

  it('does not count directives or any inside the types module itself', () => {
    const types = `${regeneratedTypes()}\n// @ts-ignore\nexport type Loose = any;\n`;
    const analysis = analyse(
      regeneratedWorkspace({ 'src/database.types.ts': types })
    );

    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('does not count directive text inside string and template literals', () => {
    const tasks = `${fixedTasks()}
export const HINT_IGNORE = '// @ts-ignore';
export const HINT_EXPECT = \`@ts-expect-error\`;
export const HINT_NOCHECK = "/* @ts-nocheck */";
`;
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it.each([
    ['never', 'as never as'],
    ['any', 'as any as'],
  ])('flags a double assertion through %s once', (middle, kind) => {
    const tasks = replaceOnce(
      staleLabel,
      LABEL_STALE,
      `return \`\${(task as ${middle} as { is_complete: boolean }).is_complete ? '[x]' : '[ ]'} \${task.title}\`;`
    );
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([
      `src/tasks.ts:${lineOf(tasks, kind)} ${kind}`,
    ]);
  });

  it.each(['object', '{}', 'Record<string, unknown>', 'Task | undefined'])(
    'flags a double assertion through %s',
    (middle) => {
      const tasks = replaceOnce(
        staleLabel,
        LABEL_STALE,
        `return \`\${(task as ${middle} as { is_complete: boolean }).is_complete ? '[x]' : '[ ]'} \${task.title}\`;`
      );
      const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));
      const entry = `src/tasks.ts:${lineOf(tasks, `as ${middle} as`)} as ${middle} as`;

      expect(analysis.suppressions).toEqual([entry]);
      const check = checkAppNotSilenced(analysis);
      expect(check).toMatchObject({ name: SILENCED_CHECK, passed: false });
      expect(check.notes).toContain(entry);
    }
  );

  it.each([
    ['angle brackets throughout', '<{ is_complete: boolean }><object>task'],
    [
      'an outer angle bracket over an as',
      '<{ is_complete: boolean }>(task as object)',
    ],
    [
      'an outer as over an angle bracket',
      '(<object>task) as { is_complete: boolean }',
    ],
  ])(
    'flags a double assertion through object written with %s',
    (_name, expr) => {
      const tasks = replaceOnce(
        staleLabel,
        LABEL_STALE,
        `return \`\${(${expr}).is_complete ? '[x]' : '[ ]'} \${task.title}\`;`
      );
      const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

      expect(analysis.suppressions).toEqual([
        `src/tasks.ts:${lineOf(tasks, 'object')} double assertion through object`,
      ]);
    }
  );

  it('does not flag a nested assertion that involves as const', () => {
    const tasks = `${fixedTasks()}
export const PAIR = ['a', 'b'] as const as readonly string[];
export const TUPLE = ([1, 2] as number[]) as const;
`;
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.suppressions).toEqual([]);
  });

  const UNTYPED_CLIENT = (client: string) =>
    `import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

${client}
`;

  it.each([
    [
      'a SupabaseClient alias without type arguments',
      `export type Client = SupabaseClient;

export function connect(url: string, key: string): Client {
  return createClient<Database>(url, key);
}`,
      'export type Client = SupabaseClient;',
    ],
    [
      'a SupabaseClient alias with an untyped createClient',
      `export type Client = SupabaseClient;

export function connect(url: string, key: string): Client {
  return createClient(url, key);
}`,
      'export type Client = SupabaseClient;',
    ],
    [
      'a createClient call with no contextual type',
      `export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string) {
  return createClient(url, key);
}`,
      'return createClient(url, key);',
    ],
    [
      'a const initialised from an untyped createClient',
      `export type Client = SupabaseClient<Database>;

export const db = createClient(process.env.URL ?? '', process.env.KEY ?? '');`,
      'export const db = createClient',
    ],
  ])('flags an untyped Supabase client from %s', (_name, client, needle) => {
    const supabase = UNTYPED_CLIENT(client);
    const analysis = analyse(
      regeneratedWorkspace({ 'src/supabase.ts': supabase })
    );
    const entry = `src/supabase.ts:${lineOf(supabase, needle)} untyped Supabase client`;

    expect(analysis.suppressions).toEqual([entry]);
    const check = checkAppNotSilenced(analysis);
    expect(check).toMatchObject({ name: SILENCED_CHECK, passed: false });
    expect(check.notes).toContain(entry);
  });

  it.each([
    [
      'a createClient assigned to a typed const',
      `export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string): Client {
  const db: SupabaseClient<Database> = createClient(url, key);
  return db;
}`,
    ],
    [
      'a createClient returned from a function declared to return the typed client',
      `export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string): SupabaseClient<Database> {
  return createClient(url, key);
}`,
    ],
    [
      'createClient with explicit type arguments',
      `export type Client = SupabaseClient<Database>;

export function connect(url: string, key: string) {
  return createClient<Database>(url, key);
}`,
    ],
  ])('does not flag %s', (_name, client) => {
    const analysis = analyse(
      regeneratedWorkspace({ 'src/supabase.ts': UNTYPED_CLIENT(client) })
    );

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('does not count a block comment whose lines only mention a directive', () => {
    const tasks = `${fixedTasks()}
/*
 * we dropped the ts-ignore that used to sit here
 * and the (@ts-nocheck) header, see @ts-expect-error in the docs
 */
// the old ts-ignore is gone
`;
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('does not count a comment that merely mentions a directive after other text', () => {
    const tasks = `${fixedTasks()}
// we no longer need @ts-ignore here
/* see @ts-expect-error in the docs */
`;
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('does not flag ordinary assertions, unknown, catch clauses or added helpers', () => {
    const tasks = `${fixedTasks()}
export const DONE = 'done' as const;

export function parseTask(value: unknown): Task {
  return value as Task;
}

export function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch (e) {
    return undefined;
  }
}
`;
    const analysis = analyse(regeneratedWorkspace({ 'src/tasks.ts': tasks }));

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });
});

describe('files that re-export Database', () => {
  const SILENCED_CLIENT = (
    reexport: string
  ) => `import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
${reexport}

export type Client = SupabaseClient<any>;

export function connect(url: string, key: string): Client {
  // @ts-ignore
  return createClient<Database>(url, key);
}
`;

  it.each([
    "export type { Database } from './database.types';",
    "export * from './database.types';",
    'export type { Database };',
  ])(
    'keeps a file with `%s` an app file, so its suppressions count',
    (reexport) => {
      const supabase = SILENCED_CLIENT(reexport);
      const analysis = analyse(
        regeneratedWorkspace({ 'src/supabase.ts': supabase })
      );

      expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
      expect(analysis.typesModules).toEqual([
        { path: 'src/database.types.ts', problems: [] },
      ]);
      expect(analysis.suppressions).toEqual([
        `src/supabase.ts:${lineOf(supabase, 'any')} any`,
        `src/supabase.ts:${lineOf(supabase, '@ts-ignore')} @ts-ignore`,
      ]);
      expect(checkAppNotSilenced(analysis).passed).toBe(false);
    }
  );

  it('still excludes the file that declares Database from the app files', () => {
    const analysis = analyse(regeneratedWorkspace());

    expect(analysis.appFiles).not.toContain('src/database.types.ts');
  });
});

describe('types modules found through the checker', () => {
  const retarget = (source: string, to: string) =>
    replaceOnce(source, "'./database.types'", `'${to}'`);
  const appImporting = (specifier: string) => ({
    'src/supabase.ts': retarget(SEEDED_SUPABASE, specifier),
    'src/tasks.ts': retarget(fixedTasks(), specifier),
  });

  it('finds regenerated types outside src imported directly', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': null,
        'types/database.ts': regeneratedTypes(),
        ...appImporting('../types/database'),
      })
    );

    expectCleanAnalysis(analysis, 'types/database.ts');
    expectAllChecksPass(analysis);
  });

  it('follows an export * barrel outside src to the file that declares Database', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': null,
        'types/database.ts': regeneratedTypes(),
        'types/index.ts': "export * from './database';\n",
        ...appImporting('../types'),
      })
    );

    expectCleanAnalysis(analysis, 'types/database.ts');
    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expectAllChecksPass(analysis);
  });

  it('fails the types check for stale types behind an export * barrel', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': null,
        'types/database.ts': SEEDED_TYPES,
        'types/index.ts': "export * from './database';\n",
        ...appImporting('../types'),
      })
    );

    expect(analysis.typesModules.map((module) => module.path)).toEqual([
      'types/database.ts',
    ]);
    expect(analysis.typesModules[0].problems).toContain('tasks Row');
    expect(checkTypesDescribeSchema(analysis).passed).toBe(false);
  });

  it('follows a named re-export barrel inside src and keeps the barrel an app file', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': null,
        'src/types/database.ts': regeneratedTypes(),
        'src/types/index.ts':
          "export type { Database, Tables } from './database';\n",
        ...appImporting('./types'),
      })
    );

    expectCleanAnalysis(analysis, 'src/types/database.ts');
    expect(analysis.appFiles).toEqual([
      'src/supabase.ts',
      'src/tasks.ts',
      'src/types/index.ts',
    ]);
    expectAllChecksPass(analysis);
  });

  it('finds regenerated types through a tsconfig paths alias', () => {
    const base = JSON.parse(readLocal('tsconfig.json'));
    const analysis = analyse(
      regeneratedWorkspace({
        'tsconfig.json': JSON.stringify({
          ...base,
          compilerOptions: {
            ...base.compilerOptions,
            baseUrl: '.',
            paths: { '@/*': ['src/*'] },
          },
        }),
        ...appImporting('@/database.types'),
      })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });
});

describe('removing app functions', () => {
  it('pins the exports the check looks for', () => {
    expect([...APP_EXPORTS]).toEqual([
      'listOpenTasks',
      'addTask',
      'completeTask',
      'label',
    ]);
  });

  it.each([...APP_EXPORTS])(
    'reports %s as missing when its function is deleted',
    (name) => {
      const analysis = analyse(
        regeneratedWorkspace({
          'src/tasks.ts': withoutFunction(fixedTasks(), name),
        })
      );

      expect(analysis.missingExports).toEqual([name]);
      expect(analysis.diagnostics).toEqual([]);
      expect(checkAppTypeChecks(analysis).passed).toBe(true);
      const check = checkAppNotSilenced(analysis);
      expect(check).toMatchObject({ name: SILENCED_CHECK, passed: false });
      expect(check.notes).toContain(name);
    }
  );

  const board = `import type { Task } from './tasks';

export function label(task: Task): string {
  ${LABEL_FIXED}
}
`;

  it('accepts label re-exported from another file under src', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/tasks.ts': `${withoutFunction(fixedTasks(), 'label')}\nexport { label } from './board';\n`,
        'src/board.ts': board,
      })
    );

    expect(analysis.missingExports).toEqual([]);
    expect(analysis.diagnostics).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('accepts label defined only in another file under src', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/tasks.ts': withoutFunction(fixedTasks(), 'label'),
        'src/board.ts': board,
      })
    );

    expect(analysis.missingExports).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('accepts label exported as an arrow function', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/tasks.ts': `${withoutFunction(fixedTasks(), 'label')}\nexport const label = (task: Task): string => {\n  ${LABEL_FIXED}\n};\n`,
      })
    );

    expect(analysis.missingExports).toEqual([]);
    expectAllChecksPass(analysis);
  });
});

describe('an agent weakening the scorer inputs', () => {
  it('still reports diagnostics when tsconfig is loosened and include is emptied', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': regeneratedTypes(),
        'tsconfig.json': tsconfigWith({ strict: false }, []),
      })
    );

    expect(
      analysis.diagnostics.some(
        (diagnostic) =>
          diagnostic.startsWith('src/tasks.ts:') &&
          diagnostic.includes('is_complete')
      )
    ).toBe(true);
    expect(checkAppTypeChecks(analysis).passed).toBe(false);
  });

  it('enforces strict mode even when tsconfig turns it off', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'tsconfig.json': tsconfigWith({ strict: false }),
        'src/loose.ts': 'export function echo(value) {\n  return value;\n}\n',
      })
    );

    expect(
      analysis.diagnostics.some(
        (diagnostic) =>
          diagnostic.startsWith('src/loose.ts:1 ') &&
          diagnostic.includes('implicitly')
      )
    ).toBe(true);
    expect(checkAppTypeChecks(analysis).passed).toBe(false);
  });

  it('fails the types and type-check checks when tsconfig sets noCheck', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/tasks.ts': fixedTasks(),
        'tsconfig.json': tsconfigWith({ noCheck: true }),
      })
    );

    expect(checkTypesDescribeSchema(analysis).passed).toBe(false);
    expect(checkAppTypeChecks(analysis).passed).toBe(false);
  });

  it('still passes a correct workspace when tsconfig sets noCheck', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'tsconfig.json': tsconfigWith({ noCheck: true }),
      })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });

  it.each([
    [
      'strictNullChecks',
      'export const missing: string = null;\n',
      'not assignable',
    ],
    [
      'noImplicitAny',
      'export function echo(value) {\n  return value;\n}\n',
      'implicitly',
    ],
    [
      'useUnknownInCatchVariables',
      'export function attempt() {\n  try {\n    return 1;\n  } catch (e) {\n    return e.message;\n  }\n}\n',
      "'unknown'",
    ],
    [
      'strictPropertyInitialization',
      'export class Holder {\n  value: string;\n}\n',
      'no initializer',
    ],
  ])(
    'enforces %s even when tsconfig turns it off',
    (option, source, expected) => {
      const analysis = analyse(
        regeneratedWorkspace({
          'tsconfig.json': tsconfigWith({ [option]: false }),
          'src/loose.ts': source,
        })
      );

      expect(
        analysis.diagnostics.some(
          (diagnostic) =>
            diagnostic.startsWith('src/loose.ts:') &&
            diagnostic.includes(expected)
        )
      ).toBe(true);
      expect(checkAppTypeChecks(analysis).passed).toBe(false);
    }
  );

  it('flags a non-null due_on even when tsconfig turns strictNullChecks off', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'src/database.types.ts': replaceOnce(
          regeneratedTypes(),
          'due_on: string | null;',
          'due_on: string;'
        ),
        'tsconfig.json': tsconfigWith({ strictNullChecks: false }),
      })
    );

    expect(analysis.typesModules).toEqual([
      { path: 'src/database.types.ts', problems: ['tasks Row'] },
    ]);
    expect(checkTypesDescribeSchema(analysis).passed).toBe(false);
  });

  it('fails the types check when the checker reports nothing for the known-bad control', () => {
    blindChecker.on = true;

    const analysis = analyse(regeneratedWorkspace());

    expect(analysis.typesModules).toEqual([
      {
        path: 'src/database.types.ts',
        problems: [
          'type checker produced no diagnostics for a known-bad control',
        ],
      },
    ]);
    expect(checkTypesDescribeSchema(analysis).passed).toBe(false);
  });

  it('ignores a tsconfig path mapping that redirects @supabase/supabase-js', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'tsconfig.json': tsconfigWith({
          paths: { '@supabase/supabase-js': ['./nowhere'] },
        }),
      })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });

  it('ignores the workspace node_modules copy of @supabase/supabase-js and skips node_modules under src', () => {
    const analysis = analyse(
      regeneratedWorkspace({
        'node_modules/@supabase/supabase-js/package.json': JSON.stringify({
          name: '@supabase/supabase-js',
          version: '0.0.0',
          types: './empty.d.ts',
        }),
        'node_modules/@supabase/supabase-js/empty.d.ts': 'export {};\n',
        'src/node_modules/dep/broken.ts':
          "export const broken: number = 'not a number';\n",
      })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expectAllChecksPass(analysis);
  });

  it('leaves declaration files out of the project files and the suppression scan', () => {
    const analysis = analyse(
      regeneratedWorkspace({ 'src/env.d.ts': 'declare const __DEV__: any;\n' })
    );

    expect(analysis.appFiles).toEqual(['src/supabase.ts', 'src/tasks.ts']);
    expect(analysis.suppressions).toEqual([]);
    expectAllChecksPass(analysis);
  });

  it('falls back to default compiler options when tsconfig.json is malformed', () => {
    const analysis = analyse(
      regeneratedWorkspace({ 'tsconfig.json': '{ "compilerOptions": ' })
    );

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });

  it('falls back to default compiler options when tsconfig.json is missing', () => {
    const analysis = analyse(regeneratedWorkspace({ 'tsconfig.json': null }));

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expectAllChecksPass(analysis);
  });
});

describe('symbolic links under src', () => {
  const appFiles = ['src/supabase.ts', 'src/tasks.ts'];

  it('skips a dangling symlink instead of reporting it', () => {
    const dir = regeneratedWorkspace();
    fs.symlinkSync(
      path.join(dir, 'src/missing.ts'),
      path.join(dir, 'src/dangling.ts')
    );

    const analysis = analyse(dir);

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expect(analysis.appFiles).toEqual(appFiles);
    expectAllChecksPass(analysis);
  });

  it('does not read a symlink to a file or directory outside the workspace', () => {
    const outside = makeWorkspace({
      'outside.ts': 'export const loose: any = 1;\n',
      'dir/nested.ts': 'export const nested: any = 1;\n',
    });
    const dir = regeneratedWorkspace();
    fs.symlinkSync(
      path.join(outside, 'outside.ts'),
      path.join(dir, 'src/outside.ts')
    );
    fs.symlinkSync(path.join(outside, 'dir'), path.join(dir, 'src/linked'));

    const analysis = analyse(dir);

    expectCleanAnalysis(analysis, 'src/database.types.ts');
    expect(analysis.appFiles).toEqual(appFiles);
    expectAllChecksPass(analysis);
  });
});

describe('an app that imports no types module', () => {
  it('fails the types check even though the app compiles and nothing is silenced', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': regeneratedTypes(),
        'src/supabase.ts': null,
        'src/tasks.ts': `export type Task = {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  inserted_at: string;
  due_on: string | null;
};

export function listOpenTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.status !== 'done');
}

export function addTask(tasks: Task[], title: string): Task {
  const task: Task = {
    id: tasks.length + 1,
    title,
    status: 'todo',
    inserted_at: new Date().toISOString(),
    due_on: null,
  };
  tasks.push(task);
  return task;
}

export function completeTask(tasks: Task[], id: number): void {
  for (const task of tasks) {
    if (task.id === id) task.status = 'done';
  }
}

export function label(task: Task): string {
  ${LABEL_FIXED}
}
`,
      })
    );

    expect(analysis.typesModules).toEqual([]);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.suppressions).toEqual([]);
    expect(analysis.missingExports).toEqual([]);
    const types = checkTypesDescribeSchema(analysis);
    expect(types).toMatchObject({ name: TYPES_CHECK, passed: false });
    expect(types.notes).toContain(
      'no app file imports a module that exports Database'
    );
    expect(checkAppTypeChecks(analysis).passed).toBe(true);
    expect(checkAppNotSilenced(analysis).passed).toBe(true);
  });
});

describe('a src with no app files', () => {
  it('fails the type-check check instead of passing with nothing to check', () => {
    const analysis = analyse(
      makeWorkspace({
        'src/database.types.ts': regeneratedTypes(),
        'src/supabase.ts': null,
        'src/tasks.ts': null,
      })
    );

    expect(analysis.appFiles).toEqual([]);
    expect(analysis.diagnostics).toEqual([]);
    expect(checkAppTypeChecks(analysis)).toMatchObject({
      name: TYPECHECK_CHECK,
      passed: false,
      notes: 'no app files to type-check',
    });
  });
});

describe('a workspace that cannot be analysed', () => {
  function expectAllChecksFail(analysis: ProjectAnalysis) {
    for (const [check, name] of [
      [checkTypesDescribeSchema(analysis), TYPES_CHECK],
      [checkAppTypeChecks(analysis), TYPECHECK_CHECK],
      [checkAppNotSilenced(analysis), SILENCED_CHECK],
    ] as const) {
      expect(check).toMatchObject({ name, passed: false });
      expect(check.notes).toBeTruthy();
    }
  }

  it('reports ok false and fails every check when src is missing', () => {
    const analysis = analyseProject(makeWorkspace({ src: null }));

    expect(analysis).toMatchObject({ ok: false });
    expect(analysis.ok ? '' : analysis.notes).toMatch(/src/);
    expectAllChecksFail(analysis);
  });

  it('reports ok false and fails every check when the workspace directory does not exist', () => {
    const missing = path.join(makeWorkspace(), 'does-not-exist');
    const analysis = analyseProject(missing);

    expect(analysis).toMatchObject({ ok: false });
    expectAllChecksFail(analysis);
  });
});
