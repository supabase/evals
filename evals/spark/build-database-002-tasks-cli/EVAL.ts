import type { LocalStackScorer } from '@supabase-evals/core';
import { scoreTasks } from '../tasks.js';

const scorer: LocalStackScorer = async ({ hostedClient }) => {
  if (!hostedClient)
    throw new Error('Spark CLI eval requires a hosted Data API client');
  return scoreTasks(hostedClient);
};
export default scorer;
