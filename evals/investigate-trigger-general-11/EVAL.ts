import { createSkillTriggerScorer } from '@supabase-evals/core';

// ponytail: closed skill set inlined so this eval dir is self-contained and
// does not import the trigger data files at runtime. Canonical list lives in
// evals/trigger/golden.ts (TRIGGER_SKILLS).
const TRIGGER_SKILLS = [
  'supabase',
  'supabase-postgres-best-practices',
] as const;

export default createSkillTriggerScorer(['supabase'], TRIGGER_SKILLS);
