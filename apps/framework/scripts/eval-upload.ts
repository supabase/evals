#!/usr/bin/env tsx
/** Runs evals, then uploads the result files written by this process. */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// The uploader uses this cutoff to ignore result files left by earlier runs.
const startedAt = Date.now();

for (const [script, extra] of [
  ['../harness/run-eval.ts', []],
  ['./upload-braintrust.ts', ['--since', String(startedAt)]],
] as const) {
  const { status } = spawnSync(
    process.execPath,
    [
      `--env-file=${resolve(HERE, '..', '..', '..', '.env')}`,
      '--import',
      'tsx/esm',
      join(HERE, script),
      ...args,
      ...extra,
    ],
    { stdio: 'inherit' }
  );
  if (status !== 0) {
    process.exit(status ?? 1);
  }
}
