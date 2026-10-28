import { loadExperimentMetadata } from '../lib/result-files.js';
import { missingBenchmarkRationales } from '../../web/src/lib/experiment-rationales.js';

const missing = missingBenchmarkRationales(await loadExperimentMetadata());
if (missing.length) {
  throw new Error(`Missing benchmark rationales: ${missing.join(', ')}`);
}
