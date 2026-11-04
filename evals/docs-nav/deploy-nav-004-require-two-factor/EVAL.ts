import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'hard-to-reach';

export const TARGETS = ['guides/platform/mfa/org-mfa-enforcement'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
