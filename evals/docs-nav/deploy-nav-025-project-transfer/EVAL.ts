import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/platform/project-transfer'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
