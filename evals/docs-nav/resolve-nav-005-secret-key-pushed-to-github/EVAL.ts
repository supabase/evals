import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/security/rotate-leaked-api-keys'];

export default docsNavScorer(TARGETS, import.meta.url);
