import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/platform/hipaa-projects',
  'guides/security/hipaa-compliance',
];
export const ALTERNATES = ['guides/deployment/shared-responsibility-model'];

export default treeTestScorer(TARGETS, ALTERNATES);
