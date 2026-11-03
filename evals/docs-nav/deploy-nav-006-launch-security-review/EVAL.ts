import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/security/production-checklist'];

export default docsNavScorer(TARGETS, import.meta.url);
