import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/ai/rag-with-permissions'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
