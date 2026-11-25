import {
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { claudeCodeOpus55 } from '../presets.js';

// Pins the supabase/mcp#546 head, which adds get_issues. Drop the pin once
// a published MCP release includes it.
export default defineExperiment({
  ...claudeCodeOpus55,
  runtime: platformLiteRuntime({
    mcpServers: [
      supabaseMcpServer({
        revision: 'a0137116ef03998cb00dc3ac9b18b698fea5234b',
      }),
    ],
  }),
  skipEval: (ev) => ev.id !== 'investigate-database-001-large-advisor-backlog',
});
