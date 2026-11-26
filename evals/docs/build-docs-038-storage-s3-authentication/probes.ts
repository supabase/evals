import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import { errorLine, messageOf } from '../lib/local-stack.js';
import { PROBE_SOURCE } from './probe-source.js';

type Exec = Pick<LocalStackEvalContext, 'exec'>;

export const CHECK = {
  installed: 'project dependencies installed',
  ownNotes: 'a signed-in user can list and read their own notes',
  upload: 'a signed-in user can upload a new note',
  resync: 'a signed-in user can sync a note again',
  otherHidden: "a signed-in user cannot read or list another user's notes",
  otherUnchanged: "a signed-in user cannot change another user's notes",
  noFullAccessKey:
    'no file in the desktop app holds a full-access key from the project',
  backup: "the backup job reads every user's notes",
} as const;

const DESKTOP_CHECKS = [
  CHECK.ownNotes,
  CHECK.upload,
  CHECK.resync,
  CHECK.otherHidden,
  CHECK.otherUnchanged,
] as const;

export const PROBE_CHECKS = [...DESKTOP_CHECKS, CHECK.backup] as const;

const REFUSALS = new Set(['NoSuchKey', 'AccessDenied']);
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const MAX_FILE_BYTES = 2_000_000;

export type Stack = {
  apiUrl: string;
  clientKey: string;
  adminKey: string;
  fullAccess: { label: string; value: string }[];
};

export async function readStack(ctx: Exec): Promise<Stack> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  const stack = {
    apiUrl: parsed.API_URL,
    clientKey: parsed.PUBLISHABLE_KEY || parsed.ANON_KEY,
    adminKey: parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY,
    fullAccess: [
      {
        label: 'the S3 secret key',
        value: parsed.S3_PROTOCOL_ACCESS_KEY_SECRET,
      },
      { label: 'the service role key', value: parsed.SERVICE_ROLE_KEY },
      { label: 'the secret key', value: parsed.SECRET_KEY },
      { label: 'the JWT secret', value: parsed.JWT_SECRET },
    ].filter(
      (entry): entry is { label: string; value: string } =>
        typeof entry.value === 'string' && entry.value.length > 0
    ),
  };
  if (!stack.apiUrl || !stack.clientKey || !stack.adminKey) {
    throw new Error(
      `supabase status is missing the api url or a key: ${Object.keys(parsed).join(', ')}`
    );
  }
  return stack;
}

export function checkNoFullAccessKey(
  workspace: string,
  stack: Stack | undefined
): CheckResult {
  const name = CHECK.noFullAccessKey;
  if (!stack || stack.fullAccess.length === 0) {
    return notRun(name, 'the project keys could not be read');
  }
  const root = join(workspace, 'desktop');
  const hits = stack.fullAccess.flatMap(({ label, value }) =>
    filesContaining(root, root, value).map((file) => `${label} in ${file}`)
  );
  return {
    name,
    passed: hits.length === 0,
    notes:
      hits.length === 0
        ? 'no file in desktop/ holds the S3 secret, the service role key, the secret key or the JWT secret'
        : `found ${hits.join(', ')}`,
  };
}

function filesContaining(root: string, dir: string, needle: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return [];
    }
    if (stats.isDirectory()) {
      return SKIPPED_DIRS.has(entry) ? [] : filesContaining(root, path, needle);
    }
    if (stats.size > MAX_FILE_BYTES) return [];
    try {
      return readFileSync(path, 'utf8').includes(needle)
        ? [`desktop/${relative(root, path)}`]
        : [];
    } catch {
      return [];
    }
  });
}

export async function installDependencies(ctx: Exec): Promise<CheckResult> {
  try {
    const result = await ctx.exec('npm ci --no-audit --no-fund --silent', {
      timeoutMs: 420_000,
    });
    return {
      name: CHECK.installed,
      passed: result.exitCode === 0,
      notes:
        result.exitCode === 0
          ? 'npm ci succeeded'
          : errorLine(`${result.stderr ?? ''}\n${result.stdout ?? ''}`),
    };
  } catch (error) {
    return { name: CHECK.installed, passed: false, notes: messageOf(error) };
  }
}

type Failure = {
  ok: false;
  code?: string;
  status?: number;
  message: string;
};
type Listing = { ok: true; keys: string[] } | Failure;
type Read = { ok: true; body: string } | Failure;
type Write = { ok: true } | Failure;

type Person = { id: string; token: string };
type Users = { owner: Person; other: Person };
type Notes = { mine: string; fresh: string; theirs: string; planted: string };
type Texts = {
  mine: string;
  fresh: string;
  again: string;
  theirs: string;
  tampered: string;
  planted: string;
};

export type World = {
  run: string;
  scratch: string;
  users: Users;
  notes: Notes;
  texts: Texts;
  stack: Stack;
};

type BackupResult =
  | { ok: true; listing: Listing; mine: Read; theirs: Read }
  | Failure;

type DesktopOk = {
  ok: true;
  listOwn: Listing;
  readOwn: Read;
  upload: Write;
  resync: Write;
  listOther: Listing;
  listAll: Listing;
  readOther: Read;
  writeOther: Write;
  plantOther: Write;
};
type DesktopResult = DesktopOk | Failure;

type Bodies = Partial<Record<keyof Notes, string | null>>;

function textsFor(run: string): Texts {
  return {
    mine: `mine-${run}`,
    fresh: `fresh-${run}`,
    again: `again-${run}`,
    theirs: `theirs-${run}`,
    tampered: `tampered-${run}`,
    planted: `planted-${run}`,
  };
}

export async function setupWorld(
  ctx: Exec,
  stack: Stack
): Promise<{ world: World } | { failure: string }> {
  const run = randomUUID().slice(0, 8);
  const texts = textsFor(run);
  const encoded = Buffer.from(PROBE_SOURCE, 'utf8').toString('base64');
  const prepared = await ctx.exec(
    `scratch=$(mktemp -d) && ln -s "$PWD/node_modules" "$scratch/node_modules" && echo ${encoded} | base64 -d > "$scratch/probe.mjs" && echo "SCRATCH:$scratch"`
  );
  const scratch = (prepared.stdout ?? '')
    .split('\n')
    .find((line) => line.startsWith('SCRATCH:'))
    ?.slice('SCRATCH:'.length)
    .trim();
  if (prepared.exitCode !== 0 || !scratch) {
    return {
      failure: `could not write the probe: ${errorLine(prepared.stderr ?? '')}`,
    };
  }
  const result = await probe<
    { ok: true; users: Users; notes: Notes } | Failure
  >(ctx, scratch, scratch, 'setup', {
    run,
    texts,
    apiUrl: stack.apiUrl,
    clientKey: stack.clientKey,
    adminKey: stack.adminKey,
    password: `probe-${run}-password`,
  });
  if (!result.ok) {
    await removeScratch(ctx, scratch);
    return { failure: result.message };
  }
  const owned = await execSql(
    ctx,
    [
      [result.notes.mine, result.users.owner.id],
      [result.notes.theirs, result.users.other.id],
    ]
      .map(
        ([note, user]) =>
          `update storage.objects set owner = '${user}', owner_id = '${user}' where bucket_id = 'notes' and name = '${note}';`
      )
      .join('\n')
  );
  if (!owned.ok) {
    await removeScratch(ctx, scratch);
    return {
      failure: `could not hand the notes to their owners: ${owned.message}`,
    };
  }
  return {
    world: {
      run,
      scratch,
      users: result.users,
      notes: result.notes,
      texts,
      stack,
    },
  };
}

export async function probeBackup(
  ctx: Exec,
  world: World
): Promise<BackupResult> {
  return probe<BackupResult>(
    ctx,
    world.scratch,
    'backup',
    'backup',
    inputFor(world)
  );
}

export async function probeDesktop(
  ctx: Exec,
  world: World
): Promise<DesktopResult> {
  const shipped = `${world.scratch}/desktop`;
  const copied = await ctx.exec(`cp -R desktop "${shipped}"`);
  if (copied.exitCode !== 0) {
    return {
      ok: false,
      message: `could not copy desktop/ on its own: ${errorLine(copied.stderr ?? '')}`,
    };
  }
  return probe<DesktopResult>(
    ctx,
    world.scratch,
    shipped,
    'desktop',
    inputFor(world)
  );
}

export async function readBodies(
  ctx: Exec,
  world: World
): Promise<Bodies | Failure> {
  const result = await probe<{ ok: true; bodies: Bodies } | Failure>(
    ctx,
    world.scratch,
    world.scratch,
    'verify',
    inputFor(world)
  );
  return result.ok ? result.bodies : result;
}

export async function removeScratch(ctx: Exec, scratch: string): Promise<void> {
  await ctx.exec(`rm -rf "${scratch}"`).then(
    () => undefined,
    () => undefined
  );
}

function inputFor(world: World) {
  return {
    run: world.run,
    texts: world.texts,
    apiUrl: world.stack.apiUrl,
    adminKey: world.stack.adminKey,
    users: world.users,
    notes: world.notes,
  };
}

async function probe<T>(
  ctx: Exec,
  scratch: string,
  cwd: string,
  mode: string,
  input: Record<string, unknown>
): Promise<T | Failure> {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  try {
    const result = await ctx.exec(
      `cd "${cwd}" && env -i PATH="$PATH" HOME="$HOME" PROBE_INPUT=${encoded} node $([ -f .env ] && echo --env-file=.env) "${scratch}/probe.mjs" ${mode}`,
      { timeoutMs: 120_000 }
    );
    const line =
      (result.stdout ?? '')
        .trim()
        .split('\n')
        .reverse()
        .find((entry) => entry.startsWith('{')) ?? '';
    if (line) return JSON.parse(line) as T;
    return {
      ok: false,
      message: `the ${mode} probe printed no result: ${errorLine(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)}`,
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export function notRun(name: string, reason: string): CheckResult {
  return { name, passed: false, notes: `not run: ${reason}` };
}

export function checkBackup(world: World, result: BackupResult): CheckResult {
  const name = CHECK.backup;
  if (!result.ok) return { name, passed: false, notes: result.message };
  const { listing } = result;
  if (!listing.ok) {
    return {
      name,
      passed: false,
      notes: `listing the bucket failed: ${describe(listing)}`,
    };
  }
  const missing = [world.notes.mine, world.notes.theirs].filter(
    (key) => !listing.keys.includes(key)
  );
  if (missing.length > 0) {
    return {
      name,
      passed: false,
      notes: `the listing left out ${missing.join(', ')}`,
    };
  }
  const reads: [label: string, read: Read, expected: string][] = [
    ['their own note', result.mine, world.texts.mine],
    ["the other user's note", result.theirs, world.texts.theirs],
  ];
  const wrong = reads.filter(
    ([, read, expected]) => !read.ok || read.body !== expected
  );
  return {
    name,
    passed: wrong.length === 0,
    notes:
      wrong.length === 0
        ? "listed and read both users' notes"
        : wrong
            .map(([label, read]) => `reading ${label}: ${describe(read)}`)
            .join('; '),
  };
}

export function checkDesktop(
  world: World,
  result: DesktopResult,
  bodies: Bodies | Failure
): CheckResult[] {
  if (!result.ok) {
    return DESKTOP_CHECKS.map((name) => ({
      name,
      passed: false,
      notes: result.message,
    }));
  }
  const readBack = (
    name: string,
    check: (stored: Bodies) => CheckResult
  ): CheckResult =>
    'ok' in bodies
      ? {
          name,
          passed: false,
          notes: `the scorer could not read the notes back: ${bodies.message}`,
        }
      : check(bodies);
  return [
    ownNotes(world, result),
    readBack(CHECK.upload, (stored) => upload(world, result, stored)),
    readBack(CHECK.resync, (stored) => resync(world, result, stored)),
    otherHidden(world, result),
    readBack(CHECK.otherUnchanged, (stored) =>
      otherUnchanged(world, result, stored)
    ),
  ];
}

function ownNotes(world: World, result: DesktopOk): CheckResult {
  const name = CHECK.ownNotes;
  if (!result.listOwn.ok) {
    return {
      name,
      passed: false,
      notes: `listing their folder failed: ${describe(result.listOwn)}`,
    };
  }
  if (!result.listOwn.keys.includes(world.notes.mine)) {
    return { name, passed: false, notes: 'their note was not in the listing' };
  }
  if (!result.readOwn.ok || result.readOwn.body !== world.texts.mine) {
    return {
      name,
      passed: false,
      notes: `reading their note: ${describe(result.readOwn)}`,
    };
  }
  return { name, passed: true, notes: 'listed and read their own note' };
}

function upload(world: World, result: DesktopOk, bodies: Bodies): CheckResult {
  const name = CHECK.upload;
  if (!result.upload.ok) {
    return { name, passed: false, notes: describe(result.upload) };
  }
  return bodies.fresh === world.texts.fresh
    ? { name, passed: true, notes: 'the new note is stored' }
    : {
        name,
        passed: false,
        notes: 'the upload returned no error, but the note is not stored',
      };
}

function resync(world: World, result: DesktopOk, bodies: Bodies): CheckResult {
  const name = CHECK.resync;
  if (!result.resync.ok) {
    return {
      name,
      passed: false,
      notes: `uploading an existing note again failed: ${describe(result.resync)}`,
    };
  }
  return bodies.mine === world.texts.again
    ? { name, passed: true, notes: 'the note holds the new text' }
    : {
        name,
        passed: false,
        notes: `the upload returned no error, but the note holds ${JSON.stringify(bodies.mine)}`,
      };
}

function otherHidden(world: World, result: DesktopOk): CheckResult {
  const name = CHECK.otherHidden;
  const otherPrefix = `${world.users.other.id}/`;
  const { listOther, listAll, readOther } = result;
  if (!listOther.ok || !listAll.ok) {
    const failed = !listOther.ok ? listOther : listAll;
    return {
      name,
      passed: false,
      notes: `not measured: listing failed rather than coming back empty: ${describe(failed)}`,
    };
  }
  const listed = [...listOther.keys, ...listAll.keys].filter((key) =>
    key.startsWith(otherPrefix)
  );
  if (listed.length > 0) {
    return {
      name,
      passed: false,
      notes: `the listing showed ${[...new Set(listed)].join(', ')}`,
    };
  }
  if (readOther.ok) {
    return { name, passed: false, notes: "read the other user's note" };
  }
  if (!REFUSALS.has(readOther.code ?? '')) {
    return {
      name,
      passed: false,
      notes: `not measured: the read failed with ${describe(readOther)}, not a refusal`,
    };
  }
  return {
    name,
    passed: true,
    notes: `their listings were empty and the read came back ${readOther.code}`,
  };
}

function otherUnchanged(
  world: World,
  result: DesktopOk,
  bodies: Bodies
): CheckResult {
  const name = CHECK.otherUnchanged;
  if (bodies.theirs !== world.texts.theirs) {
    return {
      name,
      passed: false,
      notes: `the other user's note now holds ${JSON.stringify(bodies.theirs)}`,
    };
  }
  if (typeof bodies.planted === 'string') {
    return {
      name,
      passed: false,
      notes: "a new note landed in the other user's folder",
    };
  }
  const writes: [label: string, write: Write][] = [
    ['the upload over their note', result.writeOther],
    ['the upload into their folder', result.plantOther],
  ];
  const accepted = writes.filter(([, write]) => write.ok);
  if (accepted.length > 0) {
    return {
      name,
      passed: false,
      notes: `${accepted.map(([label]) => label).join(' and ')} returned no error`,
    };
  }
  const unmeasured = writes.filter(
    ([, write]) => !write.ok && write.code !== 'AccessDenied'
  );
  if (unmeasured.length > 0) {
    return {
      name,
      passed: false,
      notes: `not measured: ${unmeasured.map(([label, write]) => `${label} failed with ${describe(write)}`).join('; ')}, not a refusal`,
    };
  }
  return {
    name,
    passed: true,
    notes:
      'both uploads were refused with AccessDenied, their note is unchanged and nothing new is in their folder',
  };
}

function describe(value: Listing | Read | Write): string {
  if (value.ok) return 'ok';
  return [value.code, value.status, value.message]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}
