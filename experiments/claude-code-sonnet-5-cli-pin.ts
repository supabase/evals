import { SUPABASE_CLI_VERSION } from '@supabase-evals/sandbox';
import { cliVersionArm } from './lib/cli-version-matrix.js';

/**
 * Baseline arm of the CLI version matrix: the repository's pinned CLI version,
 * made explicit so this file and `claude-code-sonnet-5-cli-stable` differ only
 * in `localStackRuntime({ cliVersion })`. No experiment suite — run manually:
 *
 *   pnpm eval -- --suite regression --runs 2 \
 *     --experiment claude-code-sonnet-5-cli-pin \
 *     --experiment claude-code-sonnet-5-cli-stable
 *
 * Then compare the two arms' results:
 *
 *   pnpm compare-results -- \
 *     --baseline results/claude-code-sonnet-5-cli-pin \
 *     --candidate results/claude-code-sonnet-5-cli-stable
 */
export default cliVersionArm({ cliVersion: SUPABASE_CLI_VERSION });
