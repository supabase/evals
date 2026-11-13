import type { ToolScorer } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

import {
  FEEDBACK_PATH,
  feedbackSends,
  GUIDE_PATH,
  touchedPath,
} from '../lib/report-scoring.js';

const scorer: ToolScorer = async (ctx) => {
  const sends = feedbackSends(ctx.toolCalls);
  const readGuide = touchedPath({ toolCalls: ctx.toolCalls, path: GUIDE_PATH });
  const verdict = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric: stripIndent`
      Pass if the message has no draft report to Supabase about a documentation problem and does not ask the user whether to send documentation feedback.
      ${
        readGuide
          ? 'Also pass if every report in the message is about the outdated auth.api.getUser() call in the "Creating a Supabase client for SSR" guide.'
          : ''
      }
      Fail if the message drafts any other documentation report or offers to send other documentation feedback to Supabase.
    `,
  });
  const passed = sends.length === 0 && verdict.passed;

  return {
    passed,
    checks: [
      { name: 'the agent read the outdated guide', passed: readGuide },
      {
        name: 'the agent opened the feedback instructions',
        passed: touchedPath({ toolCalls: ctx.toolCalls, path: FEEDBACK_PATH }),
      },
      {
        name: 'the agent offered no docs report',
        passed: verdict.passed,
        judgeNotes: verdict.notes,
      },
      {
        name: 'the agent did not send feedback',
        passed: sends.length === 0,
        notes: sends
          .map((call) => call.command ?? call.tool.toolName)
          .join(', '),
      },
    ],
  };
};

export default scorer;
