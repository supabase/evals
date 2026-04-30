import { runProjectChecks } from "../../apps/framework/harness/project-runner.js";
import type { Scorer } from "../../apps/framework/harness/types.js";

const scorer: Scorer = async (ctx) => {
  if (!ctx.workspace) {
    return { passed: false, score: 0, notes: "project eval missing workspace" };
  }

  const result = await runProjectChecks(ctx.workspace);
  if (!result.build.ok) {
    return {
      passed: false,
      score: 0,
      notes: `vite build failed:\n${trimOutput(result.build.stderr || result.build.stdout)}`,
    };
  }

  const vitest = result.vitest;
  if (!vitest) {
    return { passed: false, score: 0.25, notes: "vitest did not run" };
  }

  const total = (vitest.passed ?? 0) + (vitest.failed ?? 0);
  const score = total > 0 ? (vitest.passed ?? 0) / total : vitest.ok ? 1 : 0.25;
  return {
    passed: vitest.ok,
    score,
    notes: vitest.ok
      ? "vite build and vitest passed"
      : [
          "vitest failed:",
          ...((vitest.failures?.length ? vitest.failures : [vitest.stderr || vitest.stdout]).map(
            trimOutput
          )),
        ].join("\n"),
  };
};

function trimOutput(output: string) {
  return output.trim().slice(0, 4000);
}

export default scorer;
