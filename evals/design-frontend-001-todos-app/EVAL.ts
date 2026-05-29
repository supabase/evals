import type { ProjectScorer } from "@supabase-evals/core";

const scorer: ProjectScorer = async (ctx) => {
  const { build, vitest } = ctx.projectResult;

  if (!build.ok) {
    return {
      passed: false,
      checks: [
        {
          type: "deterministic",
          name: "vite build passed",
          passed: false,
          notes: trimOutput(build.stderr || build.stdout),
        },
      ],
    };
  }

  if (!vitest) {
    return {
      passed: false,
      checks: [{ type: "deterministic", name: "vitest ran", passed: false }],
    };
  }

  return {
    passed: vitest.ok,
    checks: [
      { type: "deterministic", name: "vite build passed", passed: true },
      {
        type: "deterministic",
        name: "vitest passed",
        passed: vitest.ok,
        notes: vitest.ok
          ? undefined
          : (vitest.failures?.length ? vitest.failures : [vitest.stderr || vitest.stdout])
              .map(trimOutput)
              .join("\n"),
      },
    ],
  };
};

function trimOutput(output: string) {
  return output.trim().slice(0, 4000);
}

export default scorer;
