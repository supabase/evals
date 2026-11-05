import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/platform/free-project-pausing'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
