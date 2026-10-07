import { treeTestScorer } from '../lib/tree-test.js';

export const TARGETS = ['guides/getting-started/quickstarts/reactjs'];
export const ALTERNATES = ['guides/getting-started/tutorials/with-react'];

export default treeTestScorer(TARGETS, ALTERNATES);
