import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/storage/uploads/resumable-uploads'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
