import { docsNavScorer } from '../lib/navigation.js';

export const GROUP = 'placement';

export const TARGETS = ['guides/observability/log-slow-queries'];

export const CONTROL_TARGETS = ['guides/database/postgres/postgres-log-config'];

export default docsNavScorer(TARGETS, import.meta.url, {
  group: GROUP,
  controlTargets: CONTROL_TARGETS,
});
