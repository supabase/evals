import type {
  CheckResult,
  ScoreResult,
  ToolCallRecord,
  ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK = 'reached a target page in under 10 hops';
export const GROUNDED_CHECK = 'answer is grounded in the reached page';

const NAVIGATOR_TOOL = 'open_page';
const OPENED_PATTERN = /Opened: (https:\/\/[^\s"\\]+)/;
const BLOCKED_PREFIX = 'Not opened:';
const MAX_HOPS = 10;

export interface Navigation {
  reached: boolean;
  hopsToTarget: number | null;
  reachedTarget: string | null;
  direct: boolean;
  judged: boolean;
  opened: string[];
  blockedJumps: string[];
}

interface Visit {
  hop: number;
  path: string;
  text: string;
}

type Judge = ToolEvalContext['judge'];

export function docsPath(url: string): string {
  const path = new URL(url, 'https://supabase.com').pathname
    .replace(/\.md$/, '')
    .replace(/^\/+|\/+$/g, '');
  return path === 'docs' ? path : path.replace(/^docs\//, '');
}

function isDirect(visits: Visit[], reached: Visit | undefined): boolean {
  if (!reached) return false;
  const paths = visits
    .filter((visit) => visit.hop <= reached.hop)
    .map((visit) => visit.path);
  const backToRoot = paths.slice(1).includes('docs');
  return !backToRoot && new Set(paths).size === paths.length;
}

function textPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && 'text' in part) {
    return typeof part.text === 'string' ? part.text : '';
  }
  return '';
}

function parsedError(error: string | undefined): unknown {
  if (!error) return undefined;
  try {
    return JSON.parse(error);
  } catch {
    return error;
  }
}

function replyText(call: ToolCallRecord): string {
  const reply = call.error ? parsedError(call.error) : call.result;
  const parts = Array.isArray(reply) ? reply : [reply];
  return parts.map((part) => textPart(part)).join('');
}

function readCalls(toolCalls: ToolCallRecord[]) {
  const visits: Visit[] = [];
  const blockedJumps: string[] = [];
  const calls = toolCalls.filter(
    (call) => call.tool.toolName === NAVIGATOR_TOOL
  );
  for (const [hop, call] of calls.entries()) {
    const text = replyText(call);
    if (text.startsWith(BLOCKED_PREFIX)) {
      const requested = typeof call.body.url === 'string' ? call.body.url : '';
      blockedJumps.push(docsPath(requested));
      continue;
    }
    const landed = text.match(OPENED_PATTERN)?.[1];
    if (landed) visits.push({ hop, path: docsPath(landed), text });
  }
  return { visits, blockedJumps };
}

export function reachRubric(task: string): string {
  return stripIndent`
    The input is a Supabase docs page that an agent opened while working on
    the task below. Pass only if this page answers the task: a developer
    could complete the task by following this page. A page that only links
    to the answer, or covers a different product feature, fails.

    Task:
    ${task}
  `;
}

export function groundedRubric(task: string): string {
  return stripIndent`
    The input is a Supabase docs page an agent reached while working on the
    task below, followed by the agent's final answer. Pass only if the page
    answers the task and the answer uses what the page says. Judge substance,
    not wording. An answer that contradicts the page, leaves out what the task
    needs, or says to look something up, fails.

    Task:
    ${task}
  `;
}

async function checkGrounded(
  reached: Visit | undefined,
  agentReport: string | undefined,
  task: string,
  judge: Judge
): Promise<CheckResult> {
  if (!reached)
    return { name: GROUNDED_CHECK, passed: false, notes: 'No page reached.' };
  const verdict = await judge({
    input: `Page:\n${reached.text}\n\nAnswer:\n${agentReport ?? ''}`,
    rubric: groundedRubric(task),
  });
  return {
    name: GROUNDED_CHECK,
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

async function judgeReach(
  visits: Visit[],
  task: string,
  judge: Judge
): Promise<Visit | undefined> {
  const judgedPaths = new Set<string>();
  for (const visit of visits) {
    if (visit.hop >= MAX_HOPS) return undefined;
    if (visit.path === 'docs' || judgedPaths.has(visit.path)) continue;
    judgedPaths.add(visit.path);
    const verdict = await judge({
      input: visit.text,
      rubric: reachRubric(task),
    });
    if (verdict.passed) return visit;
  }
  return undefined;
}

export async function scoreDocsNav(
  ctx: Pick<ToolEvalContext, 'toolCalls' | 'agentReport' | 'judge'>,
  { targets, task }: { targets: string[]; task: string }
): Promise<ScoreResult> {
  const { visits, blockedJumps } = readCalls(ctx.toolCalls);
  const matched = visits.find((visit) => targets.includes(visit.path));
  const reached = matched ?? (await judgeReach(visits, task, ctx.judge));
  const hopsToTarget = reached?.hop ?? null;
  const navigation: Navigation = {
    reached: hopsToTarget !== null && hopsToTarget < MAX_HOPS,
    hopsToTarget,
    reachedTarget: reached?.path ?? null,
    direct: isDirect(visits, reached),
    judged: !matched && reached !== undefined,
    opened: visits.map((visit) => visit.path),
    blockedJumps,
  };
  const reachedCheck: CheckResult = {
    name: REACHED_TARGET_CHECK,
    passed: navigation.reached,
    notes: JSON.stringify(navigation),
  };
  const groundedCheck = await checkGrounded(
    reached,
    ctx.agentReport,
    task,
    ctx.judge
  );
  return { passed: reachedCheck.passed, checks: [reachedCheck, groundedCheck] };
}
