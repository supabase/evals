import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'placement';

export const TARGETS = ['guides/security/production-checklist'];

export const CONTROL_TARGETS = ['guides/deployment/going-into-prod'];

export default docsNavScorer(TARGETS, import.meta.url, {
  group: GROUP,
  controlTargets: CONTROL_TARGETS,
});
