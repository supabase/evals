import { readBody } from 'nitro/h3';
import { start } from 'workflow/api';
import { z } from 'zod';

import { evalRunInputSchema } from '../schemas.js';
import { runEvalWorkflow } from '../workflows/run-eval.js';

export default async (event: Parameters<typeof readBody>[0]) => {
  const parsed = evalRunInputSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    return Response.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 }
    );
  }

  const run = await start(runEvalWorkflow, [parsed.data]);
  const environment =
    process.env.VERCEL_ENV === 'production' ? 'production' : 'preview';
  const dashboardUrl = `https://vercel.com/supabase/evals-runner/workflows/runs/${run.runId}?environment=${environment}`;
  return Response.json({ runId: run.runId, dashboardUrl });
};
