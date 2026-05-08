import type { ProjectScorer } from "@supabase-evals/core";

const scorer: ProjectScorer = async (ctx) => {
  const { build, vitest } = ctx.projectResult;

  if (!build.ok) {
    return {
      passed: false,
      score: 0,
      notes: `vite build failed:\n${trimOutput(build.stderr || build.stdout)}`,
    };
  }

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
