import type {
  CheckResult,
  ProjectScorer,
  VitestResult,
} from "@supabase-evals/core";

const scorer: ProjectScorer = async (ctx) => {
  const { build, vitest } = ctx.projectResult;

  const checks: CheckResult[] = [
    {
      type: "deterministic",
      name: "vite build passed",
      passed: build.ok,
      notes: build.ok ? undefined : trimOutput(build.stderr || build.stdout),
    },
    {
      type: "deterministic",
      name: "vitest passed",
      passed: build.ok && vitest?.ok === true,
      notes: getVitestNotes(build.ok, vitest),
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

function getVitestNotes(buildPassed: boolean, vitest?: VitestResult) {
  if (!buildPassed) {
    return "not run because vite build failed";
  }
  if (!vitest) {
    return "vitest did not run";
  }
  if (vitest.ok) {
    return undefined;
  }

  const failures = vitest.failures?.length
    ? vitest.failures
    : [vitest.stderr || vitest.stdout];
  return failures.map(trimOutput).join("\n");
}

function trimOutput(output: string) {
  return output.trim().slice(0, 4000);
}

export default scorer;
