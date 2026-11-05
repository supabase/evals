import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/self-hosting/updating'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
