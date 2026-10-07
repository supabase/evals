import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/observability/reports'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
