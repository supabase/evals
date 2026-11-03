import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/platform/team-database-access'];

export default docsNavScorer(TARGETS, import.meta.url);
