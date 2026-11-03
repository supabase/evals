import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/platform/free-project-pausing'];

export default docsNavScorer(TARGETS, import.meta.url);
