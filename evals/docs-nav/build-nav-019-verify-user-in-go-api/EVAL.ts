import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/auth/jwts', 'guides/auth/signing-keys'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
