import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse } from 'smol-toml';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import {
  AVATARS,
  INVOICES,
  MEDIA_BUCKET,
  SEED_CONFIG_PATH,
  invoiceFor,
  type SeedFile,
} from './fixtures.js';

export type BucketDecl = {
  name: string;
  public: boolean;
  objectsPath?: string;
};

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The buckets `[storage.buckets.*]` declares, with the CLI's defaults: storage enabled and buckets private. */
export function parseBucketDecls(
  toml: string
):
  | { ok: true; storageEnabled: boolean; buckets: BucketDecl[] }
  | { ok: false; notes: string } {
  try {
    const { storage } = parse(toml);
    const settings = isTable(storage) ? storage : {};
    const declared = isTable(settings.buckets) ? settings.buckets : {};
    return {
      ok: true,
      storageEnabled: settings.enabled !== false,
      buckets: Object.entries(declared).map(([name, decl]) => {
        const bucket = isTable(decl) ? decl : {};
        const objectsPath = bucket.objects_path;
        return {
          name,
          public: bucket.public === true,
          ...(typeof objectsPath === 'string' && objectsPath !== ''
            ? { objectsPath }
            : {}),
        };
      }),
    };
  } catch (error) {
    return {
      ok: false,
      notes: `${SEED_CONFIG_PATH} does not parse: ${errorMessage(error)}`,
    };
  }
}

export type SeededBucket = BucketDecl & {
  files: SeedFile[];
  /** Set when the bucket's objects_path does not exist, so it seeds nothing. */
  notes?: string;
  /** Set when listing the objects_path failed, so what it would seed is unknown. */
  error?: string;
};

export type SeedConfigProbe =
  | { ok: true; storageEnabled: boolean; buckets: SeededBucket[] }
  | { ok: false; notes: string };

export const MISSING_PATH_MARKER = 'objects_path does not exist';

const LISTED_FILE = /^\\?([0-9a-f]{64}) [ *]\.\/(.+)$/;

const SKIPPED_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

const HASH_REGULAR_FILES =
  'for f do if [ -f "$f" ]; then sha256sum -- "$f" || exit 1; fi; done';

/** Portable to GNU and BSD find: `[ -f ]` follows a symlink to a file and rejects one to a directory, as the CLI's seeding does. */
function listCommand(workspace: string, objectsPath: string): string {
  const skipped = SKIPPED_FILES.map((name) => `! -name ${name}`).join(' ');
  return [
    `cd ${shellQuote(`${workspace}/supabase`)} || exit 1`,
    `p=${shellQuote(objectsPath)}`,
    'if [ -f "$p" ]',
    'then d=$(dirname -- "$p") && f=$(basename -- "$p") && cd -- "$d" && sha256sum -- "./$f"',
    'elif [ -d "$p" ]',
    `then cd -- "$p" && find . ${skipped} \\( -type f -o -type l \\) -exec sh -c ${shellQuote(HASH_REGULAR_FILES)} sh {} +`,
    `else echo ${shellQuote(MISSING_PATH_MARKER)}`,
    'fi',
  ].join('; ');
}

/** The files `objectsPath` would seed with their sha256, keyed by path from the folder (the file's own name for a single-file path). */
export async function listSeedFiles(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'workspace'>,
  objectsPath: string
): Promise<Pick<SeededBucket, 'files' | 'notes' | 'error'>> {
  try {
    const result = await ctx.exec(listCommand(ctx.workspace, objectsPath));
    if (!result.ok) return { files: [], error: describeFailure(result) };
    if (result.stdout.trim() === MISSING_PATH_MARKER) {
      return {
        files: [],
        notes: `${objectsPath} does not exist, so it seeds nothing`,
      };
    }
    const files: SeedFile[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const match = LISTED_FILE.exec(line);
      if (match === null) {
        return {
          files: [],
          error: `unparseable output: ${truncate(line, 100)}`,
        };
      }
      files.push({ key: match[2], sha256: match[1] });
    }
    return { files };
  } catch (error) {
    return { files: [], error: errorMessage(error) };
  }
}

/** The buckets the project's config would seed on a fresh start and the files, hashed, under each bucket's objects_path. */
export async function readSeedConfig(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'readFile' | 'workspace'>
): Promise<SeedConfigProbe> {
  let toml: string;
  try {
    toml = await ctx.readFile(SEED_CONFIG_PATH);
  } catch (error) {
    return {
      ok: false,
      notes: `could not read ${SEED_CONFIG_PATH}: ${errorMessage(error)}`,
    };
  }
  const decls = parseBucketDecls(toml);
  if (!decls.ok) return decls;
  const buckets: SeededBucket[] = [];
  for (const decl of decls.buckets) {
    const listed =
      decl.objectsPath === undefined
        ? { files: [] }
        : await listSeedFiles(ctx, decl.objectsPath);
    buckets.push({ ...decl, ...listed });
  }
  return { ok: true, storageEnabled: decls.storageEnabled, buckets };
}

export function checkFreshSetup(probe: SeedConfigProbe): CheckResult {
  const name = 'a fresh local setup keeps invoices private and avatars public';
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: `seed config unavailable: ${probe.notes}`,
    };
  }
  const problems: string[] = [];
  if (!probe.storageEnabled) problems.push('storage is disabled in the config');
  for (const bucket of probe.buckets) {
    const invoices = bucket.files.filter(
      (file) => invoiceFor(file.sha256) !== undefined
    );
    if (bucket.public && invoices.length > 0) {
      problems.push(
        `public bucket ${bucket.name} would seed ${invoices.length} invoice file(s)`
      );
    }
    if (bucket.public && bucket.error !== undefined) {
      problems.push(
        `could not list public bucket ${bucket.name}'s objects_path: ${bucket.error}`
      );
    }
  }
  const media = probe.buckets.find((bucket) => bucket.name === MEDIA_BUCKET);
  if (media === undefined || !media.public) {
    problems.push(`${MEDIA_BUCKET} is not declared as a public bucket`);
  } else {
    const missing = AVATARS.filter(
      ({ key, sha256 }) =>
        !media.files.some((file) => file.key === key && file.sha256 === sha256)
    );
    if (missing.length > 0) {
      problems.push(
        `${MEDIA_BUCKET} would not seed the avatars ${missing.map(({ key }) => key).join(', ')}${
          media.notes === undefined ? '' : ` (${media.notes})`
        }`
      );
    }
  }
  if (probe.storageEnabled) {
    const unseeded = INVOICES.filter(
      ({ sha256 }) =>
        !probe.buckets.some(
          (bucket) =>
            !bucket.public &&
            bucket.files.some((file) => file.sha256 === sha256)
        )
    );
    if (unseeded.length > 0) {
      problems.push(
        `a fresh local setup would not seed ${unseeded
          .map(({ key }) => key.slice(key.lastIndexOf('/') + 1))
          .join(', ')} into a private bucket`
      );
    }
  }
  return problems.length > 0
    ? { name, passed: false, notes: problems.join('; ') }
    : { name, passed: true };
}
