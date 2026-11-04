import {
  defineExperiment,
  bootSparkBackend,
  sparkRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

const apiUrl = process.env.SPARK_API_URL ?? '';

export default defineExperiment({
  ...codexGpt6Luna,
  skipEval: (ev) => ev.id.endsWith('-spark'),
  localStack: {
    ...codexGpt6Luna.localStack,
    async startSession(args) {
      if (!args.hosted)
        throw new Error(
          'Spark backend cannot run this local-stack scenario unchanged: it targets local Postgres, not a hosted project'
        );
      return codexGpt6Luna.localStack.startSession(args);
    },
  },
  hostedBackend: (args) => bootSparkBackend(apiUrl, args),
  runtime: sparkRuntime({
    apiUrl,
    mcpServers: [supabaseMcpServer()],
  }),
});
