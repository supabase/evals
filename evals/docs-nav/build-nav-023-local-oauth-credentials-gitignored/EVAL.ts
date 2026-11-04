import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/local-development/managing-config'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
