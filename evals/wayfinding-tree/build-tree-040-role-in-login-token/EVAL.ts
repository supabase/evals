import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/auth/auth-hooks/custom-access-token-hook',
  'guides/api/custom-claims-and-role-based-access-control-rbac',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
