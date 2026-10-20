import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import { DIGEST_SECRET } from './fixture.js';

export type SecretHit = { file: string; ignored: boolean };

export type SecretScan =
  | { ok: true; functionSources: string[]; hits: SecretHit[] }
  | { ok: false; notes: string };

const MAX_SCANNED_BYTES = 1024 * 1024;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const SKIPPED_PATHS = new Set(['supabase/.temp', 'supabase/.branches']);
const FUNCTIONS_DIR = 'supabase/functions';
const FUNCTION_SOURCE = /\.(ts|tsx|js|mjs|jsx)$/;

/** `text` with every occurrence of the seeded secret replaced by a placeholder. */
export function maskSecret(text: string): string {
  return text.replaceAll(DIGEST_SECRET, '<DIGEST_SECRET>');
}

// Dirent reports a symlink as neither a file nor a directory, so none is followed.
function listFiles(root: string, relativeDir: string): string[] {
  const entries = fs.readdirSync(path.join(root, relativeDir), {
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) || SKIPPED_PATHS.has(relative)
        ? []
        : listFiles(root, relative);
    }
    return entry.isFile() ? [relative] : [];
  });
}

function holdsSecret(file: string, secret: string): boolean {
  return (
    fs.statSync(file).size <= MAX_SCANNED_BYTES &&
    fs.readFileSync(file).includes(secret)
  );
}

/** Files under `root` that contain `secret`, as sorted relative posix paths. */
export function findSecretFiles(root: string, secret: string): string[] {
  return listFiles(root, '')
    .filter((file) => holdsSecret(path.join(root, file), secret))
    .sort();
}

/** Script and module files under `supabase/functions`, as sorted relative posix paths. */
export function findFunctionSources(root: string): string[] {
  if (!fs.existsSync(path.join(root, FUNCTIONS_DIR))) return [];
  return listFiles(root, FUNCTIONS_DIR)
    .filter((file) => FUNCTION_SOURCE.test(file))
    .sort();
}

function listNotIgnoredScript(files: readonly string[]): string {
  return [
    'git rev-parse --git-dir >/dev/null 2>&1 || git init -q',
    `for f in ${files.map(shellQuote).join(' ')}; do git check-ignore -q "$f" || echo "$f"; done`,
  ].join('\n');
}

/** Finds every file holding the secret and asks the sandbox's git which of them it would commit. */
export async function scanSecret(
  ctx: LocalStackEvalContext
): Promise<SecretScan> {
  const functionSources = findFunctionSources(ctx.hostWorkspace);
  const files = findSecretFiles(ctx.hostWorkspace, DIGEST_SECRET);
  try {
    const result = await ctx.exec(listNotIgnoredScript(files));
    if (!result.ok) {
      return {
        ok: false,
        notes: `could not read ignore rules: ${describeFailure(result)}`,
      };
    }
    const notIgnored = new Set(result.stdout.split('\n'));
    return {
      ok: true,
      functionSources,
      hits: files.map((file) => ({ file, ignored: !notIgnored.has(file) })),
    };
  } catch (error) {
    return {
      ok: false,
      notes: `could not read ignore rules: ${errorMessage(error)}`,
    };
  }
}

export function checkSecretKeptOut(scan: SecretScan): CheckResult {
  const name = 'the secret stays out of committed files';
  if (!scan.ok) return { name, passed: false, notes: scan.notes };
  if (scan.functionSources.length === 0) {
    return {
      name,
      passed: false,
      notes: `no function source under ${FUNCTIONS_DIR}/`,
    };
  }
  const committed = scan.hits.filter(({ ignored }) => !ignored);
  if (committed.length > 0) {
    return {
      name,
      passed: false,
      notes: `the secret would be committed in ${committed.map(({ file }) => file).join(', ')}`,
    };
  }
  return {
    name,
    passed: true,
    notes:
      scan.hits.length === 0
        ? 'the secret literal appears in no file'
        : `the secret literal sits only in ignored files: ${scan.hits.map(({ file }) => file).join(', ')}`,
  };
}
