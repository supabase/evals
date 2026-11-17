import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/database/postgres/event-triggers'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
