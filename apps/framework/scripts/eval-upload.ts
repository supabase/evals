#!/usr/bin/env tsx
/**
 * Runs the evals, then uploads the runs it just produced.
 *
 * Both steps take the same filter flags, so they are forwarded verbatim to
 * each. The uploader ignores flags it doesn't recognise (`--runs`,
 * `--concurrency`, …) and is additionally told to skip results written before
 * this process started. A failed eval skips the upload.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// Anchors the upload to results written from here on, so runs left over from
// an earlier pass are not swept up.
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
