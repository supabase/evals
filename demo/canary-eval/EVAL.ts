import { type CheckResult, type ToolScorer } from '@supabase-evals/core'

// eval-workspace docs-discriminator demo: '@supabase/pinniped' is a fictional package
// planted ONLY in the local docs by scripts/ab-demo.sh. It cannot come from model
// priors or CLI scaffolding, so naming it proves the agent retrieved the answer
// from the local docs index — and removing it (the A/B baseline) proves the doc
// was the cause.
const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? ''
  const checks: CheckResult[] = [
    {
      name: 'named the docs-only package @supabase/pinniped',
      passed: /pinniped/i.test(report),
    },
  ]
  return { passed: checks[0].passed, checks }
}

export default scorer
