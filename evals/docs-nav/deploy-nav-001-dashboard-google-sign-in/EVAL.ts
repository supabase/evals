import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'hard-to-reach';

export const TARGETS = ['guides/platform/sso', 'guides/platform/sso/gsuite'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
