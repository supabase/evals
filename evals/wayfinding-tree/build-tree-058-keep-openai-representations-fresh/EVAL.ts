import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/ai/automatic-embeddings'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
