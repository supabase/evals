import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'placement';

export const TARGETS = ['guides/platform/team-database-access'];

export const CONTROL_TARGETS = ['guides/platform/temporary-access'];

export default docsNavScorer(TARGETS, import.meta.url, {
  group: GROUP,
  controlTargets: CONTROL_TARGETS,
});
