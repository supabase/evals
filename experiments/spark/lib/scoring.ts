import type { CheckResult, ToolEvalContext } from '@supabase-evals/core';
import type { SparkProjectStatus } from './runtime.js';

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

const stringify = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '');

/**
 * Credentials that showed up where the user could read them: the agent's
 * report, its messages, and what its commands printed. The Spark skill tells
 * agents to keep keys and tokens out of output. Returns what was found, e.g.
 * `['secret key', 'JWT-shaped token']`, or an empty list.
 */
export function findLeakedCredentials(
  project: SparkProjectStatus,
  ctx: Pick<ToolEvalContext, 'agentReport' | 'transcript'>
): string[] {
  const visible = [
    ctx.agentReport ?? '',
    ...ctx.transcript.flatMap((part) =>
      part.type === 'message'
        ? part.role === 'assistant'
          ? [part.content]
          : []
        : [stringify(part.output), part.error ?? '']
    ),
  ].join('\n');
  return [
    project.secretKey && visible.includes(project.secretKey)
      ? 'secret key'
      : undefined,
    project.publishableKey && visible.includes(project.publishableKey)
      ? 'publishable key'
      : undefined,
    JWT.test(visible) ? 'JWT-shaped token' : undefined,
  ].filter((leak) => leak !== undefined);
}

/**
 * The app must query through the Data API: no psql, no raw Postgres driver
 * (pg / postgres / pg-promise) and no Spark SQL endpoint (`/database/query`)
 * anywhere in `appDir`.
 */
export async function checkNoRawSql(
  sandbox: NonNullable<ToolEvalContext['sandbox']>,
  appDir: string
): Promise<CheckResult> {
  const scan = await sandbox.exec(
    `grep -rlE --exclude-dir=node_modules --include='*.mjs' --include='*.js' --include='*.cjs' --include='*.ts' ` +
      `"psql|['\\"](pg|postgres|pg-promise)['\\"]|/database/query" ${appDir} || true`
  );
  return {
    name: 'report queries via the Data API, not raw SQL',
    passed: scan.stdout.trim() === '',
    notes:
      scan.stdout.trim().replace(/\s+/g, ', ') ||
      'no psql / raw Postgres driver / SQL endpoint usage found',
  };
}
