#!/usr/bin/env tsx
/**
 * Runs the evals, then uploads the runs it just produced.
 *
 * Both steps take the same filter flags, so they are forwarded verbatim to
 * each. The uploader ignores flags it doesn't recognise (`--runs`,
 * `--concurrency`, …), and a failed eval skips the upload.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

for (const script of ['../harness/run-eval.ts', './upload-braintrust.ts']) {
  const { status } = spawnSync(
    process.execPath,
    [
      `--env-file=${resolve(HERE, '..', '..', '..', '.env')}`,
      '--import',
      'tsx/esm',
      join(HERE, script),
      ...args,
    ],
    { stdio: 'inherit' }
  );
  if (status !== 0) {
    process.exit(status ?? 1);
  }
}
