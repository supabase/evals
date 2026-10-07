import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/getting-started/quickstarts/nextjs'];
export const ALTERNATES = [
  'guides/auth/quickstarts/nextjs',
  'guides/getting-started/tutorials/with-nextjs',
];

export default treeTestScorer(TARGETS, ALTERNATES);
