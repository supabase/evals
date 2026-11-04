import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'placement';

export const TARGETS = [
  'guides/integrations/vercel-preview-branches',
  'guides/deployment/branching/github-integration',
];

export const CONTROL_TARGETS = ['guides/deployment/branching/integrations'];

export default docsNavScorer(TARGETS, import.meta.url, {
  group: GROUP,
  controlTargets: CONTROL_TARGETS,
});
