import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6LunaNoSkills } from '../presets.js';

export default defineExperiment({ ...codexGpt6LunaNoSkills });
