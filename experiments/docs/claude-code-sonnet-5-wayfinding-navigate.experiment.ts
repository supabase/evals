import { wayfindingExperiment } from './lib/wayfinding.js';

// Docs wayfinding by navigation alone. Without this instruction the agent
// skips navigation and types deep urls it remembers, which measures the
// model's memory of the docs, not their information architecture.
export default wayfindingExperiment({
  search: false,
  promptSuffix:
    'Start at https://supabase.com/docs and reach other pages only by following links that appear on pages you have already opened. Do not type or guess a docs URL, and do not use any search.',
});
