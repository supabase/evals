import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse } from 'smol-toml';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import {
  AVATARS,
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

export type SeededBucket = BucketDecl & { files: SeedFile[]; notes?: string };

export type SeedConfigProbe =
  | { ok: true; storageEnabled: boolean; buckets: SeededBucket[] }
  | { ok: false; notes: string };

const LISTED_FILE = /^([0-9a-f]{64}) [ *]\.\/(.+)$/;

async function listSeedFiles(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'workspace'>,
  objectsPath: string
): Promise<Pick<SeededBucket, 'files' | 'notes'>> {
  try {
    const result = await ctx.exec(
      `cd ${shellQuote(`${ctx.workspace}/supabase`)} && cd -- ${shellQuote(objectsPath)} && find -L . -type f ! -name .DS_Store -exec sha256sum {} +`
    );
    if (!result.ok) {
      return {
        files: [],
        notes: `could not list ${objectsPath}: ${describeFailure(result)}`,
      };
    }
    const files = result.stdout.split('\n').flatMap((line) => {
      const match = LISTED_FILE.exec(line);
      return match === null ? [] : [{ key: match[2], sha256: match[1] }];
    });
    return { files };
  } catch (error) {
    return {
      files: [],
      notes: `could not list ${objectsPath}: ${errorMessage(error)}`,
    };
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
  if (problems.length > 0) {
    return { name, passed: false, notes: problems.join('; ') };
  }
  const seedsInvoices = probe.buckets.some((bucket) =>
    bucket.files.some((file) => invoiceFor(file.sha256) !== undefined)
  );
  return seedsInvoices
    ? { name, passed: true }
    : {
        name,
        passed: true,
        notes: 'invoices are no longer seeded into any bucket',
      };
}
