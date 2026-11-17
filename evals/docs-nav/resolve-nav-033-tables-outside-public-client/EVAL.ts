import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = ['guides/api/using-custom-schemas'];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
