import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/platform/upgrading'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
