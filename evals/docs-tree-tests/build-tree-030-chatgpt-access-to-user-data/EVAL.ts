import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/ai-tools/byo-mcp'];
export const ALTERNATES = ['guides/auth/oauth-server/mcp-authentication'];

export default treeTestScorer(TARGETS, ALTERNATES);
