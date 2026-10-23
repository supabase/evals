import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact-review-evidence.mjs';
import {
  buildMissingAccess,
  classifyRunCurrentness,
  collectEvidence,
  extractEvalIds,
  ownersForPath,
  parseCodeowners,
  parseArgs,
  parseContextLinks,
  parseSlackArchiveUrl,
  selectSourceContextFiles,
} from './collect-evidence.mjs';

describe('classifyRunCurrentness', () => {
  it('marks exact head matches as current evidence', () => {
    expect(
      classifyRunCurrentness({
        runHeadSha: 'abc',
        currentHeadSha: 'abc',
      })
    ).toMatchObject({
      kind: 'exact-current-head',
      current: true,
    });
  });

  it('keeps result-only descendants explicit instead of calling them current', () => {
    expect(
      classifyRunCurrentness({
        runHeadSha: 'run',
        currentHeadSha: 'current',
        compare: {
          status: 'ahead',
          files: [{ filename: 'apps/web/src/data/cli-eval-results.json' }],
        },
      })
    ).toMatchObject({
      kind: 'stale-result-only-descendant',
      current: false,
      changedPaths: ['apps/web/src/data/cli-eval-results.json'],
    });
  });

  it('distinguishes source changes after a refresh run from result-only commits', () => {
    expect(
      classifyRunCurrentness({
        runHeadSha: 'run',
        currentHeadSha: 'current',
        compare: {
          status: 'ahead',
          files: [
            { filename: 'apps/web/src/data/regression-eval-results.json' },
            { filename: 'evals/regression/new-eval/EVAL.ts' },
          ],
        },
      })
    ).toMatchObject({
      kind: 'stale-descendant-with-source-changes',
      current: false,
    });
  });
});

describe('redactSecrets', () => {
  it('redacts environment token values and common secret-shaped strings', () => {
    const text = redactSecrets(
      'token=local-secret-value and OPENAI sk-proj_abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz',
      { GH_TOKEN: 'local-secret-value' }
    );

    expect(text).toContain('token=<<redacted>>');
    expect(text).not.toContain('local-secret-value');
    expect(text).not.toContain('sk-proj_abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
  });
});

describe('context link parsing', () => {
  it('preserves Slack links and Linear keys without claiming they were read', () => {
    const links = parseContextLinks(
      'See AI-1277 and https://supabase.slack.com/archives/C051L8U2EJF/p1789488713293089.'
    );

    expect(links).toContainEqual({
      type: 'linear-key',
      key: 'AI-1277',
      url: null,
    });
    expect(links).toContainEqual({
      type: 'slack',
      url: 'https://supabase.slack.com/archives/C051L8U2EJF/p1789488713293089',
    });
    expect(
      buildMissingAccess(
        'slack',
        'token unavailable',
        links.filter((link) => link.type === 'slack')
      )
    ).toMatchObject({
      source: 'slack',
      status: 'missing-access',
      items: [],
    });
  });

  it('converts Slack archive permalinks into conversations.replies coordinates', () => {
    expect(
      parseSlackArchiveUrl(
        'https://supabase.slack.com/archives/C051L8U2EJF/p1789488713293089'
      )
    ).toEqual({
      channel: 'C051L8U2EJF',
      ts: '1789488713.293089',
    });
  });
});

describe('eval source context', () => {
  it('infers changed eval ids from suite paths', () => {
    expect(
      extractEvalIds([
        { filename: 'evals/cli/resolve-database-003/PROMPT.md' },
        { filename: 'evals/cli/resolve-database-003/EVAL.ts' },
        { filename: 'evals/regression/build-auth-001/EVAL.ts' },
        { filename: 'evals/legacy-shape/PROMPT.md' },
      ])
    ).toEqual([
      {
        suite: 'cli',
        id: 'resolve-database-003',
        paths: [
          'evals/cli/resolve-database-003/PROMPT.md',
          'evals/cli/resolve-database-003/EVAL.ts',
        ],
      },
      {
        suite: 'regression',
        id: 'build-auth-001',
        paths: ['evals/regression/build-auth-001/EVAL.ts'],
      },
    ]);
  });

  it('selects review-relevant files without pulling package lock churn into source context', () => {
    expect(
      selectSourceContextFiles(
        [
          { filename: 'evals/cli/new-eval/EVAL.ts' },
          { filename: 'pnpm-lock.yaml' },
          { filename: 'apps/framework/scripts/run-vercel-evals.ts' },
        ],
        { maxFiles: 10 }
      )
    ).toEqual([
      'evals/cli/new-eval/EVAL.ts',
      'apps/framework/scripts/run-vercel-evals.ts',
    ]);
  });
});

describe('collector raw result evidence integration', () => {
  it('adds rawResultEvidence from local raw-results artifacts without changing source currentness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'collector-raw-results-'));
    const resultDir = join(root, 'raw-results-exp__eval-a', 'eval-a', 'run-1');
    await mkdir(resultDir, { recursive: true });
    await writeFile(
      join(resultDir, 'result.json'),
      `${JSON.stringify({
        experiment: 'exp',
        experimentSuite: 'cli',
        eval: 'eval-a',
        run: 1,
        passed: true,
        checks: [{ name: 'ok', passed: true }],
        toolCalls: [{ name: 'shell', command: 'echo ok', result: 'ok' }],
        transcript: [
          {
            type: 'message',
            role: 'assistant',
            content: 'actual success transcript',
          },
        ],
        agentReport: 'actual success transcript',
      })}\n`
    );

    const options = parseArgs([
      '--repo',
      'owner/repo',
      '--pr',
      '1',
      '--only-instruction-paths',
      '--instruction-path',
      'CONTRIBUTING.md',
      '--raw-artifact-dir',
      root,
      '--skip-external-context',
      '--skip-logs',
    ]);
    const evidence = await collectEvidence(options, fakeCollectorIo());

    expect(evidence.rawResultEvidence.status).toBe('collected');
    expect(evidence.rawResultEvidence.results).toHaveLength(1);
    expect(evidence.rawResultEvidence.results[0]).toMatchObject({
      resultPath: 'raw-results-exp__eval-a/eval-a/run-1/result.json',
      passed: true,
      transcript: {
        status: 'found',
      },
      source: {
        runId: 123,
        sourceRevision: {
          kind: 'exact-current-head',
          current: true,
        },
      },
    });
    expect(evidence.rawResultEvidence.failedCheckShapes).toEqual([]);
    expect(evidence.candidateInstructions.files[0]).toMatchObject({
      path: 'CONTRIBUTING.md',
      source: {
        ref: 'head-sha',
        noFallback: true,
      },
      status: 'found',
    });
  });
});

function fakeCollectorIo() {
  const fileResponse = (path, content) => ({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
    html_url: `https://github.test/${path}`,
    sha: `${path}-sha`,
    size: Buffer.byteLength(content),
  });
  const endpoints = new Map([
    [
      'repos/owner/repo/pulls/1',
      {
        number: 1,
        html_url: 'https://github.test/pull/1',
        url: 'https://api.github.test/pull/1',
        title: 'Change eval-a',
        body: '',
        state: 'open',
        draft: false,
        user: { login: 'octo', type: 'User' },
        base: {
          repo: { full_name: 'owner/repo' },
          ref: 'main',
          sha: 'base-sha',
        },
        head: {
          repo: { full_name: 'owner/repo' },
          ref: 'feature',
          sha: 'head-sha',
        },
        created_at: '2026-09-30T00:00:00Z',
        updated_at: '2026-09-30T00:00:00Z',
      },
    ],
    [
      'repos/owner/repo/pulls/1/files?per_page=100&page=1',
      [
        {
          filename: 'evals/cli/eval-a/EVAL.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '+test',
        },
      ],
    ],
    ['repos/owner/repo/issues/1/comments?per_page=100&page=1', []],
    ['repos/owner/repo/pulls/1/reviews?per_page=100&page=1', []],
    ['repos/owner/repo/pulls/1/comments?per_page=100&page=1', []],
    [
      'repos/owner/repo/commits/head-sha/check-runs?per_page=100',
      { check_runs: [] },
    ],
    ['repos/owner/repo/commits/head-sha/status', { statuses: [] }],
    [
      'repos/owner/repo/actions/runs?head_sha=head-sha&per_page=100',
      { workflow_runs: [] },
    ],
    [
      'repos/owner/repo/actions/workflows/eval-refresh.yml/runs?branch=feature&per_page=50',
      {
        workflow_runs: [
          {
            id: 123,
            name: 'eval-refresh',
            display_title: 'eval-refresh',
            event: 'workflow_dispatch',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.test/runs/123',
            run_number: 1,
            run_attempt: 1,
            head_branch: 'feature',
            head_sha: 'head-sha',
            created_at: '2026-09-30T00:00:00Z',
            updated_at: '2026-09-30T00:00:00Z',
          },
        ],
      },
    ],
    [
      'repos/owner/repo/actions/runs/123/artifacts?per_page=100',
      {
        artifacts: [
          {
            id: 9,
            name: 'raw-results',
            size_in_bytes: 100,
            expired: false,
            created_at: '2026-09-30T00:00:00Z',
            expires_at: '2026-10-03T00:00:00Z',
            archive_download_url: 'https://api.github.test/artifacts/9/zip',
          },
        ],
      },
    ],
    ['repos/owner/repo/actions/runs/123/jobs?per_page=100', { jobs: [] }],
    [
      'repos/owner/repo/contents/CONTRIBUTING.md?ref=head-sha',
      fileResponse('CONTRIBUTING.md', '# Reviewing an Eval\n'),
    ],
    [
      'repos/owner/repo/contents/evals/cli/eval-a/EVAL.ts?ref=head-sha',
      fileResponse('evals/cli/eval-a/EVAL.ts', 'export default {};\n'),
    ],
  ]);

  return {
    env: {},
    now: () => '2026-09-30T00:00:00.000Z',
    async readLocalFile() {
      throw new Error('not found');
    },
    gh(args) {
      if (args[0] === 'pr' && args[1] === 'diff')
        return 'diff --git a/eval b/eval\n';
      if (args[0] !== 'api')
        throw new Error(`unexpected gh call ${args.join(' ')}`);
      if (!endpoints.has(args[1]))
        throw new Error(`missing endpoint ${args[1]}`);
      return JSON.stringify(endpoints.get(args[1]));
    },
    ghBuffer() {
      throw new Error('local raw artifact should be preferred over download');
    },
    async fetchJson() {
      throw new Error('external context disabled');
    },
  };
}

describe('CODEOWNERS matching', () => {
  it('uses the last matching owner rule', () => {
    const rules = parseCodeowners(`
* @supabase/ai
/evals/cli/ @supabase/cli
/apps/web/src/data/cli-eval-results.json @supabase/cli-results
`);

    expect(ownersForPath('evals/cli/new-eval/EVAL.ts', rules)).toEqual([
      '@supabase/cli',
    ]);
    expect(
      ownersForPath('apps/web/src/data/cli-eval-results.json', rules)
    ).toEqual(['@supabase/cli-results']);
    expect(ownersForPath('packages/core/src/index.ts', rules)).toEqual([
      '@supabase/ai',
    ]);
  });
});
