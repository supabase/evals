import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/security/soc-2-compliance'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
