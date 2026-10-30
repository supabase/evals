import type { ToolScorer } from '@supabase-evals/core';
import { scoreTasks } from '../tasks.js';

const scorer: ToolScorer = ({ client }) => scoreTasks(client);
export default scorer;
