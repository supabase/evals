import type { ToolCallRecord } from '@supabase-evals/core';

import {
  findSupabaseInvocations,
  invocationSubcommand,
  invocationVerb,
} from '../../cli/lib/cli-invocations.js';
import {
  commandToolCalls,
  extractCommandEntries,
} from '../../cli/lib/detours.js';

export const REPORT_EVAL_PREFIX = 'build-docs-report-';
export const GUIDE_PATH = '/docs/guides/auth/server-side/creating-a-client.md';
export const FEEDBACK_PATH = '/docs/guides/ai-tools/agent-feedback.md';

// a substring match, because the docs mirror is on a random host port and not on supabase.com
export const touchedPath = ({
  toolCalls,
  path,
}: {
  toolCalls: ToolCallRecord[];
  path: string;
}): boolean =>
  toolCalls.some((call) =>
    [call.command, call.url, call.path].some((value) => value?.includes(path))
  );

// any send before the user agrees fails the eval
export const feedbackSends = (
  toolCalls: ToolCallRecord[]
): ToolCallRecord[] => {
  const calls = commandToolCalls(toolCalls);
  const cliSends = new Set(
    findSupabaseInvocations(extractCommandEntries(toolCalls))
      .filter(
        (inv) =>
          invocationVerb(inv) === 'feedback' &&
          invocationSubcommand(inv) === 'add'
      )
      .map((inv) => calls[inv.commandIndex])
  );
  return toolCalls.filter(
    (call) => call.tool.toolName === 'submit_feedback' || cliSends.has(call)
  );
};
