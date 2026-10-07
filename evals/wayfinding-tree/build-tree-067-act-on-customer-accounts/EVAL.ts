import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/integrations/build-a-supabase-oauth-integration',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
