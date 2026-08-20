import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
  type ExperimentConfig,
} from '@supabase-evals/core';
import type { ExperimentSuite } from '@supabase-evals/core/eval-metadata';
import { localStackRuntime } from '@supabase-evals/sandbox';

/**
 * A CLI-version arm of the version matrix: the `claude-code-sonnet-5`
 * configuration run without skills, with exactly one variable across arms —
 * the Supabase CLI version installed into the local-stack sandbox.
 *
 * Arms run `skills: []` (CLI-2221): the matrix measures raw CLI capability,
 * and a skill can paper over (or trip on) a CLI change. A with-skills version
 * pair can be added later if the no-skills signal proves out.
 *
 * Arms exist to compare agent capability across CLI versions (see
 * `pnpm compare-results`), so they only run evals where the version under
 * test can matter:
 *
 * - Evals that pin `cliVersion` in frontmatter are skipped: the frontmatter
 *   pin overrides the experiment's version (see localStackRuntime), so the
 *   arm's version would silently not apply.
 * - Evals with `skipCliInstall` are skipped: the agent installs its own CLI
 *   there, so the arm's version is never installed at all (and there is no
 *   pre-run version probe to record).
 * - Evals whose `interface` isn't `cli` are skipped: they never touch the CLI
 *   under test, so running them would duplicate the base experiment's results
 *   at full cost. (This also drops the few local-stack evals that boot a
 *   sandbox via `local/` alone without `interface: cli` — acceptable for the
 *   version-matrix MVP.)
 *
 * `cliVersion: undefined` disables the arm entirely (every eval is skipped):
 * the nightly beta arm resolves its version from the environment, and a
 * missing version must never fall back to the repository pin — that would
 * silently turn the arm into a duplicate of the baseline.
 *
 * Note the arms run at the repository's `REMOTE_VERSION_FILES` service
 * versions, which track the pinned CLI — a non-pin arm may log a spurious
 * "different service versions" warning on linked commands. Known noise,
 * accepted for the MVP.
 */
export function cliVersionArm(options: {
  cliVersion: string | undefined;
  suite?: ExperimentSuite[];
}): ExperimentConfig {
  const { cliVersion, suite } = options;
  return defineExperiment({
    suite,
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
    }),
    runtime: platformLiteRuntime({
      mcpServers: [supabaseMcpServer()],
    }),
    localStack: localStackRuntime({ cliVersion }),
    skills: [],
    skipEval: (ev) =>
      cliVersion === undefined ||
      ev.metadata.cliVersion !== undefined ||
      ev.metadata.skipCliInstall === true ||
      ev.metadata.interface !== 'cli',
  });
}
