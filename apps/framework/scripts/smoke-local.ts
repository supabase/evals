/**
 * Zero-cost smoke test for the local-dev runner (scripts/local.ts).
 *
 * Fakes the eval run via LOCAL_EVAL_CMD (no model spend, no docker) and
 * reads REAL published baselines from origin/main (no fetch: LOCAL_NO_FETCH).
 *
 *   pnpm --filter @supabase-evals/framework test:local
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const EXPERIMENT = 'claude-code-sonnet-5';

// a published, currently-existing eval id — resolved dynamically so the test
// doesn't rot when the published set changes
const published = JSON.parse(
  execFileSync(
    'git',
    ['show', 'origin/main:apps/web/src/data/regression-eval-results.json'],
    { cwd: ROOT, maxBuffer: 1 << 28 }
  ).toString()
) as Array<{ experiment: string; eval: string }>;
const EVAL = published.find(
  (r) => r.experiment === EXPERIMENT && existsSync(join(ROOT, 'evals', r.eval))
)?.eval;
assert.ok(EVAL, 'no published eval with a local evals/ dir found');

// LOCAL_EVAL_CMD contract: write a result JSON to $RES for eval $EVAL
const FAKE =
  process.platform === 'win32'
    ? `node -e "require('fs').mkdirSync(require('path').dirname(process.env.RES),{recursive:true});require('fs').writeFileSync(process.env.RES,JSON.stringify({eval:process.env.EVAL,experiment:'${EXPERIMENT}',passed:true,checks:[{name:'x',passed:true}]}))"`
    : `node -e 'require("fs").mkdirSync(require("path").dirname(process.env.RES),{recursive:true});require("fs").writeFileSync(process.env.RES,JSON.stringify({eval:process.env.EVAL,experiment:"${EXPERIMENT}",passed:true,checks:[{name:"x",passed:true}]}))'`;

function local(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', join(__dirname, 'local.ts'), ...args],
    {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        LOCAL_NO_FETCH: '1',
        LOCAL_EVAL_CMD: FAKE,
        FORCE_COLOR: '0',
        ...env,
      },
    }
  );
  return { out: `${res.stdout}\n${res.stderr}`, status: res.status };
}

let passed = 0;
function ck(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

// --- refusals happen pre-spend, with actionable messages ---
{
  const r = local(['compare', 'no-such-eval-xyz']);
  ck('unknown eval refused', () => {
    assert.equal(r.status, 1);
    assert.match(r.out, /no published result for no-such-eval-xyz/);
  });
}
{
  const r = local(['compare', EVAL, '--experiment', 'bogus-model']);
  ck('unknown experiment refused with the available list', () => {
    assert.equal(r.status, 1);
    assert.match(r.out, /unknown experiment: bogus-model/);
    assert.match(r.out, /claude-code-sonnet-5/);
  });
}
{
  const r = local(['run', 'not-an-eval-dir']);
  ck('missing eval dir refused', () => {
    assert.equal(r.status, 1);
    assert.match(r.out, /no eval at evals\/not-an-eval-dir/);
  });
}

// --- compare: delta table + receipts with published provenance ---
{
  const r = local(['compare', EVAL]);
  ck('compare prints both rows and the screen caveat', () => {
    assert.equal(r.status, 0);
    assert.match(r.out, new RegExp(`=== local compare: ${EVAL}`));
    assert.match(r.out, /published .*main@[0-9a-f]{7}/);
    assert.match(r.out, /treatment .*your world/);
    assert.match(r.out, /screen only:/);
  });
  ck('published receipt carries commit provenance', () => {
    const receipt = JSON.parse(
      readFileSync(
        join(ROOT, 'results-local', `${EVAL}.published.json`),
        'utf8'
      )
    );
    assert.match(receipt.publishedProvenance.commit, /^[0-9a-f]{40}$/);
    assert.match(receipt.publishedProvenance.parent, /^[0-9a-f]{40}$/);
  });
  ck('treatment receipt carries host provenance', () => {
    const receipt = JSON.parse(
      readFileSync(
        join(ROOT, 'results-local', `${EVAL}.treatment.json`),
        'utf8'
      )
    );
    assert.match(receipt.provenance.host.sha, /^[0-9a-f]{40}$/);
    assert.equal(typeof receipt.provenance.host.dirtyFiles, 'number');
  });
}

// --- run: no baseline required (custom evals), receipt only ---
{
  const r = local(['run', EVAL]);
  ck('run works without published baseline machinery', () => {
    assert.equal(r.status, 0);
    assert.match(r.out, new RegExp(`=== local run: ${EVAL}`));
    assert.doesNotMatch(r.out, /published /);
    assert.match(r.out, /saved: results-local\//);
  });
}

// --- mcp override path validation ---
{
  const r = local(['run', EVAL, '--mcp', '/definitely/not/a/path']);
  ck('bad --mcp path refused pre-spend', () => {
    assert.equal(r.status, 1);
    assert.match(r.out, /--mcp path does not exist/);
  });
}

// cleanup
rmSync(join(ROOT, 'results-local', `${EVAL}.published.json`), { force: true });
rmSync(join(ROOT, 'results-local', `${EVAL}.treatment.json`), { force: true });
rmSync(join(ROOT, 'results', EXPERIMENT, `${EVAL}.json`), { force: true });

console.log(`smoke-local: ${passed} checks passed`);
