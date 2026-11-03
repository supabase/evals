import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/platform/team-database-access'];

export const CONTROL_TARGETS = ['guides/platform/temporary-access'];

export default docsNavScorer(TARGETS, import.meta.url, CONTROL_TARGETS);
