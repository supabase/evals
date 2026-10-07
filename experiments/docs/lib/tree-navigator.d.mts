import type { DocsTree, TreeNode } from './docs-tree.js';

export const ROOT: string;
export const OPENED_PREFIX: string;
export const CHOSEN_PREFIX: string;
export const REFUSED_PREFIX: string;
export const OPEN_TOOL: string;
export const CHOOSE_TOOL: string;
export const PROMPT_ADDENDUM: string;

export function encodeTree(tree: DocsTree): string;
export function decodeTree(encoded: string): { name: string; root: TreeNode };
export function nodeAt(
  tree: { root: TreeNode },
  id: string
): { node: TreeNode; trail: string[] } | null;

export type TreeMove = { isError?: boolean; text: string };
export function createTreeSession(tree: { name: string; root: TreeNode }): {
  open(id: unknown): TreeMove;
  choose(id: unknown): TreeMove;
};
