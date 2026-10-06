import { wayfindingExperiment } from './lib/wayfinding.js';

// Scratch: the docs preview for supabase/supabase#51373.
export default wayfindingExperiment({
  proposedLinks: false,
  docsOrigin:
    'https://docs-git-docs-nav-render-collapsed-links-supabase.vercel.app',
});
