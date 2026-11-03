import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/database/postgres/testing-row-level-security'];

export default docsNavScorer(TARGETS, import.meta.url);
