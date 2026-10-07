import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/getting-started/architecture'];
export const ALTERNATES = ['guides/self-hosting/docker'];

export default treeTestScorer(TARGETS, ALTERNATES);
