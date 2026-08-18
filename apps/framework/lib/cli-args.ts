import {
  evalSuiteSchema,
  experimentSuiteSchema,
  type EvalSuite,
  type ExperimentSuite,
} from '@supabase-evals/core/eval-metadata';
import { z } from 'zod';

const positiveIntegerSchema = z.coerce.number().int().min(1);

/** Parses a positive integer CLI option. */
export function positiveInteger(value: string, name: string): number {
  const parsed = positiveIntegerSchema.safeParse(value);
  if (!parsed.success) throw new Error(`--${name} must be a positive integer`);
  return parsed.data;
}

export interface CliArgsDefinition {
  booleanFlags: readonly string[];
  valueFlags: readonly string[];
  positionals?: readonly string[];
  usage: string;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const above = previous[rightIndex + 1] ?? 0;
      const next =
        left[leftIndex] === right[rightIndex]
          ? diagonal
          : 1 + Math.min(diagonal, above, previous[rightIndex] ?? 0);
      diagonal = above;
      previous[rightIndex + 1] = next;
    }
  }

  return previous[right.length] ?? left.length;
}

function suggestion(
  token: string,
  flags: readonly string[]
): string | undefined {
  const closest = flags
    .map((flag) => ({
      flag: `--${flag}`,
      distance: editDistance(token, `--${flag}`),
    }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (!closest || closest.distance > 3) return undefined;
  return closest.flag;
}

/** Rejects tokens that are not part of a command's declared CLI surface. */
export function validateCliArgs(
  rawArgs: readonly string[],
  definition: CliArgsDefinition
): void {
  const positionals = new Set(definition.positionals ?? []);
  const knownFlags = [...definition.booleanFlags, ...definition.valueFlags];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token || token === '--') continue;

    if (!token.startsWith('--')) {
      if (positionals.delete(token)) continue;
      throw new Error(`unexpected argument: ${token}\n\n${definition.usage}`);
    }

    const equalsIndex = token.indexOf('=');
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (definition.booleanFlags.includes(name) && equalsIndex === -1) continue;
    if (definition.valueFlags.includes(name)) {
      const value = rawArgs[index + 1];
      if (equalsIndex === -1 && value && !value.startsWith('--')) index += 1;
      continue;
    }

    const hint = suggestion(
      token.slice(0, equalsIndex === -1 ? undefined : equalsIndex),
      knownFlags
    );
    throw new Error(
      `unknown argument: ${token}${hint ? `\nDid you mean ${hint}?` : ''}\n\n${definition.usage}`
    );
  }
}

/** Reads one CLI flag in either `--name value` or `--name=value` form. */
export function readFlag(rawArgs: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefix));
  if (inline) {
    const value = inline.slice(prefix.length);
    if (!value) throw new Error(`--${name} requires a value`);
    return value;
  }
  const index = rawArgs.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

export function splitList(value: string): string[] {
  return value
    .split(',')
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
      if (!value || value.startsWith('--')) {
        throw new Error(`--${name} requires a value`);
      }
      values.push(...splitList(value));
      index += 1;
    }
  }

  return values;
}

export function normalizeExperimentName(value: string): string {
  return value.replace(/^experiments\//, '').replace(/\.ts$/, '');
}

export function readSuiteFilters(rawArgs: string[]): EvalSuite[] {
  return readRepeatedFlag(rawArgs, 'suite').map((value) => {
    const parsed = evalSuiteSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
      throw new Error(
        `invalid suite "${value}". Expected one of: ${evalSuiteSchema.options.join(', ')}`
      );
    }
    return parsed.data;
  });
}

export function readExperimentSuiteFilters(
  rawArgs: string[]
): ExperimentSuite[] {
  return readRepeatedFlag(rawArgs, 'experiment-suite').map((value) => {
    const parsed = experimentSuiteSchema.safeParse(value.trim().toLowerCase());
    if (!parsed.success) {
      throw new Error(
        `invalid experiment-suite "${value}". Expected one of: ${experimentSuiteSchema.options.join(', ')}`
      );
    }
    return parsed.data;
  });
}
