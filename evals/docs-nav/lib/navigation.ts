import type {
  CheckResult,
  ScoreResult,
  ToolCallRecord,
  ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK =
  'reached a target page within the nav tree depth';
export const GROUNDED_CHECK = 'answer is grounded in the reached page';

const NAVIGATOR_TOOL = 'open_page';
const OPENED_PATTERN = /Opened: (https:\/\/[^\s"\\]+)/;
const BLOCKED_PREFIX = 'Not opened:';
const VARIANT_PARAM = 'docs-ia-mvp-v1';

export interface NavTreeNode {
  label: string;
  route?: string;
  children?: NavTreeNode[];
}

export interface NavTree {
  name: string;
  root: NavTreeNode;
}

export type FetchTree = (url: string) => Promise<NavTree>;

export interface Navigation {
  group: string | null;
  variant: string | null;
  reached: boolean;
  maxHops: number | null;
  hopsToTarget: number | null;
  reachedTarget: string | null;
  wrongTurns: string[];
  noWrongTurns: boolean;
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

function routePath(route: string): string {
  return route.split('#')[0].replace(/^\/+|\/+$/g, '');
}

function treeDepth(node: NavTreeNode): number {
  const children = node.children ?? [];
  if (children.length === 0) return 0;
  return 1 + Math.max(...children.map((child) => treeDepth(child)));
}

function trailsTo(
  node: NavTreeNode,
  page: string,
  trail: string[] = []
): string[][] {
  const here = node.route ? [...trail, routePath(node.route)] : trail;
  const found = node.route && routePath(node.route) === page ? [here] : [];
  return [
    ...found,
    ...(node.children ?? []).flatMap((child) => trailsTo(child, page, here)),
  ];
}

function onTrackPages(tree: NavTree, pages: string[]): Set<string> {
  const trails = pages.flatMap((page) => [
    [page],
    ...trailsTo(tree.root, page),
  ]);
  return new Set(['docs', ...trails.flat()]);
}

function treeUrl(opened: string): string {
  const url = new URL(opened);
  const variant = url.searchParams.get(VARIANT_PARAM);
  const tree = new URL('/docs/nav-tree.json', url.origin);
  if (variant) tree.searchParams.set(VARIANT_PARAM, variant);
  return tree.toString();
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
  let firstOpened: string | undefined;
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
    if (!landed) continue;
    firstOpened ??= landed;
    visits.push({ hop, path: docsPath(landed), text });
  }
  return { visits, blockedJumps, firstOpened };
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
    task below, followed by the agent's final answer. Pass if the page answers
    the task and the answer's steps agree with the page. Judge substance, not
    wording. Details the page doesn't mention, and pointers to further reading,
    are fine. Fail only if the page doesn't answer the task, the answer
    contradicts the page, or the answer leaves out what the task needs.

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
  maxHops: number,
  task: string,
  judge: Judge
): Promise<Visit | undefined> {
  const judgedPaths = new Set<string>();
  for (const visit of visits) {
    if (visit.hop > maxHops) return undefined;
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
  {
    targets,
    controlTargets = [],
    group = null,
    task,
    fetchTree,
  }: {
    targets: string[];
    controlTargets?: string[];
    group?: string | null;
    task: string;
    fetchTree: FetchTree;
  }
): Promise<ScoreResult> {
  const { visits, blockedJumps, firstOpened } = readCalls(ctx.toolCalls);
  const variant = firstOpened
    ? new URL(firstOpened).searchParams.get(VARIANT_PARAM)
    : null;
  const tree = firstOpened ? await fetchTree(treeUrl(firstOpened)) : null;
  const maxHops = tree ? treeDepth(tree.root) : null;
  const armTargets = variant ? targets : [...targets, ...controlTargets];
  const matched = visits.find((visit) => armTargets.includes(visit.path));
  const reached =
    matched ??
    (maxHops === null
      ? undefined
      : await judgeReach(visits, maxHops, task, ctx.judge));
  const hopsToTarget = reached?.hop ?? null;
  const onTrack = tree
    ? onTrackPages(tree, [...armTargets, ...(reached ? [reached.path] : [])])
    : new Set<string>();
  const wrongTurns = visits
    .filter((visit) => !reached || visit.hop < reached.hop)
    .map((visit) => visit.path)
    .filter((path) => !onTrack.has(path));
  const isReached =
    hopsToTarget !== null && maxHops !== null && hopsToTarget <= maxHops;
  const navigation: Navigation = {
    group,
    variant,
    reached: isReached,
    maxHops,
    hopsToTarget,
    reachedTarget: reached?.path ?? null,
    wrongTurns,
    noWrongTurns: isReached && wrongTurns.length === 0,
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
