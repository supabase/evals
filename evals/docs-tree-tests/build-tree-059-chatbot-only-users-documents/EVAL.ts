import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/ai/rag-with-permissions'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
