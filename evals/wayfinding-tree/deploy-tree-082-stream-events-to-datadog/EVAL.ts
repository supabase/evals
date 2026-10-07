import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/observability/log-drains'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
