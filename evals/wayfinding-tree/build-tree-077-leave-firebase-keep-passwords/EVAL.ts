import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/migrating-to-supabase/firebase-auth'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
