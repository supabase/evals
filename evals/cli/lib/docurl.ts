import {
  buildDocsResult,
  type CheckResult,
  type LocalStackEvalContext,
  type ScoreResult,
  type ToolCallRecord,
} from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from './shell.js';
import { probeStackReady, type StackProbe } from './stack.js';

/**
 * Helpers for the docUrl A/B evals (`resolve-cli-002` to `resolve-cli-004`).
 * They measure whether an agent reads the troubleshooting article that the CLI
 * links in its error output (supabase/cli#7749). Reading is a metric, never a
 * gate: the scenario checks alone decide `passed`.
 */

export const DOC_URL_READ_CHECK = 'read_doc_url';
export const DOC_URL_SEEN_CHECK = 'saw_doc_url';

const FETCH_WORD = /\b(?:curl|wget|fetch)\b/i;

/** Lower-cases the host and drops the query, the hash, a trailing slash and a `.md` suffix, so `<url>.md` counts as the article. */
export function normalizeArticleUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/+$/, '').replace(/\.md$/i, '');
    return `${url.protocol}//${url.hostname.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

function sameArticle(candidate: string, expected: string): boolean {
  return (
    normalizeArticleUrl(candidate) !== undefined &&
    normalizeArticleUrl(candidate) === normalizeArticleUrl(expected)
  );
}

function shellCommandOf(call: ToolCallRecord): string | undefined {
  if (call.name !== 'shell') return undefined;
  if (call.command) return call.command;
  return typeof call.body?.command === 'string' ? call.body.command : undefined;
}

/** How the agent read `expectedUrl`, or `undefined` when no tool call read it. */
export function findDocUrlRead(
  toolCalls: readonly ToolCallRecord[],
  expectedUrl: string
): string | undefined {
  const docs = buildDocsResult([...toolCalls]);
  for (const entry of docs.calls) {
    if (entry.hasContent === false) continue;
    if (entry.pages.some((page) => sameArticle(page.url, expectedUrl))) {
      return entry.source;
    }
  }
  for (const call of toolCalls) {
    if (call.error) continue;
    const command = shellCommandOf(call);
    if (command === undefined || !FETCH_WORD.test(command)) continue;
    const urls = command.match(/https?:\/\/[^\s'"`\;|&>()]+/g) ?? [];
    if (
      urls.some((url) => sameArticle(url.replace(/[.,]+$/, ''), expectedUrl))
    ) {
      return 'shell_command';
    }
  }
  return undefined;
}

/** True when the article URL appears in any tool result, as when the CLI prints it in an error. */
export function sawDocUrl(
  toolCalls: readonly ToolCallRecord[],
  expectedUrl: string
): boolean {
  return toolCalls.some((call) => {
    if (shellCommandOf(call) === undefined) return false;
    const output = [call.result, call.error]
      .filter((part) => part !== undefined)
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join('\n');
    return output.includes(expectedUrl);
  });
}

/**
 * The two docUrl metrics as checks. Both always carry `passed: true`, so they
 * never fail a run. The value sits in the notes as `read_doc_url=true|false`.
 */
export function docUrlMetricChecks(
  toolCalls: readonly ToolCallRecord[],
  expectedUrl: string
): CheckResult[] {
  const via = findDocUrlRead(toolCalls, expectedUrl);
  return [
    {
      name: DOC_URL_READ_CHECK,
      passed: true,
      notes: `${DOC_URL_READ_CHECK}=${via !== undefined}${via ? ` (via ${via})` : ''}; metric only, not gating`,
    },
    {
      name: DOC_URL_SEEN_CHECK,
      passed: true,
      notes: `${DOC_URL_SEEN_CHECK}=${sawDocUrl(toolCalls, expectedUrl)}; metric only, not gating`,
    },
  ];
}

/** `passed` follows the gating checks only; the docUrl metrics ride along. */
export function scoreWithDocUrlMetrics(
  gating: readonly CheckResult[],
  toolCalls: readonly ToolCallRecord[],
  expectedUrl: string
): ScoreResult {
  return {
    passed: gating.every((check) => check.passed),
    checks: [...gating, ...docUrlMetricChecks(toolCalls, expectedUrl)],
  };
}

export type SqlRun = { ok: boolean; stdout: string; notes: string };

/** Runs `sql` through psql in the stack's database with `ON_ERROR_STOP`, quiet and unaligned. */
export async function runSql(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  sql: string,
  options: { fieldSeparator?: string } = {}
): Promise<SqlRun> {
  if (!stack.ok) return { ok: false, stdout: '', notes: stack.notes };
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const separator = options.fieldSeparator
    ? ` -F ${shellQuote(options.fieldSeparator)}`
    : '';
  try {
    const result = await ctx.exec(
      `echo ${encoded} | base64 -d | psql ${shellQuote(stack.dbUrl)} -XqtA -v ON_ERROR_STOP=1${separator}`
    );
    return {
      ok: result.ok,
      stdout: result.stdout,
      notes: result.ok ? 'ok' : describeFailure(result),
    };
  } catch (error) {
    return { ok: false, stdout: '', notes: errorMessage(error) };
  }
}

/** Gating check shared by the docUrl evals: the project's local database answers. */
export async function checkStackRunning(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<CheckResult> {
  const { ready, notes } = await probeStackReady(ctx, stack);
  return {
    name: 'local stack is running for this project',
    passed: ready,
    notes,
  };
}

/** The scorer's catch-all, so an unexpected throw fails the run with a readable note. */
export function scorerFailure(evalId: string, error: unknown): ScoreResult {
  return {
    passed: false,
    checks: [
      {
        name: `scorer evaluated ${evalId}`,
        passed: false,
        notes: errorMessage(error),
      },
    ],
  };
}
