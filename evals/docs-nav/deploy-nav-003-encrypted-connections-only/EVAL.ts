import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/platform/ssl-enforcement'];

export default docsNavScorer(TARGETS, import.meta.url);
