import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/realtime/subscribing-to-database-changes',
  'guides/realtime/broadcast',
  'guides/realtime/getting_started',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
