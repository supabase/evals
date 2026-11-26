import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import { collectSourcesScript } from './files.js';
import { type Analysis, analyze } from './typecheck.js';

export const REFRESH_SCRIPT = 'db:types';

export type Refresh =
  | { ran: true; column: string; analysis: Analysis }
  | { ran: false; reason: string };

const PIN_CLI =
  '[ -e node_modules/.bin/supabase ] || { mkdir -p node_modules/.bin && ln -s "$(command -v supabase)" node_modules/.bin/supabase; }';

export async function refreshAfterChange(
  ctx: LocalStackEvalContext
): Promise<Refresh> {
  if (!hasScript(ctx.hostWorkspace)) {
    return {
      ran: false,
      reason: `package.json has no "${REFRESH_SCRIPT}" script`,
    };
  }

  const column = `shelf_${randomBytes(3).toString('hex')}`;
  const altered = await execSql(
    ctx,
    `alter table catalog.books add column ${column} text;`
  );
  if (!altered.ok) {
    return {
      ran: false,
      reason: `the scorer could not add a column to catalog.books: ${altered.message}`,
    };
  }

  try {
    const result = await ctx.exec(
      `${PIN_CLI}; npm run ${REFRESH_SCRIPT} 2>&1`,
      { timeoutMs: 300_000 }
    );
    if (result.exitCode !== 0) {
      return {
        ran: false,
        reason: `npm run ${REFRESH_SCRIPT} exited ${result.exitCode}: ${lastLines(result.stdout ?? '')}`,
      };
    }
    const encoded = Buffer.from(collectSourcesScript(), 'utf8').toString(
      'base64'
    );
    const collected = await ctx.exec(
      `node -e "$(echo ${encoded} | base64 -d)"`,
      { timeoutMs: 60_000 }
    );
    if (collected.exitCode !== 0) {
      return {
        ran: false,
        reason: `the scorer could not read the workspace back: ${lastLines(collected.stderr ?? '')}`,
      };
    }
    const overlay = JSON.parse(collected.stdout ?? '{}') as Record<
      string,
      string
    >;
    return {
      ran: true,
      column,
      analysis: analyze(ctx.hostWorkspace, overlay, column),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ran: false, reason: message.slice(0, 300) };
  }
}

function hasScript(hostWorkspace: string): boolean {
  const manifest = join(hostWorkspace, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
    return typeof scripts[REFRESH_SCRIPT] === 'string';
  } catch {
    return false;
  }
}

function lastLines(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join(' | ')
    .slice(0, 300);
}
