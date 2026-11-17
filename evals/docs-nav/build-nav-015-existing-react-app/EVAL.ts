import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'set-aside';

export const TARGETS = [
  'guides/getting-started/quickstarts/reactjs',
  'guides/getting-started/tutorials/with-react',
];

export default docsNavScorer(TARGETS, import.meta.url, { group: GROUP });
