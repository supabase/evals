import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/security/rotate-leaked-api-keys'];

export const CONTROL_TARGETS = ['guides/getting-started/api-keys'];

export default docsNavScorer(TARGETS, import.meta.url, CONTROL_TARGETS);
