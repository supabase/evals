import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/database/postgres/testing-row-level-security'];

export const CONTROL_TARGETS = ['guides/local-development/testing/overview'];

export default docsNavScorer(TARGETS, import.meta.url, CONTROL_TARGETS);
