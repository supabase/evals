import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'hard-to-reach';

export const TARGETS = ['guides/functions/schedule-functions'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
