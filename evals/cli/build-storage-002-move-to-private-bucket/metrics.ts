import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { StackProbe } from '../lib/stack.js';
import type { StackKeys } from '../lib/stack-keys.js';
import type { StackLifecycle } from '../lib/stack-lifecycle.js';
import { invoiceFor } from './fixtures.js';
import type { SeedConfigProbe } from './seed-config.js';
import { present, type StorageProbe } from './storage.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[];
};

export async function readCliFacts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  invocations: readonly SupabaseInvocation[]
): Promise<CliFacts> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  const cliOverride = await safely(() =>
    versions === null
      ? []
      : listCliOverrides(
          invocations,
          versions.cliVersion,
          versions.cliVersionAfterRun ?? versions.cliVersion
        )
  );
  return { versions, cliOverride: cliOverride ?? [] };
}

export type StorageCommandCounts = {
  ls: number;
  cp: number;
  mv: number;
  rm: number;
  seedBuckets: number;
  dbReset: number;
  experimentalFlag: number;
  localFlag: number;
};

const STORAGE_VERBS = ['ls', 'cp', 'mv', 'rm'] as const;

const hasFlag = (invocation: SupabaseInvocation, flag: string): boolean =>
  invocation.argv.some((word) => word === flag || word === `${flag}=true`);

const isSeedBuckets = (invocation: SupabaseInvocation): boolean =>
  invocationVerb(invocation) === 'seed' &&
  invocationSubcommand(invocation) === 'buckets';

const isDbReset = (invocation: SupabaseInvocation): boolean =>
  invocationVerb(invocation) === 'db' &&
  invocationSubcommand(invocation) === 'reset';

/** Whether the invocation touches storage: a `storage` command, `seed buckets` or `db reset`. */
export function isStorageCommand(invocation: SupabaseInvocation): boolean {
  return (
    invocationVerb(invocation) === 'storage' ||
    isSeedBuckets(invocation) ||
    isDbReset(invocation)
  );
}

export function countStorageCommands(
  invocations: readonly SupabaseInvocation[]
): StorageCommandCounts {
  const counts: StorageCommandCounts = {
    ls: 0,
    cp: 0,
    mv: 0,
    rm: 0,
    seedBuckets: 0,
    dbReset: 0,
    experimentalFlag: 0,
    localFlag: 0,
  };
  for (const invocation of invocations) {
    if (invocationVerb(invocation) === 'storage') {
      const verb = STORAGE_VERBS.find(
        (candidate) => candidate === invocationSubcommand(invocation)
      );
      if (verb !== undefined) counts[verb] += 1;
      if (hasFlag(invocation, '--experimental')) counts.experimentalFlag += 1;
      if (hasFlag(invocation, '--local')) counts.localFlag += 1;
    } else if (isSeedBuckets(invocation)) {
      counts.seedBuckets += 1;
    } else if (isDbReset(invocation)) {
      counts.dbReset += 1;
    }
  }
  return counts;
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    keys: StackKeys;
    storage: StorageProbe;
    seed: SeedConfigProbe;
    lifecycle: StackLifecycle;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, keys, storage, seed, lifecycle, cli } =
    facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    docker: marker?.docker ?? null,
    stack: await safely(() =>
      stack.ok
        ? {
            backend: stack.backend,
            runtime: stack.runtime,
            relocatedHome: stack.relocatedHome ?? null,
          }
        : { backend: 'none', runtime: 'none', relocatedHome: null }
    ),
    keysFound: await safely(() => ({
      serviceRole: present(keys.serviceRole),
      secret: present(keys.secret),
      anon: present(keys.anon),
      publishable: present(keys.publishable),
    })),
    serviceIdentity: await safely(() =>
      storage.ok ? storage.serviceIdentity : null
    ),
    anonIdentity: await safely(() =>
      storage.ok ? storage.anonIdentity : null
    ),
    buckets: await safely(() =>
      storage.ok
        ? storage.buckets.map(({ id, public: isPublic }) => ({
            id,
            public: isPublic,
            objects: storage.objects.filter((object) => object.bucket === id)
              .length,
          }))
        : null
    ),
    invoiceLocations: await safely(() =>
      storage.ok
        ? storage.objects
            .filter((object) => invoiceFor(object.service.sha256) !== undefined)
            .map((object) => `${object.bucket}/${object.key}`)
        : null
    ),
    storageCommands: await safely(() => countStorageCommands(invocations)),
    freshSetupInvoiceBuckets: await safely(() =>
      seed.ok
        ? seed.buckets
            .filter((bucket) =>
              bucket.files.some((file) => invoiceFor(file.sha256) !== undefined)
            )
            .map((bucket) => bucket.name)
        : null
    ),
    stackStoppedByAgent: await safely(() => lifecycle.stoppedByAgent),
    lastStackCommand: await safely(() => lifecycle.lastCommand),
    // Regex diagnostic, never asserted against.
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
