import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/database/connecting-to-postgres/serverless-drivers',
  'guides/database/connecting-to-postgres',
  'guides/database/connecting-to-postgres/pooling-and-limits',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
