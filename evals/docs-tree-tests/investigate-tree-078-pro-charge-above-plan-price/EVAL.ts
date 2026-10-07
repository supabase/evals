import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/platform/your-monthly-invoice'];
export const ALTERNATES = [
  'guides/platform/billing-faq',
  'guides/platform/manage-your-usage/compute',
];

export default treeTestScorer(TARGETS, ALTERNATES);
