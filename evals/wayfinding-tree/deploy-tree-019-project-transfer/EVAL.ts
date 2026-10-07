import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/project-transfer'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
