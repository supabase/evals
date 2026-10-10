import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: 'app' database has a cache hit ratio of ~72% (blks_hit=2600000,
// blks_read=1000000). Healthy threshold is ~99%. Most reads are going to disk.
// Fix: increase shared_buffers or effective_cache_size, or upgrade compute tier.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedLowHit =
    /cache.{0,20}hit|blks_hit|buffer.{0,20}(hit|cache)/i.test(report);
  const identifiedRatio =
    /7[0-9](\.[0-9]+)?%|0\.7[0-9]/.test(report);
  const proposedFix =
    /shared_buffers|effective_cache_size|compute|memory|upgrade|pg_prewarm/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified low buffer cache hit ratio', passed: identifiedLowHit },
    { name: 'cited the approximate ratio (~72%)', passed: identifiedRatio },
    { name: 'proposed increasing memory or cache-related fix', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that the 'app' database has a buffer cache hit ratio of
         approximately 72% (computed from blks_hit and blks_read), which is far
         below the ~99% healthy threshold and indicates excessive disk I/O.
      2. Proposed increasing shared_buffers, effective_cache_size, or upgrading
         to a compute tier with more RAM to reduce disk reads.

      Fail if the agent did not compute or cite the hit ratio, confused blks_hit
      with blks_read, or gave no memory/tuning recommendation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed low cache hit ratio and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
