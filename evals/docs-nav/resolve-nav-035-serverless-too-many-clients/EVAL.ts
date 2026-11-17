import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/database/connecting-to-postgres/serverless-drivers',
  'guides/database/connecting-to-postgres',
  'guides/database/connecting-to-postgres/pooling-and-limits',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
