import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/integrations/vercel-preview-branches'];

export default docsNavScorer(TARGETS, import.meta.url);
