import type {
  CheckResult,
  ToolCallRecord,
  ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK = 'reached a target page in under 10 hops';

const NAVIGATOR_TOOL = 'open_page';
// The docs navigator's replies, from experiments/docs/lib/docs-navigator.mjs.
const OPENED_PATTERN = /Opened: (https:\/\/[^\s"\\]*)/;
const BLOCKED_PREFIX = 'Not opened:';

/**
 * How bad a run's wayfinding was, by hops to the target. Ten hops or more, or
 * never reaching the target, is a big failure.
 */
export type Severity = 'clean' | 'friction' | 'failure' | 'big failure';

export interface Navigation {
  /**
   * `open_page` calls before the first one that opened a target or alternate,
   * refused ones included. Null when none did.
   */
  hopsToTarget: number | null;
  reachedTarget: string | null;
  /** The first page reached was an alternate, a duplicate of a target. */
  viaAlternate: boolean;
  /** Docs paths the agent opened, in order. */
  opened: string[];
  /**
   * Urls the navigator refused because no opened page linked them: the agent
   * reaching for a page it remembers instead of navigating to it.
   */
  blockedJumps: string[];
  severity: Severity;
}

/** A supabase.com docs url as a path like `guides/platform/sso`; the docs root is `docs`. */
export function docsPath(url: string): string {
  const path = new URL(url, 'https://supabase.com').pathname
    .replace(/\.md$/, '')
    .replace(/^\/+|\/+$/g, '');
  return path === 'docs' ? path : path.replace(/^docs\//, '');
}

export function severityOf(hopsToTarget: number | null): Severity {
  if (hopsToTarget === null || hopsToTarget >= 10) return 'big failure';
  if (hopsToTarget >= 7) return 'failure';
  if (hopsToTarget >= 4) return 'friction';
  return 'clean';
}

function replyText(call: ToolCallRecord): string {
  const result =
    typeof call.result === 'string'
      ? call.result
      : JSON.stringify(call.result ?? '');
  return `${call.error ?? ''}${result}`;
}

/** Scores an agent's path through the docs navigator to a task's target pages. */
export function scoreNavigation(
  toolCalls: ToolCallRecord[],
  targets: string[],
  alternates: string[] = []
): Navigation {
  const wanted = new Set([...targets, ...alternates]);
  const opened: string[] = [];
  const blockedJumps: string[] = [];
  let hopsToTarget: number | null = null;
  let reachedTarget: string | null = null;

  const calls = toolCalls.filter(
    (call) => call.tool.toolName === NAVIGATOR_TOOL
  );
  for (const [hop, call] of calls.entries()) {
    const text = replyText(call);
    const requested = typeof call.body.url === 'string' ? call.body.url : '';
    if (text.includes(BLOCKED_PREFIX)) {
      blockedJumps.push(docsPath(requested));
      continue;
    }
    // The navigator follows redirects and names the page it landed on.
    const landed = text.match(OPENED_PATTERN)?.[1];
    if (!landed) continue;
    const path = docsPath(landed);
    opened.push(path);
    if (hopsToTarget === null && wanted.has(path)) {
      hopsToTarget = hop;
      reachedTarget = path;
    }
  }

  return {
    hopsToTarget,
    reachedTarget,
    viaAlternate: reachedTarget !== null && !targets.includes(reachedTarget),
    opened,
    blockedJumps,
    severity: severityOf(hopsToTarget),
  };
}

/**
 * Passes when the agent opened a target, or an alternate that answers the
 * task as well, without a big failure. The notes carry the full navigation.
 */
export function checkReachedTarget(
  ctx: Pick<ToolEvalContext, 'toolCalls'>,
  targets: string[],
  alternates: string[] = []
): CheckResult {
  const navigation = scoreNavigation(ctx.toolCalls, targets, alternates);
  return {
    name: REACHED_TARGET_CHECK,
    passed: navigation.severity !== 'big failure',
    notes: JSON.stringify(navigation),
  };
}

/** Rubric for judging whether the agent's final answer covers a task's facts. */
export function factsRubric(facts: string[]): string {
  return stripIndent`
    The input is an agent's final answer to a developer's question about Supabase.
    Pass only if the answer covers every fact below. Judge substance, not
    wording: a fact is covered when the answer's instructions state it or
    plainly depend on it. Text in parentheses is context for you, not a
    requirement. An answer that says to look something up, or covers a
    different product feature, fails.

    Facts:
    ${facts.map((fact) => `- ${fact}`).join('\n')}
  `;
}
