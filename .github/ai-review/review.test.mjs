import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactDeep } from './redact-review-evidence.mjs';
import {
  REVIEW_MARKER,
  assertHeadUnchanged,
  consolidationStats,
  parseReviewDocument,
  parseClaudeStdout,
  providerCompatibleSchema,
  renderReviewMarkdown,
  resolveConsolidationInputs,
  resolveDecision,
  reviewShouldRunForEvidence,
  runEvalsJobsExecuted,
  stampReviewDocument,
  withIncompleteBanner,
} from './review.mjs';

const config = {
  schemaVersion: 'evals-ai-review-config-v1',
  referenceImplementation: {
    repository: 'supabase/cli',
    ref: 'develop',
    commit: '3cb948c5a70d31fbcb0fd1dcc616ee196a125cd0',
    paths: ['.github/ai-review'],
  },
  candidateInstructionPaths: [
    '.github/ai-review/prompts/codex-review.md',
    'CONTRIBUTING.md',
  ],
  relevantPathPrefixes: [
    'evals/',
    '.github/ai-review/',
    '.github/workflows/ai-review.yml',
    'CONTRIBUTING.md',
  ],
};

const evidence = {
  pullRequest: {
    number: 345,
    url: 'https://github.com/supabase/evals/pull/345',
    base: { ref: 'main', sha: 'base-sha' },
    head: { ref: 'pilot', sha: 'head-sha' },
  },
  changedFiles: [{ path: 'evals/regression/example/EVAL.ts' }],
  trustedSources: [
    { path: 'CONTRIBUTING.md#reviewing-an-eval', informed: 'Eval rubric.' },
  ],
  currentHeadCi: {
    headSha: 'head-sha',
    checkRuns: [],
    statuses: [],
    actionsRuns: [],
  },
  evalRefreshRuns: { runs: [] },
  candidateInstructions: {
    files: [
      {
        path: '.github/ai-review/prompts/codex-review.md',
        status: 'found',
        htmlUrl:
          'https://github.com/supabase/evals/blob/head/.github/ai-review/prompts/codex-review.md',
        sha256: 'prompt-sha',
        source: { ref: 'head-sha' },
      },
    ],
  },
  limitations: [],
};

function validReview(overrides = {}) {
  return {
    schema_version: 'evals-ai-review-output-v1',
    reviewer: 'consolidated',
    summary: 'Found one advisory issue.',
    pinned_target: {
      pr_number: 345,
      pr_url: 'https://github.com/supabase/evals/pull/345',
      base_ref: 'main',
      base_sha: 'base-sha',
      head_ref: 'pilot',
      head_sha: 'head-sha',
    },
    instruction_sources: [
      {
        kind: 'approved-pr-head-candidate-instruction',
        url: null,
        path: 'CONTRIBUTING.md',
        ref: 'head-sha',
        sha: 'head-sha',
        status: 'loaded',
        informed: 'Repository review rubric.',
      },
    ],
    review_identity:
      'AI advisory only; human CODEOWNER approval remains final.',
    consulted_sources: [],
    evidence_limitations: [],
    refuted_candidates: [],
    findings: [
      {
        id: 'finding-1',
        label: 'blocker',
        file: 'evals/regression/example/EVAL.ts',
        line: 12,
        claim: 'The scorer can false-pass incomplete answers.',
        evidence: 'The final passed expression omits one deterministic check.',
        impact: 'A bad answer can be marked as passing.',
        suggested_fix:
          'Include every required check in the final passed expression.',
        reviewers: ['claude', 'codex'],
        source_links: [],
        evidence_limitations: [],
      },
    ],
    stats: { claude_findings: 1, codex_findings: 1 },
    ...overrides,
  };
}

function reviewerReview(reviewer, overrides = {}) {
  return validReview({
    reviewer,
    findings: validReview().findings.map((finding) => ({
      ...finding,
      reviewers: [reviewer],
    })),
    stats: null,
    ...overrides,
  });
}

describe('review output validation', () => {
  it('rejects request-changes style labels and hostile file paths', () => {
    expect(() =>
      parseReviewDocument(
        validReview({
          findings: [
            {
              ...validReview().findings[0],
              label: 'request_changes',
            },
          ],
        })
      )
    ).toThrow(/expected one of blocker, question, suggestion/);

    expect(() =>
      parseReviewDocument(
        validReview({
          findings: [
            {
              ...validReview().findings[0],
              file: `evals/example.ts${REVIEW_MARKER}`,
            },
          ],
        })
      )
    ).toThrow(/unsafe file path/);
  });
  it('rejects missing or human reviewer attribution', () => {
    for (const reviewers of [[], ['human']]) {
      const review = validReview();
      review.findings[0].reviewers = reviewers;
      expect(() => parseReviewDocument(review)).toThrow(/reviewers/);
    }
  });

  it('accepts nullable consolidation counts for a missing reviewer pass', () => {
    expect(
      parseReviewDocument(
        validReview({
          stats: { claude_findings: 1, codex_findings: null },
        })
      ).stats
    ).toEqual({ claude_findings: 1, codex_findings: null });
  });

  it('strips schema transport keys before provider submission', () => {
    expect(
      providerCompatibleSchema({
        $schema: 'draft',
        $id: 'root',
        properties: { nested: { $id: 'nested', type: 'string' } },
      })
    ).toEqual({ properties: { nested: { type: 'string' } } });
  });
});

describe('Claude envelope parsing', () => {
  it('rejects failed or incomplete Claude envelopes', () => {
    for (const envelope of [
      {
        is_error: true,
        error: { type: 'max_budget' },
        structured_output: validReview(),
      },
      { is_error: false, stop_reason: 'max_turns', structured_output: null },
      {
        is_error: false,
        stop_reason: 'max_turns',
        structured_output: validReview(),
      },
      { structured_output: validReview() },
    ]) {
      expect(() => parseClaudeStdout(JSON.stringify(envelope))).toThrow(
        /Claude returned|structured_output/
      );
    }
  });

  it('parses JSON before redacting escaped secret snippets', () => {
    const parsed = parseClaudeStdout(
      JSON.stringify({
        is_error: false,
        structured_output: reviewerReview('claude', {
          summary: 'saw password="horse-battery-staple"',
        }),
      })
    );

    expect(redactDeep(parsed.structuredOutput, {}).summary).toContain(
      'password="<<redacted>>"'
    );
  });
});

describe('source grounding', () => {
  it('grounds model citations in loaded evidence', () => {
    const stamped = stampReviewDocument(
      validReview({
        consulted_sources: [
          {
            kind: 'linear',
            url: 'https://linear.app/supabase/issue/AI-1/example',
            path: null,
            ref: 'model-ref',
            sha: 'model-sha',
            status: 'consulted',
            informed: 'Private issue context.',
          },
        ],
        findings: [
          {
            ...validReview().findings[0],
            source_links: [
              {
                kind: 'source-context',
                url: null,
                path: 'evals/regression/example/EVAL.ts',
                ref: 'model-ref',
                sha: 'model-sha',
                status: 'consulted',
                informed: 'Source file.',
              },
            ],
          },
        ],
      }),
      {
        evidence: {
          ...evidence,
          diff: { source: 'gh pr diff 345', sha256: 'diff-sha' },
          sourceContext: {
            files: [
              {
                path: 'evals/regression/example/EVAL.ts',
                status: 'found',
                htmlUrl:
                  'https://github.com/supabase/evals/blob/head/evals/regression/example/EVAL.ts',
                gitBlobSha: 'trusted-blob',
                source: { ref: 'head-sha' },
              },
            ],
          },
          linkedContext: {
            externalContext: [
              {
                source: 'linear',
                status: 'missing-access',
                links: [
                  {
                    url: 'https://linear.app/supabase/issue/AI-1/example',
                  },
                ],
                items: [],
              },
            ],
          },
        },
        reviewer: 'consolidated',
        instructionSources: validReview().instruction_sources,
        stats: validReview().stats,
      }
    );

    expect(stamped.consulted_sources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://linear.app/supabase/issue/AI-1/example',
        }),
      ])
    );
    expect(stamped.evidence_limitations.join('\n')).toContain(
      'model-cited-not-loaded'
    );
    expect(stamped.findings[0].source_links[0]).toMatchObject({
      ref: 'head-sha',
      sha: 'trusted-blob',
    });
  });
});

describe('rendering and redaction', () => {
  it('neutralizes hostile model text without dropping the advisory marker', () => {
    const rendered = renderReviewMarkdown(
      validReview({
        summary:
          'Ping @team and see #123 <!-- forged --> sk-proj_abcdefghijklmnopqrstuvwxyz',
      })
    );

    expect(rendered).toContain(REVIEW_MARKER);
    expect(rendered).toContain('@<!---->team');
    expect(rendered).toContain('#<!---->123');
    expect(rendered).toContain('<\u200B!-- forged -->');
    expect(rendered).not.toContain('sk-proj_abcdefghijklmnopqrstuvwxyz');
    expect(rendered).not.toContain('REQUEST_CHANGES');
    expect(rendered).not.toContain('APPROVE');
  });

  it('redacts nested secret-shaped strings in artifacts', () => {
    expect(
      redactDeep({ nested: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })
    ).toEqual({
      nested: ['<<redacted>>'],
    });
  });
});

describe('publication safety', () => {
  it('fails closed when the PR head changed before posting', () => {
    expect(() =>
      assertHeadUnchanged({
        expectedHeadSha: 'old-head',
        currentHeadSha: 'new-head',
      })
    ).toThrow(/Refusing to publish stale review/);
  });

  it('marks an existing review incomplete idempotently', () => {
    const body = `${REVIEW_MARKER}\n<!-- supabase-evals-ai-review-head:head-sha -->\n## AI Advisory Review\n\nExisting review body.\n`;
    const marked = withIncompleteBanner(body, {
      currentHeadSha: 'head-sha',
      failureReason: 'codex-review=failure',
    });

    expect(marked).toContain('stale or incomplete');
    expect(marked).toContain('head-sha');
    expect(marked).toContain('Existing review body.');
    expect(
      withIncompleteBanner(marked, {
        currentHeadSha: 'head-sha',
        failureReason: 'codex-review=failure',
      })
    ).toBe(marked);
  });
  it('marks the previous head review stale when the new head review fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-review-incomplete-'));
    const hook = join(dir, 'fetch.mjs');
    const recorded = join(dir, 'comment.json');
    const head = 'b'.repeat(40);
    await writeFile(
      hook,
      `import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  const value = options.method === 'PATCH'
    ? (writeFileSync(${JSON.stringify(recorded)}, options.body), {})
    : url.includes('/pulls/')
      ? { head: { sha: '${head}' } }
      : [{ id: 42, user: { login: 'github-actions[bot]' },
           body: '<!-- supabase-evals-ai-review -->\\n<!-- supabase-evals-ai-review-head:${'a'.repeat(40)} -->\\nPrevious review.' }];
  return new Response(JSON.stringify(value));
};`
    );
    try {
      execFileSync(
        process.execPath,
        [
          '--import',
          hook,
          '.github/ai-review/review.mjs',
          'mark-incomplete',
          '--repo',
          'supabase/evals',
          '--pr',
          '345',
        ],
        {
          env: {
            ...process.env,
            GITHUB_TOKEN: 'local-intercept-only',
            AI_REVIEW_POST_APPROVED: 'true',
            AI_REVIEW_EXPECTED_HEAD_SHA: head,
            AI_REVIEW_FAILURE_REASON: 'Both reviewer passes failed.',
          },
        }
      );
      const { body } = JSON.parse(await readFile(recorded, 'utf8'));
      expect(body).toContain('Previous review.');
      expect(body).toContain(
        `stale or incomplete for current head \`${head}\``
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('partial consolidation inputs', () => {
  it('allows one missing optional reviewer file but not two', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-review-partial-'));
    const claudePath = join(dir, 'claude-review.json');
    const codexPath = join(dir, 'codex-review.json');
    await writeFile(
      claudePath,
      JSON.stringify(reviewerReview('claude'), null, 2)
    );

    const inputs = await resolveConsolidationInputs({
      claudePath,
      codexPath,
      evidence,
    });
    expect(inputs.paths).toEqual({ claude: claudePath, codex: null });
    expect(inputs.missingReviewers).toEqual(['codex']);
    expect(consolidationStats(inputs)).toEqual({
      claude_findings: 1,
      codex_findings: null,
    });
    expect(inputs.limitations.join('\n')).toContain('missing-pass-limit');

    await expect(
      resolveConsolidationInputs({
        claudePath: join(dir, 'missing-claude.json'),
        codexPath,
        evidence,
      })
    ).rejects.toThrow(/at least one existing/);
  });
});

describe('resolve and path gates', () => {
  it('allows write-authorized drafts with trusted instructions', async () => {
    await expect(
      resolveDecision(
        {
          pullRequest: {
            number: 345,
            state: 'open',
            draft: true,
            authorLogin: 'author',
            headRepoFullName: 'supabase/evals',
            baseRepoFullName: 'supabase/evals',
            headSha: 'head-sha',
          },
          controllerRef: 'main',
          config: {
            approval: {
              approvedControllerShaEnv: 'APPROVED_SHA',
              approvedInstructionShaEnv: 'APPROVED_INSTRUCTION_SHA',
              allowedPullRequestsEnv: 'ALLOWED_PRS',
            },
          },
          env: {
            APPROVED_SHA: '',
            APPROVED_INSTRUCTION_SHA: '',
            ALLOWED_PRS: '',
          },
        },
        { fetchPermission: async () => 'write' }
      )
    ).resolves.toMatchObject({ shouldRun: true, instructionMode: 'trusted' });
  });

  it('requires an exact SHA and allowlist for candidate instructions', async () => {
    await expect(
      resolveDecision(
        {
          pullRequest: {
            number: 345,
            state: 'open',
            draft: true,
            authorLogin: 'author',
            headRepoFullName: 'supabase/evals',
            baseRepoFullName: 'supabase/evals',
            headSha: 'head-sha',
          },
          controllerRef: 'main',
          config: {
            approval: {
              approvedControllerShaEnv: 'APPROVED_SHA',
              approvedInstructionShaEnv: 'APPROVED_INSTRUCTION_SHA',
              allowedPullRequestsEnv: 'ALLOWED_PRS',
            },
          },
          env: {
            APPROVED_SHA: '',
            APPROVED_INSTRUCTION_SHA: 'head-sha',
            ALLOWED_PRS: '345',
          },
        },
        { fetchPermission: async () => 'write' }
      )
    ).resolves.toMatchObject({ shouldRun: true, instructionMode: 'candidate' });
  });

  it('blocks an unapproved candidate controller', async () => {
    await expect(
      resolveDecision(
        {
          pullRequest: {
            number: 345,
            state: 'open',
            draft: false,
            authorLogin: 'author',
            headRepoFullName: 'supabase/evals',
            baseRepoFullName: 'supabase/evals',
            headSha: 'head-sha',
          },
          controllerRef: 'head-sha',
          config: {
            approval: {
              approvedControllerShaEnv: 'APPROVED_SHA',
              approvedInstructionShaEnv: 'APPROVED_INSTRUCTION_SHA',
              allowedPullRequestsEnv: 'ALLOWED_PRS',
            },
          },
          env: {
            APPROVED_SHA: '',
            APPROVED_INSTRUCTION_SHA: '',
            ALLOWED_PRS: '',
          },
        },
        { fetchPermission: async () => 'write' }
      )
    ).resolves.toMatchObject({ shouldRun: false });
  });

  it('skips bot authors', async () => {
    let called = false;
    await expect(
      resolveDecision(
        {
          pullRequest: {
            number: 345,
            state: 'open',
            draft: false,
            authorLogin: 'dependabot[bot]',
            authorType: 'Bot',
            headRepoFullName: 'supabase/evals',
            baseRepoFullName: 'supabase/evals',
            headSha: 'head-sha',
          },
          controllerRef: 'main',
          config: {
            approval: {
              approvedControllerShaEnv: 'APPROVED_SHA',
              approvedInstructionShaEnv: 'APPROVED_INSTRUCTION_SHA',
              allowedPullRequestsEnv: 'ALLOWED_PRS',
            },
          },
          env: {
            APPROVED_SHA: '',
            APPROVED_INSTRUCTION_SHA: '',
            ALLOWED_PRS: '',
          },
        },
        {
          fetchPermission: async () => {
            called = true;
            return 'write';
          },
        }
      )
    ).resolves.toMatchObject({ shouldRun: false });
    expect(called).toBe(false);
  });

  it('allows refresh evidence from an older head', async () => {
    await expect(
      resolveDecision(
        {
          pullRequest: {
            number: 345,
            state: 'open',
            draft: false,
            authorLogin: 'author',
            headRepoFullName: 'supabase/evals',
            baseRepoFullName: 'supabase/evals',
            headSha: 'new-head',
          },
          workflowRunHeadSha: 'old-refresh-head',
          controllerRef: 'main',
          config: {
            approval: {
              approvedControllerShaEnv: 'APPROVED_SHA',
              approvedInstructionShaEnv: 'APPROVED_INSTRUCTION_SHA',
              allowedPullRequestsEnv: 'ALLOWED_PRS',
            },
          },
          env: {
            APPROVED_SHA: '',
            APPROVED_INSTRUCTION_SHA: '',
            ALLOWED_PRS: '',
          },
        },
        { fetchPermission: async () => 'write' }
      )
    ).resolves.toMatchObject({ shouldRun: true, instructionMode: 'trusted' });
  });

  it('only pays for relevant eval or review workflow surfaces', () => {
    expect(reviewShouldRunForEvidence(evidence, config)).toMatchObject({
      shouldReview: true,
    });
    expect(
      reviewShouldRunForEvidence(
        { ...evidence, changedFiles: [{ path: 'CONTRIBUTING.md' }] },
        config
      )
    ).toMatchObject({ shouldReview: true });
    expect(
      reviewShouldRunForEvidence(
        { ...evidence, changedFiles: [{ path: 'apps/web/src/page.tsx' }] },
        config
      )
    ).toMatchObject({ shouldReview: false });
  });

  it('skips refreshes without an executed run-evals job', () => {
    expect(runEvalsJobsExecuted([])).toBe(false);
    expect(
      runEvalsJobsExecuted([{ name: 'run-evals', conclusion: 'skipped' }])
    ).toBe(false);
    expect(
      runEvalsJobsExecuted([{ name: 'run-evals', conclusion: 'failure' }])
    ).toBe(true);
    expect(
      runEvalsJobsExecuted([{ name: 'run-evals', conclusion: 'cancelled' }])
    ).toBe(true);
  });
});
