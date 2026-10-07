import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = [
  'guides/database/replication/pipelines/bigquery',
  'guides/database/replication/pipelines',
];
export const ALTERNATES: string[] = [];

export default treeTestScorer(TARGETS, ALTERNATES);
