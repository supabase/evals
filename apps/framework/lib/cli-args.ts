import {
  evalSuiteSchema,
  experimentSuiteSchema,
  type EvalSuite,
  type ExperimentSuite,
} from "@supabase-evals/core/eval-metadata";

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readRepeatedFlag(rawArgs: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `--${name}=`;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg) continue;

    if (arg.startsWith(prefix)) {
      values.push(...splitList(arg.slice(prefix.length)));
      continue;
    }

    if (arg === `--${name}`) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      values.push(...splitList(value));
      index += 1;
    }
  }

  return values;
}

export function normalizeExperimentName(value: string): string {
  return value.replace(/^experiments\//, "").replace(/\.ts$/, "");
}

export function readSuiteFilters(rawArgs: string[]): EvalSuite[] {
  return readRepeatedFlag(rawArgs, "suite").map((value) => {
    const parsed = evalSuiteSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
      throw new Error(
        `invalid suite "${value}". Expected one of: ${evalSuiteSchema.options.join(", ")}`,
      );
    }
    return parsed.data;
  });
}

export function readExperimentSuiteFilters(
  rawArgs: string[],
): ExperimentSuite[] {
  return readRepeatedFlag(rawArgs, "experiment-suite").map((value) => {
    const parsed = experimentSuiteSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
      throw new Error(
        `invalid experiment-suite "${value}". Expected one of: ${experimentSuiteSchema.options.join(", ")}`,
      );
    }
    return parsed.data;
  });
}
