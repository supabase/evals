import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/deployment/branching/integrations',
  'guides/integrations/vercel-preview-branches',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
