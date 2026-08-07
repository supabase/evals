import { readBody } from 'nitro/h3';
import { start } from 'workflow/api';

import { runEvalWorkflow, type EvalWorkItem } from '../workflows/run-eval.js';

export default async (event: Parameters<typeof readBody>[0]) => {
  const item: unknown = await readBody(event);
  if (!isEvalWorkItem(item)) {
    return Response.json(
      {
        error:
          'body must contain valid experiment, evalId, and optional ref strings',
      },
      { status: 400 }
    );
  }

  const run = await start(runEvalWorkflow, [item]);
  const environment =
    process.env.VERCEL_ENV === 'production' ? 'production' : 'preview';
  const dashboardUrl = `https://vercel.com/supabase/evals-runner/workflows/runs/${run.runId}?environment=${environment}`;
  return Response.json({ runId: run.runId, dashboardUrl });
};

/** Accepts the path-safe identifiers used by the eval runner. */
function isEvalWorkItem(value: unknown): value is EvalWorkItem {
  if (!value || typeof value !== 'object') return false;
  if (!('experiment' in value) || typeof value.experiment !== 'string') {
    return false;
  }
  if (!('evalId' in value) || typeof value.evalId !== 'string') return false;
  if (
    'ref' in value &&
    (typeof value.ref !== 'string' || !isGitRef(value.ref))
  ) {
    return false;
  }

  return isIdentifier(value.experiment) && isIdentifier(value.evalId);
}

/** Rejects path separators and shell-like input in eval identifiers. */
function isIdentifier(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}

/** Accepts a branch, tag, or commit SHA without Git's ambiguous `..` syntax. */
function isGitRef(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('/')
  );
}
