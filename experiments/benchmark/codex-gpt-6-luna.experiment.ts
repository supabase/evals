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
      supabaseMcpServer({ revision: 'mattrossman/ai-1477-mcp-source-canary' }),
    ],
  }),
});
