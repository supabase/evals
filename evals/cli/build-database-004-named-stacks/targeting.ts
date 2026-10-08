import { formatDetourJudgeInput } from '../lib/detours.js';
import { maskUrlCredentials, urlPort, type StackProbe } from '../lib/stack.js';
import { STACK_NAMES, type NamedStacks } from './stacks.js';

function describeTarget(stackName: string, stack: StackProbe): string {
  if (!stack.ok) return `- ${stackName} stack: not resolved (${stack.notes})`;
  return `- ${stackName} stack: database ${maskUrlCredentials(stack.dbUrl)} (port ${urlPort(stack.dbUrl) ?? 'unknown'})`;
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
    ...STACK_NAMES.map((stackName) =>
      describeTarget(stackName, stacks[stackName])
    ),
    '',
    'Executed commands, in order:',
    formatDetourJudgeInput(commands),
  ].join('\n');
}
