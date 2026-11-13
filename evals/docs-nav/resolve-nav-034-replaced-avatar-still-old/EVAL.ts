import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/storage/cdn/smart-cdn',
  'guides/storage/cdn/purge-cdn-cache',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
