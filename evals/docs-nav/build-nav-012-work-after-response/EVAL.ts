import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/functions/background-tasks'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
