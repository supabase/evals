import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/resources/glossary'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
