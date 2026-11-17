import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'placement';

export const TARGETS = ['guides/api/query-plans'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
