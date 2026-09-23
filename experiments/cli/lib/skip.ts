import type { EvalMetadata } from '@supabase-evals/core';

/** Runs only evals that exercise the real CLI (never hosted-linked ones, which seed .temp pins instead). */
export function skipUnlessCli(ev: {
  id: string;
  metadata: EvalMetadata;
}): boolean {
  return ev.metadata.interface !== 'cli' || ev.metadata.hostedProject === true;
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
