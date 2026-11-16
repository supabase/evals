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
        revision: 'b0724c9d37e9e74cddd8c79eaf93cdfac9b7523d',
      }),
    ],
  }),
});
