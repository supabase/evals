import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';

// The probes only see Storage through this, so they also run against a fake.
// Every method answers as the server key would: it bypasses access policies,
// so what these probes measure is the bucket's own settings, not policies.
export type Store = {
  /** The error message, or undefined when Storage reported none. */
  upload: (
    bucket: string,
    path: string,
    body: Uint8Array,
    contentType: string
  ) => Promise<{ error?: string }>;
  /** Whether storage.objects has the row. Read as the superuser, not inferred from an error. */
  stored: (bucket: string, path: string) => Promise<boolean>;
  /** A plain GET of the bucket's public url. */
  fetchPublic: (
    bucket: string,
    path: string
  ) => Promise<{ status: number; body: Uint8Array }>;
  /** A download made with the server key. */
  download: (bucket: string, path: string) => Promise<Uint8Array | undefined>;
};

export const PHOTOS = 'press-photos';
export const INVOICES = 'invoices';

const MB = 1_000_000;

export const CHECK = {
  photosAccepted: 'press-photos: a png and a jpeg under 2 MB are accepted',
  photosSize: 'press-photos: a 3 MB image is turned away',
  photosType: 'press-photos: a PDF is turned away',
  photosVisible: 'press-photos: anyone with the link can see a photo',
  invoicesAccepted: 'invoices: a PDF under 10 MB is accepted',
  invoicesSize: 'invoices: a 12 MB PDF is turned away',
  invoicesType: 'invoices: a png is turned away',
  invoicesHidden: 'invoices: a link alone does not open one',
} as const;

type Sample = { name: string; type: string; size: number; signature: string };

type Plan = {
  bucket: string;
  accepted: Sample[];
  tooBig: Sample;
  wrongType: Sample;
};

// The accepted samples sit well inside the limit and the refused ones well
// outside it, so 2 MB read as 2,000,000 or 2,097,152 bytes gives the same
// verdicts. 1.5 MB is also what a limit set in the wrong unit refuses.
const PLANS: Record<'photos' | 'invoices', Plan> = {
  photos: {
    bucket: PHOTOS,
    accepted: [
      {
        name: 'studio.png',
        type: 'image/png',
        size: 1.5 * MB,
        signature: '\x89PNG\r\n\x1a\n',
      },
      {
        name: 'kiln.jpg',
        type: 'image/jpeg',
        size: 0.2 * MB,
        signature: '\xff\xd8\xff\xe0',
      },
    ],
    tooBig: {
      name: 'huge.png',
      type: 'image/png',
      size: 3 * MB,
      signature: '\x89PNG\r\n\x1a\n',
    },
    wrongType: {
      name: 'order.pdf',
      type: 'application/pdf',
      size: 0.1 * MB,
      signature: '%PDF-1.4\n',
    },
  },
  invoices: {
    bucket: INVOICES,
    accepted: [
      {
        name: 'order-1001.pdf',
        type: 'application/pdf',
        size: 8 * MB,
        signature: '%PDF-1.4\n',
      },
    ],
    tooBig: {
      name: 'order-1002.pdf',
      type: 'application/pdf',
      size: 12 * MB,
      signature: '%PDF-1.4\n',
    },
    wrongType: {
      name: 'scan.png',
      type: 'image/png',
      size: 0.1 * MB,
      signature: '\x89PNG\r\n\x1a\n',
    },
  },
};

// Every path starts with a per-run marker, and the marker is also inside every
// body, so nothing a previous run left behind can satisfy a probe.
export type World = { marker: string };
export const newWorld = (): World => ({
  marker: `fp${randomUUID().slice(0, 8)}`,
});

const pathOf = (world: World, sample: Sample) =>
  `${world.marker}/${sample.name}`;

function bodyOf(world: World, sample: Sample): Uint8Array {
  const head = Buffer.from(`${sample.signature}${world.marker}`, 'latin1');
  const body = Buffer.alloc(Math.max(sample.size, head.length), 'a');
  head.copy(body);
  return body;
}

const includesMarker = (body: Uint8Array, world: World) =>
  Buffer.from(body).includes(Buffer.from(world.marker));

const short = (text: string) => text.slice(0, 200);

export type Bucket = {
  plan: Plan;
  /** Whether the within-limits uploads went in. The control for everything else. */
  accepted: boolean;
  /** The first accepted sample, kept to read back. */
  path: string;
};

export type Probe = { bucket: Bucket; checks: CheckResult[] };

function notRun(name: string, reason: string): CheckResult {
  return { name, passed: false, notes: `not run: ${reason}` };
}

/**
 * Within-limits uploads first, because they are the positive control: a
 * refusal only means something in a bucket that takes the right file. They
 * also settle whether the bucket exists at all.
 */
export async function probeBucket(
  store: Store,
  world: World,
  which: 'photos' | 'invoices',
  names: { accepted: string; size: string; type: string },
  known: string
): Promise<Probe> {
  const plan = PLANS[which];
  const failures: string[] = [];
  for (const sample of plan.accepted) {
    const path = pathOf(world, sample);
    const { error } = await store.upload(
      plan.bucket,
      path,
      bodyOf(world, sample),
      sample.type
    );
    const stored = await store.stored(plan.bucket, path);
    if (!stored) {
      failures.push(
        `${sample.type} ${sample.size / MB} MB: ${short(error ?? 'no error, but nothing stored')}`
      );
    }
  }
  const accepted = failures.length === 0;
  const bucket: Bucket = {
    plan,
    accepted,
    path: pathOf(world, plan.accepted[0]),
  };
  const acceptedCheck: CheckResult = {
    name: names.accepted,
    passed: accepted,
    notes: accepted
      ? `${plan.accepted.length} stored in ${plan.bucket}`
      : `${failures.join('; ')}. Buckets in the project: ${known}`,
  };
  const reason = `${plan.bucket} did not take a file it should (see "${names.accepted}")`;
  const turnedAway = async (
    name: string,
    sample: Sample
  ): Promise<CheckResult> => {
    if (!accepted) return notRun(name, reason);
    const path = `${world.marker}/refused-${sample.name}`;
    const { error } = await store.upload(
      plan.bucket,
      path,
      bodyOf(world, sample),
      sample.type
    );
    const stored = await store.stored(plan.bucket, path);
    return {
      name,
      passed: !stored,
      notes: stored
        ? `${sample.type} ${sample.size / MB} MB was stored`
        : `refused: ${short(error ?? 'no error, nothing stored')}`,
    };
  };
  return {
    bucket,
    checks: [
      acceptedCheck,
      await turnedAway(names.size, plan.tooBig),
      await turnedAway(names.type, plan.wrongType),
    ],
  };
}

export async function checkAnyoneCanSee(
  store: Store,
  world: World,
  bucket: Bucket
): Promise<CheckResult> {
  const name = CHECK.photosVisible;
  if (!bucket.accepted)
    return notRun(name, `${bucket.plan.bucket} took no file to fetch`);
  const { status, body } = await store.fetchPublic(
    bucket.plan.bucket,
    bucket.path
  );
  const served = status === 200 && includesMarker(body, world);
  return {
    name,
    passed: served,
    notes: served
      ? 'the public url served the photo'
      : `the public url answered ${status} without the photo`,
  };
}

export async function checkLinkAloneDoesNotOpen(
  store: Store,
  world: World,
  bucket: Bucket
): Promise<CheckResult> {
  const name = CHECK.invoicesHidden;
  if (!bucket.accepted)
    return notRun(name, `${bucket.plan.bucket} took no file to fetch`);
  // The control: the server key can read it, so the object is really there
  // and an unserved link means the bucket refused, not that nothing exists.
  const mine = await store.download(bucket.plan.bucket, bucket.path);
  if (!mine || !includesMarker(mine, world)) {
    return notRun(
      name,
      'the invoice could not be read back with the server key'
    );
  }
  const { status, body } = await store.fetchPublic(
    bucket.plan.bucket,
    bucket.path
  );
  const served = status === 200 && includesMarker(body, world);
  return {
    name,
    passed: !served,
    notes: served
      ? 'the public url served the invoice to anyone with the link'
      : `the public url answered ${status}`,
  };
}
