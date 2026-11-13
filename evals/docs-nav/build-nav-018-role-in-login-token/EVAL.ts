import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/auth/auth-hooks/custom-access-token-hook',
  'guides/api/custom-claims-and-role-based-access-control-rbac',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
