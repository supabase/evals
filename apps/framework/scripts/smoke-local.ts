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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_API_FLAG_MIN_VERSION,
  supportsContentApiFlag,
} from './mcp-capabilities.js';
import { parsePublishedLog, PUBLISHED_LOG_FORMAT } from './published-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
// every output lands in a disposable sandbox — never the checkout's real
// results/ or results-local/ (an in-flight manual run may own those)
const SANDBOX = mkdtempSync(join(tmpdir(), 'smoke-local-'));
const OUT = join(SANDBOX, 'results-local');
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

// LOCAL_EVAL_CMD contract: write a result JSON to $RES for eval $EVAL.
// A script file sidesteps per-platform shell quoting entirely.
const fakeScript = join(SANDBOX, 'fake-eval.cjs');
writeFileSync(
  fakeScript,
  `const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.dirname(process.env.RES), { recursive: true });
fs.writeFileSync(
  process.env.RES,
  JSON.stringify({
    eval: process.env.EVAL,
    experiment: '${EXPERIMENT}',
    passed: true,
    checks: [{ name: 'x', passed: true }],
  })
);
`
);
const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)}`;

function local(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', join(__dirname, 'local.ts'), ...args],
    {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 60_000, // a regressed pre-spend gate must never reach a real agent run
      env: {
        ...process.env,
        LOCAL_NO_FETCH: '1',
        LOCAL_RESULTS_ROOT: SANDBOX,
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

// --- content-api capability: version comparison, both sides of the boundary ---
// Driven directly because the pin it gates on is a constant in core, so an
// end-to-end check only ever exercises whichever side today's pin sits on.
{
  ck('versions below the flag release are not capable', () => {
    for (const v of ['0.8.1', '0.9.0', '0.9.9', '0.1.0'])
      assert.equal(supportsContentApiFlag(v), false, v);
  });
  ck('the flag release and newer are capable', () => {
    for (const v of [CONTENT_API_FLAG_MIN_VERSION, '0.10.1', '0.11.0', '1.0.0'])
      assert.equal(supportsContentApiFlag(v), true, v);
  });
  ck('no prerelease counts, however high its number', () => {
    // A version number orders releases; it does not prove what is in the tree.
    // A prerelease could be cut from a branch that forked before the flag, and
    // wrongly trusting one costs a paid run against production docs, so the
    // conservative answer is the right one on both sides of the minimum.
    for (const v of ['0.10.0-dev.1', '0.11.0-beta', '1.0.0-rc.1', '0.9.0-x'])
      assert.equal(supportsContentApiFlag(v), false, v);
  });
  ck('malformed versions throw instead of reporting a capability', () => {
    // The dangerous direction: `0.10.foo` parsed loosely reads as 0.10.0 and
    // would wave a paid run through against production docs.
    for (const v of ['0.10.foo', '0.10', '', 'latest', 'v0.10.0'])
      assert.throws(
        () => supportsContentApiFlag(v),
        /not a MAJOR\.MINOR\.PATCH version/,
        `expected a throw for ${JSON.stringify(v)}`
      );
  });
}

// --- published-log parsing: the merge-commit case origin/main cannot reach ---
// Built here rather than asserted against real history: main has no merge that
// touches a published export, so an end-to-end check would pass either way.
{
  const repo = join(SANDBOX, 'merge-parse-repo');
  const file = 'exports.json';
  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  mkdirSync(repo, { recursive: true });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'smoke@local']);
  g(['config', 'user.name', 'smoke']);
  const commitFile = (body: string, msg: string) => {
    writeFileSync(join(repo, file), body);
    g(['add', file]);
    g(['commit', '-qm', msg]);
  };
  commitFile('[{"eval":"base"}]\n', 'base');
  g(['checkout', '-q', '-b', 'side']);
  commitFile('[{"eval":"side"}]\n', 'side');
  g(['checkout', '-q', 'main']);
  commitFile('[{"eval":"main"}]\n', 'main edit');
  // Expected to conflict: we resolve to content differing from BOTH parents so
  // path-limited history simplification keeps this merge in `git log -- <file>`.
  // The conflict is the point, so assert a merge is genuinely in progress rather
  // than discarding the exit status and hoping.
  const merge = spawnSync('git', ['merge', 'side'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.notEqual(
    merge.status,
    0,
    `expected \`git merge side\` to conflict, got clean exit: ${merge.stdout}${merge.stderr}`
  );
  assert.ok(
    existsSync(join(repo, '.git', 'MERGE_HEAD')),
    'no MERGE_HEAD: the next commit would not be a merge commit'
  );
  commitFile('[{"eval":"merged"}]\n', 'merge side into main');

  const line = g(['log', 'main', '-1', PUBLISHED_LOG_FORMAT, '--', file]);

  ck('published log line for a merge commit really has 2 parents', () => {
    const [, parents] = line.split('\t');
    assert.equal(parents.split(' ').length, 2, `expected a merge: ${line}`);
  });

  ck('merge commit parses to the mainline parent and a real date', () => {
    const parsed = parsePublishedLog(line);
    assert.match(parsed.commit, /^[0-9a-f]{40}$/);
    assert.match(parsed.parent, /^[0-9a-f]{40}$/);
    assert.equal(parsed.parent, g(['rev-parse', 'main^1']));
    assert.ok(
      !Number.isNaN(Date.parse(parsed.committedAt)),
      `committedAt is not a date: ${parsed.committedAt}`
    );
  });

  ck('the old space-split is what this guards against', () => {
    // Reproduce the pre-fix parse to prove the regression is real: `%P` puts a
    // second sha where the timestamp belongs, and Date.parse yields NaN.
    const spaceSplit = g([
      'log',
      'main',
      '-1',
      '--format=%H %P %cI',
      '--',
      file,
    ]).split(' ');
    assert.equal(spaceSplit.length, 4);
    assert.ok(Number.isNaN(Date.parse(spaceSplit[2])));
  });

  ck('malformed published log lines are refused, not guessed', () => {
    assert.throws(() => parsePublishedLog('only-one-field'), /expected 3/);
    assert.throws(
      () => parsePublishedLog('nothex\tdead\t2026-01-01'),
      /not a sha/
    );
    assert.throws(
      () => parsePublishedLog(`${'a'.repeat(40)}\t${'b'.repeat(40)}\tnope`),
      /not a date/
    );
    assert.throws(
      () => parsePublishedLog(`${'a'.repeat(40)}\t\t2026-01-01T00:00:00Z`),
      /no parent/
    );
  });
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
      readFileSync(join(OUT, `${EVAL}.published.json`), 'utf8')
    );
    assert.match(receipt.publishedProvenance.commit, /^[0-9a-f]{40}$/);
    // Exactly ONE sha, and a real date: %P expands to every parent, so a
    // space-split of `%H %P %cI` puts a second parent where the timestamp
    // belongs on a merge commit (Date.parse -> NaN, "NaNd old" in the report).
    assert.match(receipt.publishedProvenance.parent, /^[0-9a-f]{40}$/);
    assert.ok(
      !Number.isNaN(Date.parse(receipt.publishedProvenance.committedAt)),
      `committedAt is not a date: ${receipt.publishedProvenance.committedAt}`
    );
  });
  ck('treatment receipt carries host provenance', () => {
    const receipt = JSON.parse(
      readFileSync(join(OUT, `${EVAL}.treatment.json`), 'utf8')
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

// --- mcp override: monorepo root resolves to the server package; unbuilt refused ---
{
  const fake = join(SANDBOX, '.smoke-mcp-checkout');
  const pkg = join(fake, 'packages', 'mcp-server-supabase');
  mkdirSync(join(pkg, 'dist', 'transports'), { recursive: true });

  const unbuilt = local(['run', EVAL, '--mcp', fake]);
  ck('unbuilt mcp checkout refused pre-spend with build hint', () => {
    assert.equal(unbuilt.status, 1);
    assert.match(unbuilt.out, /no built server at .*mcp-server-supabase/);
    assert.match(unbuilt.out, /pnpm install && pnpm build/);
  });

  writeFileSync(
    join(pkg, 'dist', 'transports', 'stdio.js'),
    '// smoke fixture\n'
  );
  const built = local(['run', EVAL, '--mcp', fake]);
  ck('monorepo root resolves to the server package dir', () => {
    assert.equal(built.status, 0);
    const receipt = JSON.parse(
      readFileSync(join(OUT, `${EVAL}.treatment.json`), 'utf8')
    );
    assert.match(
      receipt.provenance.mcpOverride.path,
      /packages[/\\]mcp-server-supabase$/
    );
  });

  // --- --content-api: refused unless a build that honours it is supplied ---
  const noMcp = local(['run', EVAL, '--content-api', 'http://127.0.0.1:3001']);
  ck('--content-api without --mcp refused pre-spend', () => {
    assert.equal(noMcp.status, 1);
    assert.match(noMcp.out, /--content-api needs --mcp/);
    assert.match(noMcp.out, /production docs/);
  });

  // the fixture above is a bare stub, i.e. a build predating supabase/mcp#343
  const staleBuild = local([
    'run',
    EVAL,
    '--content-api',
    'http://127.0.0.1:3001',
    '--mcp',
    fake,
  ]);
  ck('mcp build without the --content-api-url flag refused pre-spend', () => {
    assert.equal(staleBuild.status, 1);
    assert.match(staleBuild.out, /predates supabase\/mcp#343/);
  });

  // The discriminating case: a build carrying ONLY the env fallback, no flag.
  // We forward the URL as `--content-api-url` in the server's argv (the server
  // runs in-container and inherits no environment), so such a build would
  // ignore the override — probing for the env var name alone would wave it
  // through and buy a paid run against production docs.
  writeFileSync(
    join(pkg, 'dist', 'transports', 'stdio.js'),
    '// smoke fixture: env fallback only\nprocess.env.SUPABASE_CONTENT_API_URL\n'
  );
  const envOnly = local([
    'run',
    EVAL,
    '--content-api',
    'http://127.0.0.1:3001',
    '--mcp',
    fake,
  ]);
  ck('mcp build with only the env fallback refused pre-spend', () => {
    assert.equal(envOnly.status, 1);
    assert.match(envOnly.out, /no --content-api-url flag/);
  });

  // A post-#343 build: registers the flag and keeps the env fallback.
  writeFileSync(
    join(pkg, 'dist', 'transports', 'stdio.js'),
    "// smoke fixture: post-#343 build\n['content-api-url']:{type:'string'}\nprocess.env.SUPABASE_CONTENT_API_URL\n"
  );
  const honoured = local([
    'run',
    EVAL,
    '--content-api',
    'http://127.0.0.1:3001',
    '--mcp',
    fake,
  ]);
  ck('build with the --content-api-url flag is accepted and recorded', () => {
    assert.equal(honoured.status, 0);
    const receipt = JSON.parse(
      readFileSync(join(OUT, `${EVAL}.treatment.json`), 'utf8')
    );
    assert.equal(receipt.provenance.contentApiUrl, 'http://127.0.0.1:3001');
  });
  rmSync(fake, { recursive: true, force: true });
}

// --- --suite: expands to the published set; guarded against misuse ---
{
  const r = local(['compare', '--suite', 'regression']);
  ck('suite expands and runs every published eval', () => {
    assert.equal(r.status, 0);
    assert.match(r.out, /suite regression for claude-code-sonnet-5: \d+ evals/);
    assert.ok(
      (r.out.match(/=== local compare: /g) ?? []).length >= 2,
      'expected multiple compare blocks'
    );
  });
  const wrongMode = local(['run', '--suite', 'regression']);
  ck('suite refused in run mode', () => {
    assert.equal(wrongMode.status, 1);
    assert.match(wrongMode.out, /only makes sense with compare/);
  });
  const both = local(['compare', EVAL, '--suite', 'regression']);
  ck('suite plus ids refused', () => {
    assert.equal(both.status, 1);
    assert.match(both.out, /not both/);
  });
  const bogus = local(['compare', '--suite', 'nope']);
  ck('unknown suite lists available', () => {
    assert.equal(bogus.status, 1);
    assert.match(bogus.out, /unknown suite: nope.*regression, benchmark/);
  });
}

// --- judge-key gate: refused pre-spend, before any agent spawn ---
{
  // needs an eval whose scorer really uses the judge; EVAL may not
  const judgedEval = published.find(
    (row) =>
      row.experiment === EXPERIMENT &&
      existsSync(join(ROOT, 'evals', row.eval, 'EVAL.ts')) &&
      /\bjudge\b/.test(
        readFileSync(join(ROOT, 'evals', row.eval, 'EVAL.ts'), 'utf8')
      )
  )?.eval;
  assert.ok(judgedEval, 'no judged eval found in the published set');
  const r = local(['run', judgedEval], {
    LOCAL_EVAL_CMD: '',
    OPENAI_API_KEY: '',
  });
  ck('judged eval without OPENAI_API_KEY refused pre-spend', () => {
    assert.equal(r.status, 1);
    assert.match(r.out, /score with the LLM judge/);
    assert.match(r.out, /add OPENAI_API_KEY/);
  });
}

// cleanup: everything lived in the sandbox
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`smoke-local: ${passed} checks passed`);
