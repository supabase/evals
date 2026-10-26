import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { readApiUrl, type StackProbe } from '../lib/stack.js';
import type { StackKeys } from '../lib/stack-keys.js';
import type { StackLifecycle } from '../lib/cli-invocations.js';
import { AVATARS, INVOICES, MEDIA_BUCKET, invoiceFor } from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type AuthHeaders = Record<string, string>;

const jwtHeaders = (jwt: string): AuthHeaders => ({
  apikey: jwt,
  Authorization: `Bearer ${jwt}`,
});

export const present = (key: string | undefined): key is string =>
  key !== undefined && key.trim() !== '';

export type ServiceIdentity = 'service-role' | 'secret';
export type AnonIdentity = 'anon' | 'publishable';

type Candidate<Identity extends string> = {
  identity: Identity;
  headers: AuthHeaders;
};

const serviceCandidates = (keys: StackKeys): Candidate<ServiceIdentity>[] => [
  ...(present(keys.serviceRole)
    ? [
        {
          identity: 'service-role' as const,
          headers: jwtHeaders(keys.serviceRole),
        },
      ]
    : []),
  ...(present(keys.secret)
    ? [{ identity: 'secret' as const, headers: { apikey: keys.secret } }]
    : []),
];

const anonCandidates = (keys: StackKeys): Candidate<AnonIdentity>[] => [
  ...(present(keys.anon)
    ? [{ identity: 'anon' as const, headers: jwtHeaders(keys.anon) }]
    : []),
  ...(present(keys.publishable)
    ? [
        {
          identity: 'publishable' as const,
          headers: { apikey: keys.publishable },
        },
      ]
    : []),
];

/** The credentials that read as the service role, the JWT before the secret key. */
export const serviceHeaderSets = (keys: StackKeys): AuthHeaders[] =>
  serviceCandidates(keys).map(({ headers }) => headers);

/** The credentials that read as the anon role, the JWT before the publishable key. */
export const anonHeaderSets = (keys: StackKeys): AuthHeaders[] =>
  anonCandidates(keys).map(({ headers }) => headers);

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

export const isSuccess = (status: number | null | undefined): boolean =>
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

const NO_SERVICE_KEY = 'no service key could be read from the stack status';
const NO_ANON_KEY = 'no anon key could be read from the stack status';

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
      serviceIdentity: ServiceIdentity | null;
      anonControl: Fetched;
      anonIdentity: AnonIdentity | null;
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

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === 'string' || value === null;

const isBucketRow = (
  row: unknown
): row is { id: string; public: boolean | null } =>
  isRow(row) &&
  typeof row.id === 'string' &&
  (typeof row.public === 'boolean' || row.public === null);

const isObjectRow = (
  row: unknown
): row is { bucket: string | null; name: string | null } =>
  isRow(row) && isStringOrNull(row.bucket) && isStringOrNull(row.name);

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
        public: isPublic === true,
      })),
      objects: objects.flatMap(({ bucket, name }) =>
        bucket === null || name === null ? [] : [{ bucket, key: name }]
      ),
    };
  } catch (error) {
    return { ok: false, notes: `storage rows: ${errorMessage(error)}` };
  }
}

type ChosenIdentity<Identity extends string> = {
  identity: Identity | null;
  headers: AuthHeaders | undefined;
  control: Fetched;
};

async function chooseIdentity<Identity extends string>(
  ctx: ExecContext,
  apiUrl: string,
  candidates: readonly Candidate<Identity>[],
  noKeyNote: string
): Promise<ChosenIdentity<Identity>> {
  let control: Fetched = { status: null, sha256: null, notes: noKeyNote };
  for (const { identity, headers } of candidates) {
    control = await fetchObject(ctx, `${apiUrl}/storage/v1/bucket`, headers);
    if (control.status === 200) return { identity, headers, control };
  }
  return { identity: null, headers: candidates[0]?.headers, control };
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

  const service = await chooseIdentity(
    ctx,
    apiUrl,
    serviceCandidates(keys),
    NO_SERVICE_KEY
  );
  const anon = await chooseIdentity(
    ctx,
    apiUrl,
    anonCandidates(keys),
    NO_ANON_KEY
  );
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
      service: await fetchObject(ctx, url, service.headers ?? {}),
    };
    const holdsInvoice = invoiceFor(object.service.sha256) !== undefined;
    if (bucketPublic || holdsInvoice) {
      const publicUrl = objectUrl(apiUrl, 'public', bucket, key);
      object.public = await fetchObject(ctx, publicUrl, {});
    }
    if (holdsInvoice && anon.headers !== undefined) {
      object.anon = await fetchObject(ctx, url, anon.headers);
    }
    objects.push(object);
  }

  return {
    ok: true,
    apiUrl,
    buckets: rows.buckets,
    objects,
    control: service.control,
    serviceIdentity: service.identity,
    anonControl: anon.control,
    anonIdentity: anon.identity,
    originalInvoices: await readPublic(ctx, apiUrl, INVOICES),
    avatars: await readPublic(ctx, apiUrl, AVATARS),
  };
}

/** The legacy backend's status command, which finds the stack the harness started. */
export const LEGACY_STATUS_COMMAND =
  'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';

/** What the harness's own legacy stack still serves once a managed stack was scored instead. */
export type LegacyStackProbe =
  | { probed: false }
  | { probed: true; running: false; notes: string }
  | {
      probed: true;
      running: true;
      apiUrl: string;
      originalInvoices: Record<string, Fetched>;
    };

/** Reads the original invoice keys' public URLs on the legacy stack when the scored stack is a different one. */
export async function probeLegacyStack(
  ctx: ExecContext,
  stack: StackProbe
): Promise<LegacyStackProbe> {
  if (!stack.ok || stack.backend === 'legacy') return { probed: false };
  let apiUrl: string | undefined;
  try {
    const result = await ctx.exec(LEGACY_STATUS_COMMAND);
    apiUrl = readApiUrl(result.stdout);
    if (apiUrl === undefined) {
      return { probed: true, running: false, notes: describeFailure(result) };
    }
  } catch (error) {
    return { probed: true, running: false, notes: errorMessage(error) };
  }
  if (apiUrl === stack.apiUrl) return { probed: false };
  return {
    probed: true,
    running: true,
    apiUrl,
    originalInvoices: await readPublic(ctx, apiUrl, INVOICES),
  };
}

const unavailable = (
  name: string,
  notes: string,
  lifecycle?: StackLifecycle
): CheckResult => ({
  name,
  passed: false,
  notes: `${
    lifecycle?.stoppedByAgent
      ? `the agent stopped the stack (last stack command: \`${lifecycle.lastCommand}\`); `
      : ''
  }storage probe unavailable: ${notes}`,
});

const fileName = (key: string) => key.slice(key.lastIndexOf('/') + 1);

const describeControl = (control: Fetched): string =>
  `returned ${control.status ?? 'no status'}${
    control.notes === undefined ? '' : ` (${control.notes})`
  }`;

export function checkInvoicesPrivate(
  probe: StorageProbe,
  lifecycle?: StackLifecycle
): CheckResult {
  const name = 'invoices are in a private bucket on the local stack';
  if (!probe.ok) return unavailable(name, probe.notes, lifecycle);
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

export function checkNoInvoicePublic(
  probe: StorageProbe,
  lifecycle?: StackLifecycle,
  legacy?: LegacyStackProbe
): CheckResult {
  const name = 'no invoice is publicly readable on the local stack';
  if (!probe.ok) return unavailable(name, probe.notes, lifecycle);
  const problems: string[] = [];
  if (probe.control.status !== 200) {
    problems.push(
      `the storage API control request ${describeControl(probe.control)}`
    );
  }
  const holdsAnyInvoice = probe.objects.some(
    (object) => invoiceFor(object.service.sha256) !== undefined
  );
  if (holdsAnyInvoice && probe.anonControl.status !== 200) {
    problems.push(
      `the anon key was not accepted, so anon reads prove nothing (the anon control request ${describeControl(probe.anonControl)})`
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
    if (holdsInvoice && object.anon === undefined) {
      problems.push(`${where} holds an invoice and has no anon read`);
    } else if (holdsInvoice && isSuccess(object.anon?.status)) {
      problems.push(`${where} is readable with the anon key`);
    }
  }
  for (const [key, read] of Object.entries(probe.originalInvoices)) {
    if (isSuccess(read.status)) {
      problems.push(`${MEDIA_BUCKET}/${key} is still publicly readable`);
    }
  }
  if (legacy?.probed && legacy.running) {
    for (const [key, read] of Object.entries(legacy.originalInvoices)) {
      if (isSuccess(read.status)) {
        problems.push(
          `${MEDIA_BUCKET}/${key} is still publicly readable on the legacy stack the harness started (${legacy.apiUrl})`
        );
      }
    }
  }
  if (problems.length === 0) return { name, passed: true };
  return { name, passed: false, notes: problems.join('; ') };
}

export function checkAvatarsPublic(
  probe: StorageProbe,
  lifecycle?: StackLifecycle
): CheckResult {
  const name = 'avatars are still public where the app loads them';
  if (!probe.ok) return unavailable(name, probe.notes, lifecycle);
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
