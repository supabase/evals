import { wayfindingExperiment } from './lib/wayfinding.js';

// Docs wayfinding without the docs search tool: the agent finds pages by
// browsing from the docs root, through llms.txt, navigation, and links.
export default wayfindingExperiment({ search: false });
