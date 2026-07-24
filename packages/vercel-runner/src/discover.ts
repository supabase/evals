/**
 * Eval/experiment pair discovery — a TypeScript port of the `prepare` job in
 * .github/workflows/eval-refresh.yml, so the Vercel Sandbox dispatcher fans
 * out over exactly the same matrix the GitHub Actions workflow would.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EvalPair {
  evalId: string;
  experiment: string;
  experimentSuite: string;
  evalSuite: string;
}

export interface DiscoverOptions {
  /** Repo root (contains evals/ and experiments/). */
  root: string;
  /** Explicit eval ids; when set, suite filtering of evals is skipped. */
  evalIds?: string[];
  /** Eval suites to include when no explicit ids are given. */
  suites: string[];
  /** Experiment suites to include. */
  experimentSuites: string[];
  /** Explicit experiment names; when set, per-suite discovery is skipped. */
  experiments?: string[];
}

/**
 * Map an eval suite to the experiment suites it runs under — the same
 * hardcoded pairing as the workflow (benchmark evals also run the no-skills
 * ablation; regression evals run regression experiments only).
 */
const EXPERIMENT_SUITES_BY_EVAL_SUITE: Record<string, string[]> = {
  benchmark: ["benchmark", "no-skills"],
  regression: ["regression"],
};

/** Read the `suite:` frontmatter value of an eval's PROMPT.md. */
function readEvalSuite(root: string, evalId: string): string | undefined {
  const promptPath = join(root, "evals", evalId, "PROMPT.md");
  if (!existsSync(promptPath)) return undefined;
  const match = readFileSync(promptPath, "utf8").match(/^suite:\s*(\S+)/m);
  return match?.[1];
}

/** `pnpm --silent eval -- list --experiment-suite <suite>` at the repo root. */
async function listExperiments(root: string, suite: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["--silent", "eval", "--", "list", "--experiment-suite", suite],
    { cwd: root },
  );
  return JSON.parse(stdout) as string[];
}

export async function discoverPairs(
  options: DiscoverOptions,
): Promise<EvalPair[]> {
  const { root } = options;

  let evalIds: string[];
  if (options.evalIds && options.evalIds.length > 0) {
    const missing = options.evalIds.filter(
      (id) => !existsSync(join(root, "evals", id)),
    );
    if (missing.length > 0) {
      throw new Error(`no eval directory for: ${missing.join(", ")}`);
    }
    evalIds = options.evalIds;
  } else {
    evalIds = readdirSync(join(root, "evals")).filter((id) => {
      const suite = readEvalSuite(root, id);
      return suite !== undefined && options.suites.includes(suite);
    });
  }

  // Fully explicit selection (both --eval and --experiment): pair directly.
  // The suite mapping below exists to mirror the scheduled/dispatch matrix; it
  // would silently drop evals outside the benchmark/regression suites, which
  // is wrong when the caller has already named exactly what to run.
  if (
    options.evalIds &&
    options.evalIds.length > 0 &&
    options.experiments &&
    options.experiments.length > 0
  ) {
    return evalIds.flatMap((evalId) =>
      options.experiments!.map((experiment) => ({
        evalId,
        experiment,
        experimentSuite: "",
        evalSuite: readEvalSuite(root, evalId) ?? "",
      })),
    );
  }

  const experimentsBySuite = new Map<string, string[]>();
  const pairs: EvalPair[] = [];
  for (const evalId of evalIds) {
    const evalSuite = readEvalSuite(root, evalId);
    if (!evalSuite) continue;
    const candidateSuites = EXPERIMENT_SUITES_BY_EVAL_SUITE[evalSuite] ?? [];

    for (const experimentSuite of candidateSuites) {
      if (!options.experimentSuites.includes(experimentSuite)) continue;

      let experiments: string[];
      if (options.experiments && options.experiments.length > 0) {
        experiments = options.experiments;
      } else {
        if (!experimentsBySuite.has(experimentSuite)) {
          experimentsBySuite.set(
            experimentSuite,
            await listExperiments(root, experimentSuite),
          );
        }
        experiments = experimentsBySuite.get(experimentSuite)!;
      }

      for (const experiment of experiments) {
        pairs.push({ evalId, experiment, experimentSuite, evalSuite });
      }
    }
  }
  return pairs;
}
