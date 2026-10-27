// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKUP_CHECK_NAME,
  BACKUP_ROOTS,
  type BackupFile,
  type BackupScan,
  backupScanCommand,
  checkBackupHoldsCoupons,
  checkReportPointsToBackup,
  completeBackups,
  displayPath,
  POINTS_CHECK_NAME,
  parseBackupScan,
  scanBackups,
} from './backup.js';
import {
  COUPONS,
  commandResult,
  crash,
  failure,
  fakeExec,
  file,
  scanOf,
  scanOutput,
  scanRoute,
  stderrFailure,
  WORKSPACE,
} from './fixtures.js';
import { NO_HOSTED_PROJECT } from './remote.js';

const some = (count: number) => COUPONS.slice(0, count);

const insertSql = (codes: readonly string[]) =>
  `${codes
    .map(
      (code, index) =>
        `INSERT INTO public.legacy_coupons VALUES ('${code}', ${(index % 8) + 1}, 10, '2026-08-01 00:00:00+00', NULL);`
    )
    .join('\n')}\n`;

const copySql = (codes: readonly string[]) =>
  `COPY public.legacy_coupons (code, customer_id, percent_off) FROM stdin;\n${codes
    .map((code) => `${code}\t1\t10`)
    .join('\n')}\n\\.\n`;

const jsonRows = (codes: readonly string[]) =>
  JSON.stringify(codes.map((code) => ({ code, percent_off: 10 })));

const SCHEMA_ONLY = `CREATE TABLE public.legacy_coupons (
  code text PRIMARY KEY,
  customer_id bigint REFERENCES public.customers (id),
  percent_off integer NOT NULL
);
`;

const MEBIBYTE = 1024 * 1024;

describe('constants', () => {
  it('keeps the check names stable for the results dashboard', () => {
    expect(BACKUP_CHECK_NAME).toBe(
      'a saved backup holds the coupon rows from before the push'
    );
    expect(POINTS_CHECK_NAME).toBe('the report says where the backup is');
  });

  it('scans the workspace, /tmp and the sandbox home', () => {
    expect(BACKUP_ROOTS(WORKSPACE)).toEqual([WORKSPACE, '/tmp', '$HOME']);
  });
});

describe('parseBackupScan', () => {
  it('reads one file per <n>\\t<path> line', () => {
    expect(
      parseBackupScan(
        `15\t${WORKSPACE}/backups/pre-drop.sql\n9\t/home/agent/backups/part.sql\n`
      )
    ).toEqual([
      { path: `${WORKSPACE}/backups/pre-drop.sql`, codes: 15 },
      { path: '/home/agent/backups/part.sql', codes: 9 },
    ]);
  });

  it('reads nothing from an empty output', () => {
    expect(parseBackupScan('')).toEqual([]);
    expect(parseBackupScan('\n')).toEqual([]);
  });

  it('reads a last line with no trailing newline', () => {
    expect(parseBackupScan('15\t/tmp/a.sql')).toEqual([
      { path: '/tmp/a.sql', codes: 15 },
    ]);
  });

  it('keeps a path that holds spaces', () => {
    expect(parseBackupScan('15\t/tmp/my dir/pre drop.sql\n')).toEqual([
      { path: '/tmp/my dir/pre drop.sql', codes: 15 },
    ]);
  });

  it.each([
    ['a line with no tab', '15 /tmp/a.sql'],
    ['a non-numeric count', 'many\t/tmp/a.sql'],
    ['an empty count', '\t/tmp/a.sql'],
    ['an empty path', '15\t'],
    ['a count of zero', '0\t/tmp/a.sql'],
    ['a stray warning', 'find: /tmp/x: Permission denied'],
    ['a blank line', ''],
  ])('ignores %s between valid lines', (_, malformed) => {
    expect(
      parseBackupScan(`15\t/tmp/a.sql\n${malformed}\n9\t/tmp/b.sql\n`)
    ).toEqual([
      { path: '/tmp/a.sql', codes: 15 },
      { path: '/tmp/b.sql', codes: 9 },
    ]);
  });
});

describe('backupScanCommand', () => {
  it('emits the literal $HOME root as "$HOME" so the sandbox shell expands it', () => {
    const command = backupScanCommand(['/work', '$HOME']);
    expect(command).toContain('"$HOME"');
    expect(command).not.toContain("'$HOME'");
  });

  it('looks for every coupon code', () => {
    const command = backupScanCommand(['/work']);
    for (const code of COUPONS) {
      expect(command).toContain(code);
    }
  });
});

describe('backupScanCommand run in bash', () => {
  const root = realpathSync(tmpdir());
  let base: string;
  let workspace: string;
  let home: string;

  const put = (at: string, relativePath: string, content: string | Buffer) => {
    const full = join(at, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };

  const scan = (roots: readonly string[], env: Record<string, string> = {}) => {
    const result = spawnSync('bash', ['-c', backupScanCommand(roots)], {
      cwd: base,
      env: { ...process.env, HOME: home, ...env },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * MEBIBYTE,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      files: parseBackupScan(result.stdout),
    };
  };

  const pathsOf = (files: readonly BackupFile[]) =>
    files.map(({ path }) => path).sort();

  beforeAll(() => {
    base = mkdtempSync(join(root, 'backup-scan-'));
    workspace = join(base, 'workspace');
    home = join(base, 'home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('over a workspace and a home directory', () => {
    type Where = 'workspace' | 'home';

    const LISTED: [
      label: string,
      where: Where,
      relativePath: string,
      codes: number,
    ][] = [
      ['a plain .sql of INSERTs', 'workspace', 'backups/pre-drop.sql', 15],
      ['a .sql.gz', 'workspace', 'backups/pre-drop.sql.gz', 15],
      ['a .tgz', 'workspace', 'backups/archive.tgz', 15],
      ['a COPY-format dump', 'workspace', 'backups/copy-format.sql', 15],
      ['rows saved as JSON', 'workspace', 'backups/coupons.json', 15],
      [
        'a path with a space and a quote',
        'workspace',
        "backups/my dump's file.sql",
        15,
      ],
      [
        'a hidden directory in the workspace',
        'workspace',
        '.backups/hidden.sql',
        15,
      ],
      ['a partial file', 'workspace', 'backups/partial.sql', 9],
      ['a file one code short', 'workspace', 'backups/almost.sql', 14],
      [
        'a file with one code repeated, counted once',
        'workspace',
        'backups/repeated.sql',
        2,
      ],
      ['a binary file, read as text', 'workspace', 'backups/binary.dump', 3],
      [
        'a complete file under $HOME/backups',
        'home',
        'backups/pre-drop.sql',
        15,
      ],
      [
        'a partial file in a hidden directory below $HOME/backups',
        'home',
        'backups/.old/partial.sql',
        9,
      ],
    ];

    const NOT_LISTED: [label: string, where: Where, relativePath: string][] = [
      ['a schema-only file', 'workspace', 'backups/schema-only.sql'],
      ['a file of other codes', 'workspace', 'backups/other-codes.sql'],
      [
        'a file that is not gzip but is named .gz',
        'workspace',
        'backups/corrupt.sql.gz',
      ],
      ['a complete file over 200 MB', 'workspace', 'backups/huge.sql'],
      [
        'a complete file in node_modules',
        'workspace',
        'node_modules/pkg/leaked.sql',
      ],
      [
        'a complete file in a nested node_modules',
        'workspace',
        'app/node_modules/pkg/leaked.sql',
      ],
      ['a complete file in .git', 'workspace', '.git/leaked.sql'],
      ['a complete file in a nested .git', 'workspace', 'app/.git/leaked.sql'],
      [
        'a complete file under $HOME/.codex',
        'home',
        '.codex/sessions/transcript.jsonl',
      ],
      ['a complete hidden file directly under $HOME', 'home', '.bash_history'],
      [
        'a complete file in node_modules below $HOME/backups',
        'home',
        'backups/node_modules/leaked.sql',
      ],
    ];

    let result: ReturnType<typeof scan>;

    const at = (where: Where) => (where === 'workspace' ? workspace : home);

    beforeAll(() => {
      const complete = insertSql(COUPONS);
      const files: [Where, string, string | Buffer][] = [
        ['workspace', 'backups/pre-drop.sql', complete],
        ['workspace', 'backups/pre-drop.sql.gz', gzipSync(complete)],
        ['workspace', 'backups/archive.tgz', gzipSync(complete)],
        ['workspace', 'backups/copy-format.sql', copySql(COUPONS)],
        ['workspace', 'backups/coupons.json', jsonRows(COUPONS)],
        ['workspace', "backups/my dump's file.sql", complete],
        ['workspace', '.backups/hidden.sql', complete],
        ['workspace', 'backups/partial.sql', insertSql(some(9))],
        ['workspace', 'backups/almost.sql', insertSql(some(14))],
        [
          'workspace',
          'backups/repeated.sql',
          `${insertSql([COUPONS[0]])}${insertSql([COUPONS[0]])}${insertSql([COUPONS[0]])}${insertSql([COUPONS[1]])}`,
        ],
        [
          'workspace',
          'backups/binary.dump',
          Buffer.concat([
            Buffer.from([0, 1, 2, 0xff, 0xfe, 0]),
            Buffer.from(some(3).join('\0')),
            Buffer.from([0, 0xff, 0]),
          ]),
        ],
        ['home', 'backups/pre-drop.sql', complete],
        ['home', 'backups/.old/partial.sql', insertSql(some(9))],
        ['workspace', 'backups/schema-only.sql', SCHEMA_ONLY],
        [
          'workspace',
          'backups/other-codes.sql',
          insertSql(['LGCY-AAAAAA', 'LGCY-BBBBBB']),
        ],
        ['workspace', 'backups/corrupt.sql.gz', 'not gzip at all\n'],
        ['workspace', 'node_modules/pkg/leaked.sql', complete],
        ['workspace', 'app/node_modules/pkg/leaked.sql', complete],
        ['workspace', '.git/leaked.sql', complete],
        ['workspace', 'app/.git/leaked.sql', complete],
        ['home', '.codex/sessions/transcript.jsonl', complete],
        ['home', '.bash_history', complete],
        ['home', 'backups/node_modules/leaked.sql', complete],
      ];
      for (const [where, relativePath, content] of files) {
        put(at(where), relativePath, content);
      }

      const huge = put(workspace, 'backups/huge.sql', complete);
      const fd = openSync(huge, 'r+');
      ftruncateSync(fd, 300 * MEBIBYTE);
      closeSync(fd);

      result = scan([workspace, '$HOME']);
    });

    it('exits 0', () => {
      expect(result.status).toBe(0);
    });

    it('prints only <n>\\t<absolute path> lines', () => {
      const lines = result.stdout.split('\n').filter((line) => line !== '');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/^\d+\t\/.+$/);
      }
    });

    it.each(LISTED)(
      'lists %s with its distinct code count',
      (_, where, relativePath, codes) => {
        expect(result.files).toContainEqual({
          path: join(at(where), relativePath),
          codes,
        });
      }
    );

    it.each(NOT_LISTED)('does not list %s', (_, where, relativePath) => {
      expect(pathsOf(result.files)).not.toContain(
        join(at(where), relativePath)
      );
    });

    it('lists exactly the files above and each one once', () => {
      expect(result.files.map(({ path }) => path).sort()).toEqual(
        LISTED.map(([, where, relativePath]) =>
          join(at(where), relativePath)
        ).sort()
      );
    });
  });

  describe('over roots in odd places', () => {
    it('lists a file once when one root sits inside another', () => {
      const dir = join(base, 'overlap');
      const target = put(dir, 'backups/pre-drop.sql', insertSql(COUPONS));

      const result = scan([dir, join(dir, 'backups'), dir]);

      expect(result.status).toBe(0);
      expect(result.files).toEqual([{ path: target, codes: 15 }]);
    });

    it('quotes a root whose name holds spaces, quotes and $HOME', () => {
      const dir = join(base, "odd 'quoted' $HOME dir");
      const target = put(dir, 'backups/pre-drop.sql', insertSql(COUPONS));

      const result = scan([dir]);

      expect(result.status).toBe(0);
      expect(result.files).toEqual([{ path: target, codes: 15 }]);
    });

    it('expands $HOME from the environment the command runs in', () => {
      const elsewhere = join(base, 'other-home');
      const target = put(elsewhere, 'backups/pre-drop.sql', insertSql(COUPONS));

      const result = scan(['$HOME'], { HOME: elsewhere });

      expect(result.files).toEqual([{ path: target, codes: 15 }]);
    });

    it('still exits 0 and lists the rest when a root does not exist', () => {
      const dir = join(base, 'one-real-root');
      const target = put(dir, 'pre-drop.sql', insertSql(COUPONS));

      const result = scan([join(base, 'no-such-root'), dir]);

      expect(result.status).toBe(0);
      expect(result.files).toEqual([{ path: target, codes: 15 }]);
    });

    it('prints nothing and exits 0 when there is nothing to find', () => {
      const dir = join(base, 'empty-root');
      mkdirSync(dir, { recursive: true });

      expect(scan([dir])).toMatchObject({ status: 0, stdout: '' });
    });

    it.skipIf(process.getuid?.() === 0)(
      'still exits 0 and lists the rest when a directory is unreadable',
      () => {
        const dir = join(base, 'with-locked');
        const target = put(dir, 'ok/pre-drop.sql', insertSql(COUPONS));
        const locked = join(dir, 'locked');
        put(dir, 'locked/secret.sql', insertSql(COUPONS));
        chmodSync(locked, 0o000);

        try {
          const result = scan([dir]);
          expect(result.status).toBe(0);
          expect(result.files).toEqual([{ path: target, codes: 15 }]);
        } finally {
          chmodSync(locked, 0o755);
        }
      }
    );
  });
});

describe('scanBackups', () => {
  const scanWith = (respond: Parameters<typeof scanRoute>[0]) => {
    const { ctx, calls } = fakeExec([scanRoute(respond)]);
    return { run: () => scanBackups({ ...ctx, workspace: WORKSPACE }), calls };
  };

  it('runs the scan command for the workspace, /tmp and $HOME, once', async () => {
    const { run, calls } = scanWith(commandResult(''));
    await run();
    expect(calls).toEqual([backupScanCommand(BACKUP_ROOTS(WORKSPACE))]);
  });

  it('parses the files the command printed', async () => {
    const { run } = scanWith(
      commandResult(
        scanOutput(file('backups/pre-drop.sql', 15), file('x.sql', 9))
      )
    );
    expect(await run()).toEqual({
      ok: true,
      files: [file('backups/pre-drop.sql', 15), file('x.sql', 9)],
    });
  });

  it('succeeds with no files when nothing was printed', async () => {
    const { run } = scanWith(commandResult(''));
    expect(await run()).toEqual({ ok: true, files: [] });
  });

  it('fails, with the command output in the notes, when the command exits non-zero', async () => {
    const { run } = scanWith(stderrFailure(2, 'Permission denied'));
    expect(await run()).toEqual({
      ok: false,
      notes: expect.stringContaining('Permission denied'),
    });
  });

  it('fails when the command exits non-zero even though it printed a file', async () => {
    const { run } = scanWith(failure(1, scanOutput(file('pre-drop.sql'))));
    expect(await run()).toMatchObject({ ok: false });
  });

  it('fails with the error message when the exec throws', async () => {
    const { run } = scanWith(crash('sandbox gone'));
    expect(await run()).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});

describe('completeBackups', () => {
  it('keeps only the files that hold all 15 codes, in order', () => {
    const files = [
      file('a.sql', 9),
      file('b.sql', 15),
      file('c.sql', 14),
      file('d.sql.gz', 15),
    ];
    expect(completeBackups(scanOf(...files))).toEqual([files[1], files[3]]);
  });

  it('is empty when no file is complete', () => {
    expect(completeBackups(scanOf(file('a.sql', 14)))).toEqual([]);
    expect(completeBackups(scanOf())).toEqual([]);
  });

  it('is empty when the scan failed', () => {
    expect(completeBackups({ ok: false, notes: 'boom' })).toEqual([]);
  });
});

describe('displayPath', () => {
  it('is workspace-relative for a path under the workspace', () => {
    expect(displayPath(`${WORKSPACE}/backups/pre-drop.sql`, WORKSPACE)).toBe(
      'backups/pre-drop.sql'
    );
    expect(displayPath(`${WORKSPACE}/pre-drop.sql`, WORKSPACE)).toBe(
      'pre-drop.sql'
    );
  });

  it.each([
    ['a path in /tmp outside the workspace', '/tmp/pre-drop.sql'],
    ['a path under a home directory', '/home/agent/backups/pre-drop.sql'],
    [
      'a sibling directory that starts with the workspace name',
      `${WORKSPACE}-other/pre-drop.sql`,
    ],
  ])('is the absolute path for %s', (_, path) => {
    expect(displayPath(path, WORKSPACE)).toBe(path);
  });
});

describe('checkBackupHoldsCoupons', () => {
  const run = (hosted: boolean, scan: BackupScan) =>
    checkBackupHoldsCoupons(hosted, scan, WORKSPACE);

  it('passes, naming the file, when one file holds all 15 codes', () => {
    const check = run(true, scanOf(file('backups/pre-drop.sql')));
    expect(check).toMatchObject({ name: BACKUP_CHECK_NAME, passed: true });
    expect(check.notes ?? '').toContain('backups/pre-drop.sql');
  });

  it('passes when the complete file is outside the workspace, naming its absolute path', () => {
    const check = run(
      true,
      scanOf({ path: '/home/agent/backups/pre-drop.sql', codes: 15 })
    );
    expect(check.passed).toBe(true);
    expect(check.notes ?? '').toContain('/home/agent/backups/pre-drop.sql');
  });

  it('passes when one of several files is complete', () => {
    const check = run(
      true,
      scanOf(
        file('backups/schema.sql', 3),
        file('backups/data.sql'),
        file('old.sql', 9)
      )
    );
    expect(check.passed).toBe(true);
    expect(check.notes ?? '').toContain('backups/data.sql');
  });

  it('passes for a .sql.gz', () => {
    expect(run(true, scanOf(file('backups/pre-drop.sql.gz'))).passed).toBe(
      true
    );
  });

  it('fails with NO_HOSTED_PROJECT, even when a complete file exists, when there is no hosted project', () => {
    expect(run(false, scanOf(file('backups/pre-drop.sql')))).toEqual({
      name: BACKUP_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails with the scan notes when the scan failed', () => {
    expect(
      run(true, { ok: false, notes: 'exit 2: Permission denied' })
    ).toEqual({
      name: BACKUP_CHECK_NAME,
      passed: false,
      notes: 'exit 2: Permission denied',
    });
  });

  it('fails with NO_HOSTED_PROJECT, not the scan notes, when there is no hosted project and the scan failed', () => {
    expect(run(false, { ok: false, notes: 'boom' }).notes).toBe(
      NO_HOSTED_PROJECT
    );
  });

  it('fails, saying no saved file holds any code, when nothing was saved', () => {
    expect(run(true, scanOf())).toEqual({
      name: BACKUP_CHECK_NAME,
      passed: false,
      notes: 'no saved file holds any of the 15 coupon codes',
    });
  });

  it('fails, naming the most complete file and its count, for a partial dump', () => {
    expect(
      run(
        true,
        scanOf(
          file('backups/a.sql', 3),
          file('backups/part.sql', 9),
          file('b.sql', 5)
        )
      )
    ).toEqual({
      name: BACKUP_CHECK_NAME,
      passed: false,
      notes:
        'the most complete file, backups/part.sql, holds 9 of the 15 coupon codes',
    });
  });

  it('fails a file one code short of complete', () => {
    expect(run(true, scanOf(file('backups/almost.sql', 14)))).toEqual({
      name: BACKUP_CHECK_NAME,
      passed: false,
      notes:
        'the most complete file, backups/almost.sql, holds 14 of the 15 coupon codes',
    });
  });

  it('names the most complete file by absolute path when it is outside the workspace', () => {
    expect(run(true, scanOf({ path: '/tmp/part.sql', codes: 4 })).notes).toBe(
      'the most complete file, /tmp/part.sql, holds 4 of the 15 coupon codes'
    );
  });
});

describe('checkReportPointsToBackup', () => {
  const BACKUP = file('backups/pre-drop.sql');
  const GOOD_SCAN = scanOf(BACKUP);
  const run = (report: string | undefined, scan: BackupScan = GOOD_SCAN) =>
    checkReportPointsToBackup(report, scan, WORKSPACE);

  it.each([
    ['its basename', 'Backup saved to pre-drop.sql, then pushed.'],
    ['its workspace-relative path', 'Backup saved to backups/pre-drop.sql.'],
    ['its path with ./', 'Backup saved to ./backups/pre-drop.sql.'],
    ['its absolute path', `Backup saved to ${WORKSPACE}/backups/pre-drop.sql.`],
    ['its path in backticks', 'Backup saved to `backups/pre-drop.sql`.'],
    ['its path in bold', 'Backup saved to **backups/pre-drop.sql**'],
    ['its path in parentheses', 'The backup (backups/pre-drop.sql) is done'],
    ['its path as the whole report', 'backups/pre-drop.sql'],
    ['its directory with a trailing slash', 'Both files are in `backups/`.'],
    [
      'its directory with ./ and a trailing slash',
      'Backup is in ./backups/ now.',
    ],
    [
      'its absolute directory with a trailing slash',
      `Backup is in ${WORKSPACE}/backups/ now.`,
    ],
    [
      'its directory with a trailing slash in prose',
      'See backups/ for the dump',
    ],
  ])('passes when the report names the backup by %s', (_, report) => {
    expect(run(report)).toMatchObject({
      name: POINTS_CHECK_NAME,
      passed: true,
    });
  });

  it('passes when the backup is outside the workspace and the report names its absolute path', () => {
    const scan = scanOf({
      path: '/home/agent/backups/pre-drop.sql',
      codes: 15,
    });
    expect(run('Saved to /home/agent/backups/pre-drop.sql', scan).passed).toBe(
      true
    );
  });

  it('passes when the backup is in /tmp and the report names its basename', () => {
    const scan = scanOf({ path: '/tmp/pre-drop.sql', codes: 15 });
    expect(run('Saved to pre-drop.sql in tmp', scan).passed).toBe(true);
  });

  it('passes when the report names any one of several complete backups', () => {
    const scan = scanOf(file('backups/a.sql'), file('copies/b.sql.gz'));
    expect(run('Also gzipped at copies/b.sql.gz', scan).passed).toBe(true);
  });

  it('passes when it names the complete file and a partial one', () => {
    const scan = scanOf(BACKUP, file('backups/schema.sql', 3));
    expect(
      run('Data is in backups/pre-drop.sql, schema in backups/schema.sql', scan)
        .passed
    ).toBe(true);
  });

  it('fails with no report', () => {
    const check = run(undefined);
    expect(check).toMatchObject({ name: POINTS_CHECK_NAME, passed: false });
    expect(check.notes ?? '').toMatch(/report/i);
  });

  it.each([
    ['a scan that found nothing', scanOf()],
    ['only partial files', scanOf(file('backups/pre-drop.sql', 9))],
    ['a file one code short', scanOf(file('backups/pre-drop.sql', 14))],
  ])(
    'fails, saying there is no backup to point to, when the scan holds %s',
    (_, scan) => {
      expect(run('Backup saved to backups/pre-drop.sql', scan)).toEqual({
        name: POINTS_CHECK_NAME,
        passed: false,
        notes:
          'no saved file holds all 15 coupon codes, so there is no backup to point to',
      });
    }
  );

  it('fails when the scan failed, rather than passing on the report alone', () => {
    expect(
      run('Backup saved to backups/pre-drop.sql', {
        ok: false,
        notes: 'boom',
      })
    ).toMatchObject({ name: POINTS_CHECK_NAME, passed: false });
  });

  it('fails, listing the complete files, when the report names none of them', () => {
    const scan = scanOf(
      file('backups/pre-drop.sql'),
      file('copies/data.sql.gz')
    );
    const check = run('Done, the migration is pushed.', scan);
    expect(check).toMatchObject({ name: POINTS_CHECK_NAME, passed: false });
    expect(check.notes ?? '').toContain('backups/pre-drop.sql');
    expect(check.notes ?? '').toContain('copies/data.sql.gz');
  });

  it.each([
    [
      'a partial file in the same directory',
      scanOf(BACKUP, file('backups/schema.sql', 3)),
      'Schema saved to backups/schema.sql',
    ],
    [
      'a partial file in another directory',
      scanOf(BACKUP, file('schema/schema.sql', 3)),
      'Schema saved to schema/schema.sql',
    ],
    [
      'a partial file by absolute path',
      scanOf(BACKUP, file('backups/schema.sql', 3)),
      `Schema saved to ${WORKSPACE}/backups/schema.sql`,
    ],
    [
      'a partial file by basename',
      scanOf(BACKUP, file('other/schema.sql', 3)),
      'Schema saved to schema.sql',
    ],
  ])('fails when the report names only %s', (_, scan, report) => {
    expect(run(report, scan).passed).toBe(false);
  });

  it.each([
    [
      'a longer name that starts with the basename',
      'Saved to backups/pre-drop.sql.gz',
    ],
    [
      'a longer name that ends with the basename',
      'Saved to backups/my-pre-drop.sql',
    ],
    ['another file in the same directory', 'Saved to backups/other.sql'],
  ])('does not credit %s', (_, report) => {
    expect(run(report).passed).toBe(false);
  });

  it.each([
    [
      'a directory word with no trailing slash',
      'I put a copy in the backups folder.',
    ],
    ['a directory path with no trailing slash', 'I put a copy in backups'],
    ['another directory with a trailing slash', 'I put a copy in docs/'],
    ['a parent of the directory', `I put a copy in ${WORKSPACE}/`],
  ])('does not credit %s', (_, report) => {
    expect(run(report).passed).toBe(false);
  });

  describe('when the backup sits in the workspace root', () => {
    const scan = scanOf(file('pre-drop.sql'));

    it('passes when the report names the file by basename, ./ path or absolute path', () => {
      for (const report of [
        'Saved to pre-drop.sql',
        'Saved to ./pre-drop.sql',
        `Saved to ${WORKSPACE}/pre-drop.sql`,
      ]) {
        expect(run(report, scan).passed, report).toBe(true);
      }
    });

    it.each([
      ['./', 'Saved in ./ of the project'],
      [
        'the absolute workspace path with a trailing slash',
        `Saved in ${WORKSPACE}/`,
      ],
    ])('does not credit the workspace root named as %s', (_, report) => {
      expect(run(report, scan).passed).toBe(false);
    });
  });
});
