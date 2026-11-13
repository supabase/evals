import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/ai-tools/ai-prompts'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
