import {
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { claudeCodeOpus55 } from '../presets.js';

// Pins the supabase/mcp#546 merge commit on main, which adds get_issues.
// Drop the pin once a published MCP release includes it.
export default defineExperiment({
  ...claudeCodeOpus55,
  runtime: platformLiteRuntime({
    mcpServers: [
      supabaseMcpServer({
        revision: '01f8021f4978ba71c978286ce4943a8dcfbdb5ff',
      }),
    ],
  }),
  skipEval: (ev) => ev.id !== 'investigate-database-001-large-advisor-backlog',
});
