import { docsNavScorer } from '../lib/navigation.js';

export const TARGETS = ['guides/platform/network-restrictions'];

export default docsNavScorer(TARGETS, import.meta.url);
