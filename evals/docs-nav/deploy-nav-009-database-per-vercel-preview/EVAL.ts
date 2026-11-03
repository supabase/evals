import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/integrations/vercel-preview-branches'];

export const CONTROL_TARGETS = ['guides/deployment/branching/integrations'];

export default docsNavScorer(TARGETS, import.meta.url, CONTROL_TARGETS);
