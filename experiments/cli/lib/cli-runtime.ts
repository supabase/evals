import type { LocalStackRuntime } from '@supabase-evals/core';
import {
  localStackRuntime,
  type LocalStackRuntimeOptions,
} from '@supabase-evals/sandbox';

const EXPERIMENTAL_ENV = {
  // Global gate: storage, network-bans, ...
  SUPABASE_EXPERIMENTAL: 'true',
} as const;

const EXPERIMENTAL_STACK_ENV = {
  ...EXPERIMENTAL_ENV,
  SUPABASE_EXPERIMENTAL_STACK: '1',
} as const;

export type CliRuntimeOptions = LocalStackRuntimeOptions & {
  /** Turn on the Supabase CLI's experimental gates in the sandbox. */
  experimental?: boolean;
};

/** A local-stack runtime for CLI evals; `experimental` turns on every CLI experimental gate the session can use. */
export function cliRuntime({
  experimental,
  ...options
}: CliRuntimeOptions): LocalStackRuntime {
  if (!experimental) return localStackRuntime(options);
  const withEnv = (env: Record<string, string>) =>
    localStackRuntime({ ...options, env: { ...options.env, ...env } });
  const managedStack = withEnv(EXPERIMENTAL_STACK_ENV);
  // The managed stack can't read a stack the harness already started (`supabase status` fails), so only evals where the agent starts it get it.
  const harnessStack = withEnv(EXPERIMENTAL_ENV);
  return {
    ...managedStack,
    id: `${managedStack.id}-experimental`,
    startSession: (args) =>
      (args.projectRunning === false
        ? managedStack
        : harnessStack
      ).startSession(args),
  };
}
