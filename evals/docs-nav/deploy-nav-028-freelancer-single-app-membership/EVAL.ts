import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/platform/access-control'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
