import {
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  ...codexGpt6Luna,
  runtime: platformLiteRuntime({
    mcpServers: [
      supabaseMcpServer({
        revision: 'a0137116ef03998cb00dc3ac9b18b698fea5234b',
      }),
    ],
  }),
  skipEval: (ev) => ev.id !== 'investigate-database-004-issues-coverage',
});
