import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/graphql/configuration'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
