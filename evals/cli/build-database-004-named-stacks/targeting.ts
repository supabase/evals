import { formatDetourJudgeInput } from '../lib/detours.js';
import { maskUrlCredentials, urlPort } from '../lib/stack.js';
import { STACK_NAMES, type NamedStack, type NamedStacks } from './stacks.js';

function describeCliHome(stack: NamedStack & { ok: true }): string {
  if (stack.relocatedHome !== undefined) {
    return `relocated CLI home ${stack.relocatedHome}`;
  }
  return stack.cliHome === undefined
    ? 'the default CLI home'
    : `the default CLI home ${stack.cliHome}`;
}

function describeTarget(stackName: string, stack: NamedStack): string[] {
  if (!stack.ok) return [`- ${stackName} stack: not resolved (${stack.notes})`];
  return [
    `- ${stackName} stack: database ${maskUrlCredentials(stack.dbUrl)} (port ${urlPort(stack.dbUrl) ?? 'unknown'})`,
    `  found under ${describeCliHome(stack)}`,
  ];
}

/** Harness facts naming each stack's database, then every executed command numbered in full. */
export function formatTargetingJudgeInput(
  workspace: string,
  stacks: NamedStacks,
  commands: readonly string[]
): string {
  return [
    'Harness facts:',
    `- project directory: ${workspace}`,
    ...STACK_NAMES.flatMap((stackName) =>
      describeTarget(stackName, stacks[stackName])
    ),
    '',
    'Executed commands, in order:',
    formatDetourJudgeInput(commands),
  ].join('\n');
}
