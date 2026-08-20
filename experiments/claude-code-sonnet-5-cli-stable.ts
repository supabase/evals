import { cliVersionArm } from './lib/cli-version-matrix.js';

/**
 * Candidate arm of the CLI version matrix: the latest stable CLI release at
 * the time of writing (bump when running a new comparison — this is a manual
 * snapshot arm, not a moving target). Differs from
 * `claude-code-sonnet-5-cli-pin` only in `localStackRuntime({ cliVersion })`.
 * See that file for the run + compare commands.
 */
export default cliVersionArm({ cliVersion: '2.115.0' });
