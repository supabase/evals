import type {
  CheckResult,
  ToolCallRecord,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import {
  type DocsTree,
  indexTree,
  isWithin,
  loadTree,
  routePage,
} from '../../../experiments/docs/lib/docs-tree.js';
import { type Severity, severityOf } from '../../docs-wayfinding/lib/wayfinding.js';

export const FOUND_CHECK = 'chose a target page in under 10 clicks';

// The tree navigator's tools and replies, from
// experiments/docs/lib/tree-navigator.mjs.
const OPEN_TOOL = 'open_section';
const CHOOSE_TOOL = 'choose_page';
const OPENED_PATTERN = /^Opened: \[([\w.]+)\]/m;
const CHOSEN_PATTERN = /^Chosen: \[([\w.]+)\]/m;
const TREE_PATTERN = /^Tree: (\S+)/m;
const ROOT = 'root';

/** The standard tree test outcomes. A skip is a run that chose nothing. */
export type Outcome =
  | 'direct success'
  | 'indirect success'
  | 'direct failure'
  | 'indirect failure'
  | 'skip';

export interface TreeTestRun {
  tree: string | null;
  /** The chosen page's trail of labels, and its page. */
  chosen: { id: string; trail: string; page: string | null } | null;
  /** Chose a target page, or an alternate. */
  success: boolean;
  viaAlternate: boolean;
  /** Never went back up or across the tree. */
  direct: boolean;
  outcome: Outcome;
  /** The first section opened from the top, and whether it leads to a target. */
  firstClick: { trail: string; correct: boolean } | null;
  /**
   * Sections opened after the top, reopened ones included. Choosing the page
   * isn't counted, the way the navigate eval counts opening the target.
   */
  pathLength: number;
  /** Opens that went back up or across the tree instead of down. */
  backtracks: number;
  /** A target was listed in a section the agent opened. */
  sawTarget: boolean;
  /** Labels the agent opened, in order. */
  opened: string[];
  /** Moves the navigator refused, such as opening a page. */
  refused: number;
  severity: Severity;
}

function replyText(call: ToolCallRecord): string {
  const { result } = call;
  if (typeof result === 'string') return `${call.error ?? ''}${result}`;
  if (Array.isArray(result))
    return `${call.error ?? ''}${result
      .map((part) =>
        typeof part === 'object' && part && 'text' in part
          ? String(part.text)
          : ''
      )
      .join('\n')}`;
  return `${call.error ?? ''}${JSON.stringify(result ?? '')}`;
}

const isChildOf = (id: string, parent: string) =>
  parent === ROOT
    ? !id.includes('.')
    : id.startsWith(`${parent}.`) && !id.slice(parent.length + 1).includes('.');

/** Scores one tree test from the agent's navigator calls. */
export function scoreTreeTest(
  toolCalls: ToolCallRecord[],
  targets: string[],
  alternates: string[] = [],
  loadTreeByName: (name: string) => DocsTree = loadTree
): TreeTestRun {
  const moves: { tool: string; id: string; text: string }[] = toolCalls
    .filter(
      (call) =>
        call.tool.toolName === OPEN_TOOL || call.tool.toolName === CHOOSE_TOOL
    )
    .map((call) => ({
      tool: call.tool.toolName,
      id: String(call.body.id ?? '').trim(),
      text: replyText(call),
    }));

  const treeName =
    moves.map((move) => move.text.match(TREE_PATTERN)?.[1]).find(Boolean) ??
    null;
  const nodes = treeName ? indexTree(loadTreeByName(treeName)) : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wantedPages = new Set([...targets, ...alternates]);
  const wantedIds = nodes
    .filter((node) => node.page && wantedPages.has(node.page))
    .map((node) => node.id);

  const opened: string[] = [];
  let refused = 0;
  let current: string | null = null;
  let pathLength = 0;
  let backtracks = 0;
  let firstClickId: string | null = null;
  let chosenId: string | null = null;
  let sawTarget = false;

  for (const move of moves) {
    if (move.tool === OPEN_TOOL) {
      const id = move.text.match(OPENED_PATTERN)?.[1];
      if (!id) {
        refused++;
        continue;
      }
      const node = byId.get(id);
      opened.push(node?.trail.join(' › ') || 'top');
      if (
        node?.children?.some((_, index) =>
          wantedIds.includes(
            id === ROOT ? `${index + 1}` : `${id}.${index + 1}`
          )
        )
      )
        sawTarget = true;
      if (id !== ROOT || current !== null) {
        if (current === null || !isChildOf(id, current)) backtracks++;
        pathLength++;
        if (id !== ROOT && firstClickId === null) firstClickId = id;
      }
      current = id;
    } else {
      const id = move.text.match(CHOSEN_PATTERN)?.[1];
      if (!id) {
        refused++;
        continue;
      }
      chosenId = id;
      if (firstClickId === null) firstClickId = id;
      // Choosing a page from a section other than the last one opened, or
      // the section itself, is going back.
      if (current !== null && current !== id && !isChildOf(id, current))
        backtracks++;
      break;
    }
  }

  const chosenNode = chosenId ? byId.get(chosenId) : undefined;
  const chosenPage =
    chosenNode?.page ??
    (chosenId
      ? routeFromReply(moves.find((move) => move.tool === CHOOSE_TOOL)?.text)
      : null);
  const success = chosenPage !== null && wantedPages.has(chosenPage);
  const direct = backtracks === 0;
  const outcome: Outcome =
    chosenId === null
      ? 'skip'
      : `${direct ? 'direct' : 'indirect'} ${success ? 'success' : 'failure'}`;
  const firstClickNode = firstClickId ? byId.get(firstClickId) : undefined;

  return {
    tree: treeName,
    chosen: chosenId
      ? {
          id: chosenId,
          trail: chosenNode?.trail.join(' › ') ?? '',
          page: chosenPage,
        }
      : null,
    success,
    viaAlternate:
      success && chosenPage !== null && !targets.includes(chosenPage),
    direct,
    outcome,
    firstClick: firstClickId
      ? {
          trail: firstClickNode?.trail.join(' › ') ?? firstClickId,
          correct: wantedIds.some((id) => isWithin(id, firstClickId)),
        }
      : null,
    pathLength,
    backtracks,
    sawTarget,
    opened,
    refused,
    severity: success ? severityOf(pathLength) : 'big failure',
  };
}

function routeFromReply(text: string | undefined): string | null {
  const route = text?.match(/^Route: (\S+)/m)?.[1];
  return route ? routePage(route) : null;
}

/**
 * Passes when the agent chose a target page, or an alternate that answers the
 * task as well, in under 10 clicks. The notes carry the full run.
 */
export function checkFoundTarget(
  ctx: Pick<ToolEvalContext, 'toolCalls'>,
  targets: string[],
  alternates: string[] = []
): CheckResult {
  const run = scoreTreeTest(ctx.toolCalls, targets, alternates);
  return {
    name: FOUND_CHECK,
    passed: run.severity !== 'big failure',
    notes: JSON.stringify(run),
  };
}

/** A scorer for a tree test task with one check: found the target. */
export function treeTestScorer(
  targets: string[],
  alternates: string[] = []
): ToolScorer {
  return async (ctx) => {
    const checks = [checkFoundTarget(ctx, targets, alternates)];
    return { passed: checks.every((check) => check.passed), checks };
  };
}
