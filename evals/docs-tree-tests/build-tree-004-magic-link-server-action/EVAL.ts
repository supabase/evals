import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/auth/auth-email-passwordless',
  'guides/auth/server-side/creating-a-client',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
