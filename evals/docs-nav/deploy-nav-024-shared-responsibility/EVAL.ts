import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/deployment/shared-responsibility-model',
  'guides/platform/backups',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
