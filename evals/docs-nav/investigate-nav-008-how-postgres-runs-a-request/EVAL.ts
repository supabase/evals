import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/api/query-plans'];

export default docsNavScorer(TARGETS, import.meta.url);
