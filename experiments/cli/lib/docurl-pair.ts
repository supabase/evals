import { defineExperiment, type ExperimentConfig } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import type { ExperimentPreset } from '../../presets.js';
import { EVAL_ENV } from './eval-env.js';
import { skipUnlessDocUrlAb } from './skip.js';

/** The CLI for the "off" arm: no `error.docUrl` in the error output. */
export const DOCURL_OFF_VERSION = '3.5.0-beta.6';
/** Move ON to the first CLI release that contains supabase/cli#7749. */
export const DOCURL_ON_VERSION = '3.5.0-beta.6';

/** One arm of the docUrl A/B: the preset's agent on `cliVersion`, running only the docUrl evals. */
export function docUrlExperiment(
  preset: ExperimentPreset,
  cliVersion: string
): ExperimentConfig {
  return defineExperiment({
    ...preset,
    localStack: localStackRuntime({ cliVersion, env: EVAL_ENV }),
    skipEval: skipUnlessDocUrlAb,
  });
}
