import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/observability/log-slow-queries'];

export default docsNavScorer(TARGETS, import.meta.url);
