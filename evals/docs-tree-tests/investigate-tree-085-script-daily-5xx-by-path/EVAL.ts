import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/observability/advanced-log-filtering'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
