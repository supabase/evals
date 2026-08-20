import { SUPABASE_CLI_VERSION } from '@supabase-evals/sandbox';
import { cliVersionArm } from './lib/cli-version-matrix.js';

/**
 * Baseline arm of the CLI version matrix: the repository's pinned CLI version,
 * made explicit so this file and `claude-code-sonnet-5-cli-beta` differ only
 * in `localStackRuntime({ cliVersion })`. In the `regression` experiment suite
 * so the nightly cron runs both arms and publishes a pin-vs-beta delta table
 * (see eval-refresh.yml). For a manual A/B, resolve a beta version yourself:
 *
 *   SUPABASE_CLI_BETA_VERSION=2.115.1-beta.6 pnpm eval -- \
 *     --suite regression --runs 2 \
 *     --experiment claude-code-sonnet-5-cli-pin \
 *     --experiment claude-code-sonnet-5-cli-beta
 *
 * Then compare the two arms' results:
 *
 *   pnpm compare-results -- \
 *     --baseline results/claude-code-sonnet-5-cli-pin \
 *     --candidate results/claude-code-sonnet-5-cli-beta
 */
export default cliVersionArm({
  cliVersion: SUPABASE_CLI_VERSION,
  suite: ['regression'],
});
