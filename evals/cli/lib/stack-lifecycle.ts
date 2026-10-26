import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from './cli-invocations.js';

export type StackLifecycle = {
  lastCommand: string | null;
  stoppedByAgent: boolean;
};

const STACK_START_COMMANDS = new Set([
  'start',
  'stack start',
  'stack restart',
  'db start',
]);
const STACK_STOP_COMMANDS = new Set(['stop', 'stack stop', 'stack destroy']);

function lifecycleCommand(invocation: SupabaseInvocation): string | undefined {
  const verb = invocationVerb(invocation);
  if (verb === undefined) return undefined;
  const command =
    verb === 'db' ? `db ${invocationSubcommand(invocation)}` : verb;
  return STACK_START_COMMANDS.has(command) || STACK_STOP_COMMANDS.has(command)
    ? command
    : undefined;
}

/** The last stack start or stop invocation the agent ran, flags included, and whether it left the stack stopped. */
export function readStackLifecycle(
  invocations: readonly SupabaseInvocation[]
): StackLifecycle {
  const last = invocations
    .flatMap((invocation) => {
      const command = lifecycleCommand(invocation);
      return command === undefined ? [] : [{ command, argv: invocation.argv }];
    })
    .at(-1);
  return last === undefined
    ? { lastCommand: null, stoppedByAgent: false }
    : {
        lastCommand: last.argv.join(' '),
        stoppedByAgent: STACK_STOP_COMMANDS.has(last.command),
      };
}
