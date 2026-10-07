import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/sso', 'guides/platform/sso/gsuite'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
