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
  hostedBackend: (args) => bootSparkBackend(apiUrl, args),
  runtime: sparkRuntime({
    apiUrl,
    mcpServers: [supabaseMcpServer()],
  }),
});
