import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONTENT_API_FLAG_MIN_VERSION,
  supportsContentApiFlag,
} from '../harness/mcp-launch.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'smoke-eval-strict-'));
const EXPERIMENT = 'claude-code-sonnet-5';
const evalIds = readdirSync(join(ROOT, 'evals')).filter((id) => {
  const prompt = join(ROOT, 'evals', id, 'PROMPT.md');
  if (!existsSync(prompt)) {
    console.warn(
      `SKIP ${id} (eval is absent from this checkout: evals/${id}/PROMPT.md not found)`
    );
    return false;
  }
  return existsSync(join(ROOT, 'evals', id, 'EVAL.ts'));
});
const EVAL = evalIds[0];
assert.ok(EVAL, 'no eval fixture found');
const JUDGED_EVAL = evalIds.find((id) =>
  /\bjudge\b/.test(readFileSync(join(ROOT, 'evals', id, 'EVAL.ts'), 'utf8'))
);
assert.ok(JUDGED_EVAL, 'no judged eval fixture found');

const fakeScript = join(SANDBOX, 'fake-eval.cjs');
writeFileSync(
  fakeScript,
  `const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.dirname(process.env.RES), { recursive: true });
fs.writeFileSync(process.env.RES, JSON.stringify({
  passed: true,
  checks: [{ name: 'fake run', passed: true }],
  attempts: 1,
  skills: { available: [], loaded: [] },
  docs: { calls: [] },
  toolCalls: [],
  transcript: [],
  agentReport: '',
  stoppedReason: 'end_turn'
}));
`
);
const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)}`;

function runEval(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('pnpm', ['eval', '--', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'placeholder',
      OPENAI_API_KEY: 'placeholder',
      LOCAL_EVAL_CMD: FAKE,
      LOCAL_RESULTS_ROOT: SANDBOX,
      FORCE_COLOR: '0',
      ...env,
    },
  });
  return {
    output: `${result.stdout}\n${result.stderr}`,
    status: result.status,
  };
}

let passed = 0;
function check(name: string, assertion: () => void, diagnostic?: string) {
  try {
    assertion();
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${name}`);
    if (diagnostic) {
      throw new Error(`${name} failed\n\nChild output:\n${diagnostic}`, {
        cause: error,
      });
    }
    throw error;
  }
}

try {
  check('versions below the content API flag release are not capable', () => {
    for (const version of ['0.8.1', '0.9.0', '0.9.9', '0.1.0']) {
      assert.equal(supportsContentApiFlag(version), false, version);
    }
  });
  check('the content API flag release and newer are capable', () => {
    for (const version of [CONTENT_API_FLAG_MIN_VERSION, '0.10.1', '1.0.0']) {
      assert.equal(supportsContentApiFlag(version), true, version);
    }
  });
  check('content API prereleases are not capable', () => {
    for (const version of ['0.10.0-dev.1', '0.11.0-beta', '1.0.0-rc.1']) {
      assert.equal(supportsContentApiFlag(version), false, version);
    }
  });
  check('malformed content API versions throw', () => {
    for (const version of ['0.10.foo', '0.10', '', 'latest', 'v0.10.0']) {
      assert.throws(
        () => supportsContentApiFlag(version),
        /not a MAJOR\.MINOR\.PATCH version/
      );
    }
  });

  {
    const result = runEval([
      '--strict',
      '--experiment',
      'bogus-model',
      '--eval',
      EVAL,
    ]);
    check('unknown experiment is refused', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no experiment matched: bogus-model/);
    });
  }

  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      'not-an-eval-dir',
    ]);
    check('unknown eval is refused', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no eval matched: not-an-eval-dir/);
    });
  }

  {
    const result = runEval(
      ['--strict', '--experiment', EXPERIMENT, '--eval', EVAL],
      { ANTHROPIC_API_KEY: '' }
    );
    check('strict refuses a missing agent key', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /ANTHROPIC_API_KEY/);
    });
  }

  {
    const result = runEval(['--experiment', EXPERIMENT, '--eval', EVAL], {
      ANTHROPIC_API_KEY: '',
    });
    check('default mode keeps the missing-key skip', () => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, new RegExp(`SKIP ${EXPERIMENT}`));
    });
  }

  {
    const emptySkills = join(SANDBOX, 'empty-skills');
    mkdirSync(emptySkills);
    const result = runEval(
      ['--strict', '--experiment', EXPERIMENT, '--eval', EVAL],
      { LOCAL_SKILLS_ROOT: emptySkills }
    );
    check('strict refuses missing experiment skills', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /declares skills this checkout is missing/);
      assert.match(result.output, /git submodule update --init/);
    });
  }

  {
    const partialSkills = join(SANDBOX, 'partial-skills');
    mkdirSync(join(partialSkills, 'supabase'), { recursive: true });
    mkdirSync(join(partialSkills, 'supabase-postgres-best-practices'), {
      recursive: true,
    });
    const result = runEval(
      ['--strict', '--experiment', EXPERIMENT, '--eval', EVAL],
      { LOCAL_SKILLS_ROOT: partialSkills }
    );
    check('strict refuses skill directories without SKILL.md', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /declares skills this checkout is missing/);
    });
  }

  {
    const result = runEval(
      ['--strict', '--experiment', EXPERIMENT, '--eval', JUDGED_EVAL],
      { OPENAI_API_KEY: '', LOCAL_EVAL_CMD: '' }
    );
    check('judged eval without OPENAI_API_KEY is refused pre-spend', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /score with the LLM judge/);
      assert.match(result.output, /add OPENAI_API_KEY/);
    });
  }

  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
      '--mcp',
      '/definitely/not/a/path',
    ]);
    check('missing MCP override path is refused', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /--mcp path does not exist/);
    });
  }

  const mcpCheckout = join(SANDBOX, 'mcp-checkout');
  const mcpPackage = join(mcpCheckout, 'packages', 'mcp-server-supabase');
  mkdirSync(mcpPackage, { recursive: true });
  writeFileSync(join(mcpPackage, 'package.json'), '{"version":"0.0.0"}');

  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
      '--mcp',
      mcpCheckout,
    ]);
    check('unbuilt MCP override is refused with a build hint', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no built server at .*mcp-server-supabase/);
      assert.match(result.output, /pnpm install && pnpm build/);
    });
  }

  mkdirSync(join(mcpPackage, 'dist', 'transports'), { recursive: true });
  writeFileSync(join(mcpPackage, 'dist', 'transports', 'stdio.js'), '');
  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
      '--content-api',
      'http://127.0.0.1:3001',
      '--mcp',
      mcpCheckout,
    ]);
    check('MCP build without the content API flag is refused', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no --content-api-url flag/);
    });
  }

  writeFileSync(
    join(mcpPackage, 'dist', 'transports', 'stdio.js'),
    'process.env.SUPABASE_CONTENT_API_URL\n'
  );
  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
      '--content-api',
      'http://127.0.0.1:3001',
      '--mcp',
      mcpCheckout,
    ]);
    check('MCP env fallback without the content API flag is refused', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no --content-api-url flag/);
    });
  }

  writeFileSync(
    join(mcpPackage, 'dist', 'transports', 'stdio.js'),
    `// parser does not support 'content-api-url': legacy build
console.error("unsupported '--content-api-url' option");
`
  );
  {
    const result = runEval([
      '--strict',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
      '--content-api',
      'http://127.0.0.1:3001',
      '--mcp',
      mcpCheckout,
    ]);
    check('MCP comments and diagnostics do not prove flag support', () => {
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /no --content-api-url flag/);
    });
  }

  const receiptRun = runEval([
    '--strict',
    '--experiment',
    EXPERIMENT,
    '--eval',
    EVAL,
    '--mcp',
    mcpCheckout,
  ]);
  check('built MCP override reaches the eval path', () => {
    assert.equal(receiptRun.status, 0, receiptRun.output);
    assert.match(receiptRun.output, new RegExp(`PASS ${EXPERIMENT} x ${EVAL}`));
  });

  const resultPath = join(SANDBOX, 'results', EXPERIMENT, `${EVAL}.json`);
  check(
    'result receipt stays under results experiment subdirectory',
    () => {
      const receipt = JSON.parse(readFileSync(resultPath, 'utf8'));
      assert.equal(receipt.eval, EVAL);
      assert.equal(receipt.experiment, EXPERIMENT);
      assert.ok(receipt.provenance.generatedAt);
      assert.equal(receipt.provenance.host.sha.length, 40);
      assert.match(
        receipt.provenance.mcpOverride.path,
        /packages[/\\]mcp-server-supabase$/
      );
      assert.equal(existsSync(join(SANDBOX, 'results-local')), false);
    },
    receiptRun.output
  );

  {
    writeFileSync(resultPath, '{');
    const result = runEval([
      '--strict',
      '--skip-existing',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
    ]);
    check('skip-existing reruns a corrupt result', () => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /existing result is invalid/);
      assert.match(result.output, new RegExp(`PASS ${EXPERIMENT} x ${EVAL}`));
      assert.doesNotThrow(() => JSON.parse(readFileSync(resultPath, 'utf8')));
    });
  }
  writeFileSync(
    join(mcpPackage, 'dist', 'transports', 'stdio.js'),
    `const options = {
  'content-api-url': { type: 'string' },
};
`
  );
  const contentApiRun = runEval([
    '--strict',
    '--experiment',
    EXPERIMENT,
    '--eval',
    EVAL,
    '--content-api',
    'http://127.0.0.1:3001',
    '--mcp',
    mcpCheckout,
  ]);
  check('MCP build with the content API flag reaches the eval path', () => {
    assert.equal(contentApiRun.status, 0, contentApiRun.output);
    assert.match(
      contentApiRun.output,
      new RegExp(`PASS ${EXPERIMENT} x ${EVAL}`)
    );
  });
  check(
    'content API override is recorded in the receipt',
    () => {
      const receipt = JSON.parse(readFileSync(resultPath, 'utf8'));
      assert.equal(receipt.provenance.contentApiUrl, 'http://127.0.0.1:3001');
    },
    contentApiRun.output
  );

  {
    const result = runEval([
      '--strict',
      '--skip-existing',
      '--experiment',
      EXPERIMENT,
      '--eval',
      EVAL,
    ]);
    check('strict keeps skip-existing intentional', () => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /already ran/);
    });
  }

  {
    const result = runEval(['list', '--strict', '--eval', EVAL], {
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    });
    check('strict keeps list planning free of credential gates', () => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /claude-code-sonnet-5/);
    });
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`smoke-local: ${passed} checks passed`);
