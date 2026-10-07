import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/deployment/branching/integrations'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
