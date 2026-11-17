import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/database/webhooks',
  'guides/database/extensions/pg_net',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
