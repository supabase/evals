import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/auth/enterprise-sso/auth-sso-saml'];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
