import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/database/postgres/event-triggers'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
