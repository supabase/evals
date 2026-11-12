import { appendFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const originalFetch = globalThis.fetch;
const apiHost = new URL(process.env.SPARK_API_URL).hostname;
const suffix = apiHost.slice(apiHost.indexOf('.'));

// Private timing receipts cover provisioning, fixture, SQL, and Data API reads.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== apiHost && !url.hostname.endsWith(suffix)) {
    return originalFetch(input, init);
  }
  const start = performance.now();
  let status = 0;
  let failed = false;
  try {
    const response = await originalFetch(input, init);
    status = response.status;
    if (url.pathname === '/v1/projects' && init?.method === 'POST' && response.ok) {
      writeFileSync('/tmp/warp-eval-project.json', JSON.stringify(await response.clone().json()), { mode: 0o600 });
    }
    return response;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    appendFileSync('/tmp/warp-eval-timing.jsonl', JSON.stringify({
      path: url.pathname,
      elapsed_ms: Math.round(performance.now() - start),
      status,
      failed,
    }) + '\n', { mode: 0o600 });
  }
};
