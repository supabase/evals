import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/api/using-custom-schemas'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
