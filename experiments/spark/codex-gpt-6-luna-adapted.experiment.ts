import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineExperiment } from '@supabase-evals/core';
import { hostedDataRuntime, hostedCliRuntime } from '@supabase-evals/sandbox';
import spark from './codex-gpt-6-luna.experiment.js';

const app = hostedDataRuntime();
const cli = hostedCliRuntime();

export default defineExperiment({
  ...spark,
  localStack: {
    id: 'spark-hosted',
    startSession(args) {
      const runtime =
        args.localDir && existsSync(join(args.localDir, 'supabase'))
          ? cli
          : app;
      return runtime.startSession(args);
    },
  },
  skipEval: (ev) => !ev.id.endsWith('-spark'),
});
