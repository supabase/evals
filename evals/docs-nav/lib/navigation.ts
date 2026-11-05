import { readFileSync } from 'node:fs';
import type {
  CheckResult,
  ScoreResult,
  ToolCallRecord,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { stripIndent } from 'common-tags';

export const REACHED_TARGET_CHECK =
  'reached a target page within the nav tree depth';
export const GROUNDED_CHECK = 'answer is grounded in the reached page';

const NAVIGATOR_TOOL = 'open_page';
const OPENED_PATTERN = /Opened: (https:\/\/[^\s"\\]+)/;
const BLOCKED_PREFIX = 'Not opened:';
const VARIANT_PARAM = 'docs-ia-mvp-v1';
const TREE_OPEN_TOOL = 'open_section';
const TREE_CHOOSE_TOOL = 'choose_page';
const TREE_ROOT = 'root';
const TREE_REFUSED_PREFIX = 'Not allowed:';
const TREE_LINE = /^Tree: (\S+)$/m;

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
  chosen?: string | null;
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

function treeNodeAt(tree: NavTree, id: string): NavTreeNode | undefined {
  if (id === TREE_ROOT) return tree.root;
  let node: NavTreeNode | undefined = tree.root;
  for (const part of id.split('.')) {
    node = node?.children?.[Number(part) - 1];
  }
  return node;
}

function treeIdsOf(
  node: NavTreeNode,
  pages: string[],
  id = TREE_ROOT
): string[] {
  const here = node.route && pages.includes(routePath(node.route)) ? [id] : [];
  return [
    ...here,
    ...(node.children ?? []).flatMap((child, index) =>
      treeIdsOf(
        child,
        pages,
        id === TREE_ROOT ? `${index + 1}` : `${id}.${index + 1}`
      )
    ),
  ];
}

function treePrefixes(id: string): string[] {
  const parts = id.split('.');
  return parts.map((_, index) => parts.slice(0, index + 1).join('.'));
}

function isTreeDescendant(id: string, parent: string): boolean {
  if (parent === TREE_ROOT) return id !== TREE_ROOT;
  return id.startsWith(`${parent}.`);
}

function isTreeCall(call: ToolCallRecord): boolean {
  return [TREE_OPEN_TOOL, TREE_CHOOSE_TOOL].includes(call.tool.toolName);
}

async function scoreTreeRun(
  toolCalls: ToolCallRecord[],
  {
    targets,
    controlTargets,
    group,
    fetchTree,
  }: {
    targets: string[];
    controlTargets: string[];
    group: string | null;
    fetchTree: FetchTree;
  }
): Promise<ScoreResult> {
  const calls = toolCalls
    .filter((call) => isTreeCall(call))
    .map((call) => ({ call, text: replyText(call) }));
  const url = calls
    .map(({ text }) => text.match(TREE_LINE)?.[1])
    .find((match) => match !== undefined);
  const tree = url ? await fetchTree(url) : null;
  const variant = url ? new URL(url).searchParams.get(VARIANT_PARAM) : null;
  const maxHops = tree ? treeDepth(tree.root) : null;
  const armTargets = variant ? targets : [...targets, ...controlTargets];
  const onPath = new Set([
    TREE_ROOT,
    ...(tree ? treeIdsOf(tree.root, armTargets) : []).flatMap((id) =>
      treePrefixes(id)
    ),
  ]);
  const label = (id: string) =>
    `${id} ${(tree && treeNodeAt(tree, id)?.label) ?? ''}`.trim();
  const opened: string[] = [];
  const wrongTurns: string[] = [];
  const blockedJumps: string[] = [];
  let clicks = 0;
  let current: string | null = null;
  let chosen: string | null = null;
  for (const { call, text } of calls) {
    const id = String(call.body.id ?? '').trim();
    const refused = text.startsWith(TREE_REFUSED_PREFIX);
    if (call.tool.toolName === TREE_CHOOSE_TOOL) {
      if (!refused && chosen === null) chosen = id;
      continue;
    }
    if (chosen !== null) continue;
    if (id !== TREE_ROOT) clicks += 1;
    if (refused) {
      blockedJumps.push(id);
      continue;
    }
    opened.push(label(id));
    const isStart = current === null && id === TREE_ROOT;
    if (!isStart && (!onPath.has(id) || !isTreeDescendant(id, current ?? ''))) {
      wrongTurns.push(label(id));
    }
    current = id;
  }
  const chosenRoute = chosen && tree ? treeNodeAt(tree, chosen)?.route : null;
  const chosenPath = chosenRoute ? routePath(chosenRoute) : null;
  const matched = chosenPath !== null && armTargets.includes(chosenPath);
  const isReached = matched && maxHops !== null && clicks <= maxHops;
  const navigation: Navigation = {
    group,
    variant,
    reached: isReached,
    maxHops,
    hopsToTarget: matched ? clicks : null,
    reachedTarget: matched ? chosenPath : null,
    wrongTurns,
    noWrongTurns: isReached && wrongTurns.length === 0,
    judged: false,
    opened,
    blockedJumps,
    chosen: chosenPath,
  };
  const reachedCheck: CheckResult = {
    name: REACHED_TARGET_CHECK,
    passed: navigation.reached,
    notes: JSON.stringify(navigation),
  };
  return { passed: reachedCheck.passed, checks: [reachedCheck] };
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
  if (ctx.toolCalls.some((call) => isTreeCall(call))) {
    return scoreTreeRun(ctx.toolCalls, {
      targets,
      controlTargets,
      group,
      fetchTree,
    });
  }
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

async function fetchNavTree(url: string): Promise<NavTree> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Couldn't load the nav tree from ${url}: HTTP ${res.status}`
    );
  }
  return (await res.json()) as NavTree;
}

export function docsNavScorer(
  targets: string[],
  evalUrl: string,
  { group, controlTargets = [] }: { group: string; controlTargets?: string[] }
): ToolScorer {
  const promptUrl = new URL('./PROMPT.md', evalUrl);
  const { body: task } = parseEvalMarkdown(
    readFileSync(promptUrl, 'utf8'),
    promptUrl.pathname
  );
  return (ctx) =>
    scoreDocsNav(ctx, {
      targets,
      controlTargets,
      group,
      task,
      fetchTree: (url) => fetchNavTree(url),
    });
}
