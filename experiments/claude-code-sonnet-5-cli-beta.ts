import { cliVersionArm } from './lib/cli-version-matrix.js';

/**
 * Nightly arm of the CLI version matrix: the CLI's beta channel, resolved by
 * the eval-refresh workflow (latest supabase/cli prerelease) and passed in as
 * SUPABASE_CLI_BETA_VERSION. In the `regression` experiment suite so the
 * nightly cron runs it alongside `claude-code-sonnet-5` (the repository pin);
 * the workflow then publishes a pin-vs-beta delta table as the run summary.
 *
 * When SUPABASE_CLI_BETA_VERSION is unset (local runs, PR-labeled runs), the
 * arm skips every eval rather than falling back to the pin — a silent
 * fallback would duplicate the baseline and produce an empty delta.
 */
export default cliVersionArm({
  cliVersion: process.env.SUPABASE_CLI_BETA_VERSION,
  suite: ['regression'],
});
