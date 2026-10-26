import path from 'node:path';
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { shellQuote } from '../lib/shell.js';
import type { StackKeys } from '../lib/stack-keys.js';
import type { StackProbe } from '../lib/stack.js';
import {
  AVATARS,
  INVOICES,
  MEDIA_BUCKET,
  SEED_CONFIG_PATH,
  type SeedFile,
} from './fixtures.js';
import {
  MISSING_PATH_MARKER,
  type SeedConfigProbe,
  type SeededBucket,
} from './seed-config.js';
import type {
  AnonIdentity,
  Fetched,
  ServiceIdentity,
  StorageProbe,
  StoredObject,
} from './storage.js';

export const API_URL = 'http://127.0.0.1:54321';
export const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const CONTROL_URL = `${API_URL}/storage/v1/bucket`;
export const WORKSPACE = '/workspace';

export const SERVICE_ROLE =
  'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service-signature';
export const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
export const SECRET_KEY = 'sb_secret_testsecretkey';
export const PUBLISHABLE = 'sb_publishable_testpublishablekey';
export const KEY_VALUES = [SERVICE_ROLE, SECRET_KEY, ANON, PUBLISHABLE];

export const KEYS: StackKeys = {
  serviceRole: SERVICE_ROLE,
  secret: SECRET_KEY,
  anon: ANON,
  publishable: PUBLISHABLE,
};

export const STACK: Extract<StackProbe, { ok: true }> = {
  ok: true,
  backend: 'legacy',
  dbUrl: DB_URL,
  apiUrl: API_URL,
  runtime: 'docker',
};

export const STATUS_JSON = JSON.stringify({
  API_URL,
  DB_URL,
  ANON_KEY: ANON,
  SERVICE_ROLE_KEY: SERVICE_ROLE,
  PUBLISHABLE_KEY: PUBLISHABLE,
  SECRET_KEY,
});

export const EMPTY_SHA =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const ok = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

export const failed = (stderr: string, exitCode = 1): CommandResult => ({
  ok: false,
  exitCode,
  stdout: '',
  stderr,
});

export const basename = (key: string): string =>
  key.slice(key.lastIndexOf('/') + 1);

/** Built independently of `objectUrl` so the fake and the code under test cannot share a bug. */
export function urlFor(
  kind: 'service' | 'public',
  bucket: string,
  key: string
): string {
  const segments = key.split('/').map(encodeURIComponent).join('/');
  return `${API_URL}/storage/v1/object/${kind === 'public' ? 'public/' : ''}${encodeURIComponent(bucket)}/${segments}`;
}

export type Bucket = { id: string; public: boolean };

export const MEDIA: Bucket = { id: MEDIA_BUCKET, public: true };
export const PRIVATE_INVOICES: Bucket = { id: 'invoices', public: false };

export type Identity = 'service' | 'secret' | 'anon' | 'publishable' | 'none';

export type WorldObject = {
  bucket: string;
  key: string;
  sha256: string;
  bytes?: boolean;
};

export type World = {
  buckets: Bucket[];
  objects: WorldObject[];
  accepts?: readonly Identity[];
  controlStatus?: Partial<Record<Identity, number>>;
  /** Makes the storage API turn the anon and publishable keys away outright, on the control request and on reads. */
  rejectsAnon?: boolean;
  anonReads?: (bucket: string, key: string) => boolean;
};

export type Seen = {
  kind: 'control' | 'service' | 'public';
  identity: Identity;
  bucket?: string;
  key?: string;
  command: string;
};

export const avatarRows = (): WorldObject[] =>
  AVATARS.map(({ key, sha256 }) => ({ bucket: MEDIA_BUCKET, key, sha256 }));

export const invoiceRows = (
  bucket = PRIVATE_INVOICES.id,
  keyFor: (file: SeedFile) => string = (file) => basename(file.key)
): WorldObject[] =>
  INVOICES.map((file) => ({
    bucket,
    key: keyFor(file),
    sha256: file.sha256,
  }));

export const passingWorld = (): World => ({
  buckets: [MEDIA, PRIVATE_INVOICES],
  objects: [...avatarRows(), ...invoiceRows()],
});

export const untouchedWorld = (): World => ({
  buckets: [MEDIA],
  objects: [...avatarRows(), ...invoiceRows(MEDIA_BUCKET, (file) => file.key)],
});

export const copyLeftWorld = (): World => ({
  buckets: [MEDIA, PRIVATE_INVOICES],
  objects: [
    ...avatarRows(),
    ...invoiceRows(MEDIA_BUCKET, (file) => file.key),
    ...invoiceRows(),
  ],
});

export type BucketConfig = {
  name: string;
  public?: boolean;
  objectsPath?: string;
};

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function configToml(
  buckets: readonly BucketConfig[],
  options: { storageEnabled?: boolean } = {}
): string {
  const lines = [
    'project_id = "ledgerly"',
    '',
    '[db]',
    'major_version = 17',
    '',
    '[storage]',
    `enabled = ${options.storageEnabled ?? true}`,
  ];
  for (const bucket of buckets) {
    const key = BARE_KEY.test(bucket.name)
      ? bucket.name
      : JSON.stringify(bucket.name);
    lines.push('', `[storage.buckets.${key}]`);
    if (bucket.public !== undefined) lines.push(`public = ${bucket.public}`);
    if (bucket.objectsPath !== undefined) {
      lines.push(`objects_path = ${JSON.stringify(bucket.objectsPath)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export type Project = {
  config: string | Error;
  /** File paths relative to `supabase/`, mapped to the sha256 of their bytes. */
  files: Record<string, string>;
  dirs?: readonly string[];
  objectsPaths: readonly string[];
};

export const seedFiles = (
  dir: string,
  files: readonly SeedFile[],
  keyOf: (file: SeedFile) => string = (file) => file.key
): Record<string, string> =>
  Object.fromEntries(
    files.map((file) => [`${dir}/${keyOf(file)}`, file.sha256])
  );

export function project(
  buckets: readonly BucketConfig[],
  files: Record<string, string> = {},
  options: { storageEnabled?: boolean; dirs?: readonly string[] } = {}
): Project {
  return {
    config: configToml(buckets, options),
    files,
    dirs: options.dirs,
    objectsPaths: buckets.flatMap((bucket) =>
      bucket.objectsPath === undefined ? [] : [bucket.objectsPath]
    ),
  };
}

const MEDIA_CONFIG: BucketConfig = {
  name: MEDIA_BUCKET,
  public: true,
  objectsPath: './storage/media',
};

export const untouchedProject = (): Project =>
  project(
    [MEDIA_CONFIG],
    seedFiles('storage/media', [...AVATARS, ...INVOICES])
  );

export const passingProject = (): Project =>
  project(
    [
      MEDIA_CONFIG,
      { name: 'invoices', public: false, objectsPath: './storage/invoices' },
    ],
    {
      ...seedFiles('storage/media', AVATARS),
      ...seedFiles('storage/invoices', INVOICES, (file) => basename(file.key)),
    }
  );

export const fetched = (
  status: number | null,
  sha256: string | null = null
): Fetched => ({ status, sha256 });

export const served = (sha256: string): Fetched => fetched(200, sha256);

export type Held = {
  bucket: string;
  key: string;
  service: Fetched;
  public?: Fetched;
  anon?: Fetched;
};

export const avatarHeld = (file: SeedFile): Held => ({
  bucket: MEDIA_BUCKET,
  key: file.key,
  service: served(file.sha256),
  public: served(file.sha256),
});

export function invoiceHeld(
  file: SeedFile,
  where: {
    bucket?: string;
    key?: string;
    public?: Fetched;
    anon?: Fetched;
  } = {}
): Held {
  return {
    bucket: where.bucket ?? PRIVATE_INVOICES.id,
    key: where.key ?? basename(file.key),
    service: served(file.sha256),
    ...(where.public === undefined ? {} : { public: where.public }),
    anon: where.anon ?? fetched(400),
  };
}

export const mediaInvoiceHeld = (
  file: SeedFile,
  where: { public?: Fetched; anon?: Fetched } = {}
): Held =>
  invoiceHeld(file, {
    bucket: MEDIA_BUCKET,
    key: file.key,
    public: where.public ?? served(file.sha256),
    anon: where.anon,
  });

export const movedInvoices = (): Held[] =>
  INVOICES.map((file) => invoiceHeld(file));

export const mediaAvatars = (): Held[] => AVATARS.map(avatarHeld);

export type ProbeSpec = {
  buckets?: Bucket[];
  objects?: Held[];
  control?: Fetched;
  serviceIdentity?: ServiceIdentity | null;
  anonControl?: Fetched;
  anonIdentity?: AnonIdentity | null;
  originalInvoices?: Record<string, Fetched>;
  avatars?: Record<string, Fetched>;
};

export function storageProbe(
  spec: ProbeSpec = {}
): Extract<StorageProbe, { ok: true }> {
  const buckets = spec.buckets ?? [MEDIA, PRIVATE_INVOICES];
  const objects: StoredObject[] = (
    spec.objects ?? [...mediaAvatars(), ...movedInvoices()]
  ).map((held) => ({
    bucket: held.bucket,
    key: held.key,
    bucketPublic: buckets.some(
      (bucket) => bucket.id === held.bucket && bucket.public
    ),
    service: held.service,
    ...(held.public === undefined ? {} : { public: held.public }),
    ...(held.anon === undefined ? {} : { anon: held.anon }),
  }));
  return {
    ok: true,
    apiUrl: API_URL,
    buckets,
    objects,
    control: spec.control ?? served(EMPTY_SHA),
    serviceIdentity:
      spec.serviceIdentity === undefined
        ? 'service-role'
        : spec.serviceIdentity,
    anonControl: spec.anonControl ?? served(EMPTY_SHA),
    anonIdentity: spec.anonIdentity === undefined ? 'anon' : spec.anonIdentity,
    originalInvoices:
      spec.originalInvoices ??
      Object.fromEntries(INVOICES.map(({ key }) => [key, fetched(404)])),
    avatars:
      spec.avatars ??
      Object.fromEntries(
        AVATARS.map(({ key, sha256 }) => [key, served(sha256)])
      ),
  };
}

export const bucketSeeding = (
  name: string,
  isPublic: boolean,
  files: readonly SeedFile[],
  objectsPath = `./storage/${name}`
): SeededBucket => ({
  name,
  public: isPublic,
  objectsPath,
  files: [...files],
});

type ReadSeed = Extract<SeedConfigProbe, { ok: true }>;

export const seedProbe = (...buckets: SeededBucket[]): ReadSeed => ({
  ok: true,
  storageEnabled: true,
  buckets,
});

export const passingSeed = (): ReadSeed =>
  seedProbe(
    bucketSeeding(MEDIA_BUCKET, true, AVATARS),
    bucketSeeding('invoices', false, INVOICES)
  );

export const untouchedSeed = (): ReadSeed =>
  seedProbe(bucketSeeding(MEDIA_BUCKET, true, [...AVATARS, ...INVOICES]));

export type Kind = 'curl' | 'psql' | 'keys' | 'find' | 'version' | 'other';

export type Intercept = (
  kind: Kind,
  call: number,
  command: string
) => CommandResult | 'throw' | undefined;

export type SandboxOptions = {
  world?: World;
  project?: Project;
  legacyKeys?: string | null;
  managedKeys?: string | null;
  version?: string;
  intercept?: Intercept;
};

const SKIPPED_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

const STORAGE_PREFIX = `${API_URL}/storage/v1/`;

function identityOf(command: string): Identity {
  if (command.includes(SERVICE_ROLE)) return 'service';
  if (command.includes(SECRET_KEY)) return 'secret';
  if (command.includes(ANON)) return 'anon';
  if (command.includes(PUBLISHABLE)) return 'publishable';
  return 'none';
}

const isPrivileged = (identity: Identity) =>
  identity === 'service' || identity === 'secret';

const isAnon = (identity: Identity) =>
  identity === 'anon' || identity === 'publishable';

function parseRequest(command: string): Seen | undefined {
  const start = command.indexOf(STORAGE_PREFIX);
  if (start === -1) return undefined;
  const url = /^[^\s'"]+/.exec(command.slice(start))?.[0] ?? '';
  const rest = url.slice(STORAGE_PREFIX.length);
  const identity = identityOf(command);
  if (rest === 'bucket' || rest.startsWith('bucket?')) {
    return { kind: 'control', identity, command };
  }
  const segments = rest.split('/');
  if (segments[0] !== 'object') return undefined;
  const isPublic = segments[1] === 'public';
  const [bucket, ...key] = segments
    .slice(isPublic ? 2 : 1)
    .map(decodeURIComponent);
  return {
    kind: isPublic ? 'public' : 'service',
    identity,
    bucket,
    key: key.join('/'),
    command,
  };
}

function answer(world: World, seen: Seen): { status: number; sha256: string } {
  const accepts = world.accepts ?? ['service', 'secret'];
  const reply = (status: number, sha256 = EMPTY_SHA) => ({ status, sha256 });
  if (seen.kind === 'control') {
    const accepted = isPrivileged(seen.identity)
      ? accepts.includes(seen.identity)
      : isAnon(seen.identity) && world.rejectsAnon !== true;
    return reply(
      world.controlStatus?.[seen.identity] ?? (accepted ? 200 : 401)
    );
  }
  const found = world.objects.find(
    (object) => object.bucket === seen.bucket && object.key === seen.key
  );
  const sha256 = found?.sha256 ?? EMPTY_SHA;
  const readable = found !== undefined && found.bytes !== false;
  if (seen.kind === 'public') {
    if (!world.buckets.some((b) => b.id === seen.bucket && b.public)) {
      return reply(400, sha256);
    }
    if (found === undefined) return reply(404);
    return readable ? reply(200, sha256) : reply(400, sha256);
  }
  if (seen.identity === 'none') return reply(400, sha256);
  if (isPrivileged(seen.identity)) {
    if (!accepts.includes(seen.identity)) return reply(401, sha256);
    if (found === undefined) return reply(404);
    return readable ? reply(200, sha256) : reply(400, sha256);
  }
  if (world.rejectsAnon) return reply(401, sha256);
  if (found === undefined) return reply(404);
  const allowed = world.anonReads?.(found.bucket, found.key) === true;
  return allowed && readable ? reply(200, sha256) : reply(400, sha256);
}

function classify(command: string): Kind {
  if (command.includes('curl')) return 'curl';
  if (command.includes('psql')) return 'psql';
  if (command.includes(MISSING_PATH_MARKER)) return 'find';
  if (command.includes('stack status') || command.includes('supabase status')) {
    return 'keys';
  }
  if (command.endsWith('supabase --version')) return 'version';
  return 'other';
}

/** An in-memory sandbox that answers the storage curl, the storage psql query, the key and version commands and the seed listing, and records what was run. */
export function createSandbox(options: SandboxOptions = {}) {
  const commands: string[] = [];
  const events: Kind[] = [];
  const requests: Seen[] = [];
  const reads: string[] = [];
  const calls = new Map<Kind, number>();

  const storage = (command: string): CommandResult => {
    const { world } = options;
    const seen = parseRequest(command);
    if (world === undefined || seen === undefined) {
      return failed('curl: (7) Failed to connect', 7);
    }
    requests.push(seen);
    const { status, sha256 } = answer(world, seen);
    return ok(`${status} ${sha256}\n`);
  };

  const rows = (): CommandResult => {
    const { world } = options;
    if (world === undefined) {
      return failed('psql: error: connection refused');
    }
    return ok(
      `${JSON.stringify({
        buckets: world.buckets,
        objects: world.objects.map(({ bucket, key }) => ({
          bucket,
          name: key,
        })),
      })}\n`
    );
  };

  const keysOf = (output: string | null | undefined): CommandResult =>
    output === null || output === undefined
      ? failed('The local stack is not running')
      : ok(output);

  const keys = (command: string): CommandResult => {
    if (!command.includes('stack status')) {
      return keysOf(
        options.legacyKeys === undefined ? STATUS_JSON : options.legacyKeys
      );
    }
    if (command.includes('--env')) return keysOf(options.managedKeys);
    return options.managedKeys == null
      ? failed('The local stack is not running')
      : ok('{"runtime":"docker"}');
  };

  const listing = (command: string): CommandResult => {
    const current = options.project;
    const objectsPath = current?.objectsPaths
      .filter((candidate) => command.includes(shellQuote(candidate)))
      .sort((a, b) => b.length - a.length)[0];
    if (current === undefined || objectsPath === undefined) {
      return failed('find: unrecognised objects_path');
    }
    const dir = path.posix.normalize(objectsPath).replace(/\/$/, '');
    const prefix = dir === '.' ? '' : `${dir}/`;
    const inside = Object.entries(current.files)
      .filter(([file]) => file.startsWith(prefix))
      .filter(
        ([file]) =>
          !SKIPPED_FILES.some(
            (name) =>
              command.includes(`! -name ${name}`) && basename(file) === name
          )
      );
    const exists =
      prefix === '' ||
      inside.length > 0 ||
      (current.dirs ?? []).includes(dir) ||
      Object.keys(current.files).some((file) => file.startsWith(prefix));
    if (!exists) return ok(`${MISSING_PATH_MARKER}\n`);
    return ok(
      inside
        .map(([file, sha256]) => `${sha256}  ./${file.slice(prefix.length)}\n`)
        .join('')
    );
  };

  const respond = (kind: Kind, command: string): CommandResult => {
    switch (kind) {
      case 'curl':
        return storage(command);
      case 'psql':
        return rows();
      case 'find':
        return listing(command);
      case 'keys':
        return keys(command);
      case 'version':
        return ok(`${options.version ?? '2.117.0'}\n`);
      default:
        return failed(`unrecognised command: ${command}`);
    }
  };

  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    const kind = classify(command);
    events.push(kind);
    const call = calls.get(kind) ?? 0;
    calls.set(kind, call + 1);
    const forced = options.intercept?.(kind, call, command);
    if (forced === 'throw') throw new Error('sandbox gone');
    if (forced !== undefined) return forced;
    return respond(kind, command);
  };

  const readFile = async (file: string): Promise<string> => {
    reads.push(file);
    const current = options.project;
    if (current === undefined || file !== SEED_CONFIG_PATH) {
      throw new Error(`ENOENT: no such file or directory, open '${file}'`);
    }
    if (current.config instanceof Error) throw current.config;
    return current.config;
  };

  return {
    ctx: { exec, readFile, workspace: WORKSPACE } as Pick<
      LocalStackEvalContext,
      'exec' | 'readFile' | 'workspace'
    >,
    commands,
    events,
    requests,
    reads,
  };
}
