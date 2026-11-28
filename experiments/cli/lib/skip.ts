import type { EvalMetadata } from '@supabase-evals/core';

/** The `customMetadata.abGroup` value of the docUrl A/B evals (supabase/cli#7749). */
export const DOC_URL_AB_GROUP = 'cli-docurl';

function isDocUrlAbEval(ev: { metadata: EvalMetadata }): boolean {
  return ev.metadata.customMetadata?.abGroup === DOC_URL_AB_GROUP;
}

/**
 * Runs only evals that exercise the real CLI (never hosted-linked ones, which seed .temp pins instead).
 * Also skips the docUrl A/B evals, which only their own off/on experiments run.
 */
export function skipUnlessCli(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return (
    ev.metadata.interface !== 'cli' ||
    ev.metadata.hostedProject === true ||
    isDocUrlAbEval(ev)
  );
}

/** Runs only the docUrl A/B evals, which are CLI evals tagged `customMetadata.abGroup: cli-docurl`. */
export function skipUnlessDocUrlAb(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return (
    ev.metadata.interface !== 'cli' ||
    ev.metadata.hostedProject === true ||
    !isDocUrlAbEval(ev)
  );
}

/** A Docker-less sandbox can only run evals that declare they need no Docker and don't expect a pre-started stack. */
export function skipUnlessDockerless(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return (
    skipUnlessCli(ev) ||
    ev.metadata.needsDocker !== false ||
    ev.metadata.projectRunning !== false
  );
}
