import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/ai-tools/ai-prompts'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
