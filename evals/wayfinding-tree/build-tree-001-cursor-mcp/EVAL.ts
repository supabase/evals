import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/ai-tools/mcp'];
export const ALTERNATES = ['guides/ai-tools/plugins'];

export default treeTestScorer(TARGETS, ALTERNATES);
