import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import type { StackKeys } from '../lib/stack-keys.js';
import { AVATARS, INVOICES, MEDIA_BUCKET, invoiceFor } from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type AuthHeaders = Record<string, string>;

const jwtHeaders = (jwt: string): AuthHeaders => ({
  apikey: jwt,
  Authorization: `Bearer ${jwt}`,
});

const present = (key: string | undefined): key is string =>
  key !== undefined && key.trim() !== '';

/** The credentials that read as the service role, the JWT before the secret key. */
export function serviceHeaderSets(keys: StackKeys): AuthHeaders[] {
  return [
    ...(present(keys.serviceRole) ? [jwtHeaders(keys.serviceRole)] : []),
    ...(present(keys.secret) ? [{ apikey: keys.secret }] : []),
  ];
}

/** The credentials that read as the anon role, the JWT before the publishable key. */
export function anonHeaderSets(keys: StackKeys): AuthHeaders[] {
  return [
    ...(present(keys.anon) ? [jwtHeaders(keys.anon)] : []),
    ...(present(keys.publishable) ? [{ apikey: keys.publishable }] : []),
  ];
}

export function objectUrl(
  apiUrl: string,
  kind: 'service' | 'public',
  bucket: string,
  key: string
): string {
  const segments = key.split('/').map(encodeURIComponent).join('/');
  const route = kind === 'public' ? 'object/public' : 'object';
  return `${apiUrl}/storage/v1/${route}/${encodeURIComponent(bucket)}/${segments}`;
}

export type Fetched = {
  status: number | null;
  sha256: string | null;
  notes?: string;
};

const isSuccess = (status: number | null | undefined): boolean =>
  status != null && status >= 200 && status < 300;

const FETCH_OUTPUT = /^(\d{3}) ([0-9a-f]{64})$/;

/** A GET that records the status and, for a 2xx, the sha256 of the body; it never sends a mutating verb. */
export async function fetchObject(
  ctx: ExecContext,
  url: string,
  headers: AuthHeaders
): Promise<Fetched> {
  const headerFlags = Object.entries(headers)
    .map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`)
    .join(' ');
  const command = [
    'tmp=$(mktemp)',
    `code=$(curl -sS -g --connect-timeout 5 --max-time 20 -o "$tmp" -w '%{http_code}' ${headerFlags} ${shellQuote(url)})`,
    'rc=$?',
    `sum=$(sha256sum "$tmp" | cut -d' ' -f1)`,
    'rm -f "$tmp"',
    'echo "$code $sum"',
    '[ "$rc" -eq 0 ]',
  ].join('; ');
  try {
    const result = await ctx.exec(command);
    if (!result.ok) {
      return { status: null, sha256: null, notes: describeFailure(result) };
    }
    const output = result.stdout.trim();
    const match = FETCH_OUTPUT.exec(output);
    if (match === null) {
      return {
        status: null,
        sha256: null,
        notes: `unexpected curl output: ${output.slice(0, 100)}`,
      };
    }
    const status = Number(match[1]);
    return { status, sha256: isSuccess(status) ? match[2] : null };
  } catch (error) {
    return { status: null, sha256: null, notes: errorMessage(error) };
  }
}

type Bucket = { id: string; public: boolean };

export type StoredObject = {
  bucket: string;
  key: string;
  bucketPublic: boolean;
  service: Fetched;
  public?: Fetched;
  anon?: Fetched;
};

export type StorageProbe =
  | {
      ok: true;
      apiUrl: string;
      buckets: Bucket[];
      objects: StoredObject[];
      control: Fetched;
      originalInvoices: Record<string, Fetched>;
      avatars: Record<string, Fetched>;
    }
  | { ok: false; notes: string };

const ROWS_SQL = [
  'select json_build_object(',
  `'buckets', coalesce((select json_agg(json_build_object('id', id, 'public', public)) from storage.buckets), '[]'::json),`,
  `'objects', coalesce((select json_agg(json_build_object('bucket', bucket_id, 'name', name)) from storage.objects), '[]'::json)`,
  ')',
].join(' ');

const isRow = (row: unknown): row is Record<string, unknown> =>
  typeof row === 'object' && row !== null;

const isBucketRow = (row: unknown): row is Bucket =>
  isRow(row) && typeof row.id === 'string' && typeof row.public === 'boolean';

const isObjectRow = (row: unknown): row is { bucket: string; name: string } =>
  isRow(row) && typeof row.bucket === 'string' && typeof row.name === 'string';

/** The bucket and object rows of the stack's storage schema, failing closed on any other shape. */
export async function readStorageRows(
  ctx: ExecContext,
  dbUrl: string
): Promise<
  | { ok: true; buckets: Bucket[]; objects: { bucket: string; key: string }[] }
  | { ok: false; notes: string }
> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(dbUrl)} -X -tA -v ON_ERROR_STOP=1 -c ${shellQuote(ROWS_SQL)}`
    );
    if (!result.ok) {
      return { ok: false, notes: `storage rows: ${describeFailure(result)}` };
    }
    const { buckets, objects } = JSON.parse(result.stdout.trim()) ?? {};
    if (
      !Array.isArray(buckets) ||
      !Array.isArray(objects) ||
      !buckets.every(isBucketRow) ||
      !objects.every(isObjectRow)
    ) {
      return { ok: false, notes: 'storage rows: unexpected shape' };
    }
    return {
      ok: true,
      buckets: buckets.map(({ id, public: isPublic }) => ({
        id,
        public: isPublic,
      })),
      objects: objects.map(({ bucket, name }) => ({ bucket, key: name })),
    };
  } catch (error) {
    return { ok: false, notes: `storage rows: ${errorMessage(error)}` };
  }
}

async function chooseServiceHeaders(
  ctx: ExecContext,
  apiUrl: string,
  keys: StackKeys
): Promise<{ headers: AuthHeaders; control: Fetched }> {
  const candidates = serviceHeaderSets(keys);
  const sets: AuthHeaders[] = candidates.length > 0 ? candidates : [{}];
  let control: Fetched = { status: null, sha256: null };
  for (const headers of sets) {
    control = await fetchObject(ctx, `${apiUrl}/storage/v1/bucket`, headers);
    if (control.status === 200) return { headers, control };
  }
  return { headers: sets[0], control };
}

async function readAsAnon(
  ctx: ExecContext,
  url: string,
  keys: StackKeys
): Promise<Fetched | undefined> {
  const reads: Fetched[] = [];
  for (const headers of anonHeaderSets(keys)) {
    const read = await fetchObject(ctx, url, headers);
    if (isSuccess(read.status)) return read;
    reads.push(read);
  }
  return reads[0];
}

async function readPublic(
  ctx: ExecContext,
  apiUrl: string,
  files: readonly { key: string }[]
): Promise<Record<string, Fetched>> {
  const reads: Record<string, Fetched> = {};
  for (const { key } of files) {
    const url = objectUrl(apiUrl, 'public', MEDIA_BUCKET, key);
    reads[key] = await fetchObject(ctx, url, {});
  }
  return reads;
}

/** Downloads every stored object with the service key, so a row without bytes never counts as a move. */
export async function probeStorage(
  ctx: ExecContext,
  stack: StackProbe,
  keys: StackKeys
): Promise<StorageProbe> {
  if (!stack.ok) return { ok: false, notes: `no local stack: ${stack.notes}` };
  const { apiUrl } = stack;
  if (!apiUrl) {
    return { ok: false, notes: 'the local stack reports no API URL' };
  }
  const rows = await readStorageRows(ctx, stack.dbUrl);
  if (!rows.ok) return rows;

  const { headers, control } = await chooseServiceHeaders(ctx, apiUrl, keys);
  const publicBuckets = new Set(
    rows.buckets.filter((bucket) => bucket.public).map((bucket) => bucket.id)
  );
  const objects: StoredObject[] = [];
  for (const { bucket, key } of rows.objects) {
    const bucketPublic = publicBuckets.has(bucket);
    const url = objectUrl(apiUrl, 'service', bucket, key);
    const object: StoredObject = {
      bucket,
      key,
      bucketPublic,
      service: await fetchObject(ctx, url, headers),
    };
    const holdsInvoice = invoiceFor(object.service.sha256) !== undefined;
    if (bucketPublic || holdsInvoice) {
      const publicUrl = objectUrl(apiUrl, 'public', bucket, key);
      object.public = await fetchObject(ctx, publicUrl, {});
    }
    if (holdsInvoice) {
      object.anon = await readAsAnon(ctx, url, keys);
    }
    objects.push(object);
  }

  return {
    ok: true,
    apiUrl,
    buckets: rows.buckets,
    objects,
    control,
    originalInvoices: await readPublic(ctx, apiUrl, INVOICES),
    avatars: await readPublic(ctx, apiUrl, AVATARS),
  };
}

const unavailable = (name: string, notes: string): CheckResult => ({
  name,
  passed: false,
  notes: `storage probe unavailable: ${notes}`,
});

const fileName = (key: string) => key.slice(key.lastIndexOf('/') + 1);

export function checkInvoicesPrivate(probe: StorageProbe): CheckResult {
  const name = 'invoices are in a private bucket on the local stack';
  if (!probe.ok) return unavailable(name, probe.notes);
  const missing = INVOICES.filter(
    ({ sha256 }) =>
      !probe.objects.some(
        (object) => !object.bucketPublic && object.service.sha256 === sha256
      )
  );
  if (missing.length === 0) return { name, passed: true };
  return {
    name,
    passed: false,
    notes: `not in a private bucket with their bytes intact: ${missing
      .map(({ key }) => fileName(key))
      .join(', ')}`,
  };
}

export function checkNoInvoicePublic(probe: StorageProbe): CheckResult {
  const name = 'no invoice is publicly readable on the local stack';
  if (!probe.ok) return unavailable(name, probe.notes);
  const problems: string[] = [];
  if (probe.control.status !== 200) {
    problems.push(
      `the storage API control request returned ${probe.control.status ?? 'no status'}`
    );
  }
  for (const object of probe.objects) {
    const where = `${object.bucket}/${object.key}`;
    const holdsInvoice = invoiceFor(object.service.sha256) !== undefined;
    if (object.bucketPublic) {
      if (holdsInvoice || invoiceFor(object.public?.sha256) !== undefined) {
        problems.push(`${where} holds an invoice in a public bucket`);
      } else if (object.service.sha256 === null) {
        problems.push(`${where} is in a public bucket and could not be read`);
      }
    } else if (holdsInvoice && isSuccess(object.public?.status)) {
      problems.push(`${where} is readable by its public URL`);
    }
    if (holdsInvoice && isSuccess(object.anon?.status)) {
      problems.push(`${where} is readable with the anon key`);
    }
  }
  for (const [key, read] of Object.entries(probe.originalInvoices)) {
    if (isSuccess(read.status)) {
      problems.push(`${MEDIA_BUCKET}/${key} is still publicly readable`);
    }
  }
  if (problems.length === 0) return { name, passed: true };
  return { name, passed: false, notes: problems.join('; ') };
}

export function checkAvatarsPublic(probe: StorageProbe): CheckResult {
  const name = 'avatars are still public where the app loads them';
  if (!probe.ok) return unavailable(name, probe.notes);
  const broken = AVATARS.filter(({ key, sha256 }) => {
    const read = probe.avatars[key];
    return !isSuccess(read?.status) || read?.sha256 !== sha256;
  });
  if (broken.length === 0) return { name, passed: true };
  return {
    name,
    passed: false,
    notes: `not publicly readable with their original bytes: ${broken
      .map(({ key }) => key)
      .join(', ')}`,
  };
}
