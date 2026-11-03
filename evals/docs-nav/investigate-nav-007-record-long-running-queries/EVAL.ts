import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/observability/log-slow-queries'];

export const CONTROL_TARGETS = ['guides/database/postgres/postgres-log-config'];

export default docsNavScorer(TARGETS, import.meta.url, CONTROL_TARGETS);
