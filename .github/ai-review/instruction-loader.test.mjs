import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { hashText } from './collect-evidence.mjs';
import { loadReviewInstructions } from './instruction-loader.mjs';

const dirs = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'review-instructions-'));
  dirs.push(dir);
  const files = {
    'CONTRIBUTING.md': 'Trusted rubric.',
    '.github/ai-review/review-contract.md': 'Trusted contract.',
    '.github/ai-review/prompts/claude-review.md': 'Trusted review prompt.',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const head = 'a'.repeat(40);
  return {
    reviewer: 'claude',
    cwd: dir,
    env: {
      ...process.env,
      AI_REVIEW_APPROVED_CONTROLLER_SHA: head,
    },
    evidence: {
      invocation: { repo: 'supabase/evals' },
      pullRequest: { head: { sha: head } },
      candidateInstructions: {
        files: Object.entries(files).map(([path]) => {
          const text = path.endsWith('claude-review.md')
            ? 'Candidate-only review prompt.'
            : `Candidate ${path}`;
          return {
            path,
            text,
            sha256: hashText(text),
            status: 'found',
            source: { ref: head },
            truncated: false,
          };
        }),
      },
    },
  };
}

test('selects exact approved branch instructions over trusted checkout contents', async () => {
  const options = await fixture();
  options.env.AI_REVIEW_APPROVED_INSTRUCTION_SHA = 'b'.repeat(40);
  const candidate = await loadReviewInstructions({
    ...options,
    instructionMode: 'candidate',
  });
  expect(candidate.text).toContain('Candidate-only review prompt.');
  expect(candidate.text).not.toContain('Trusted review prompt.');
  const trusted = await loadReviewInstructions({
    ...options,
    instructionMode: 'trusted',
  });
  expect(trusted.text).toContain('Trusted review prompt.');
  expect(trusted.text).not.toContain('Candidate-only review prompt.');
});

test('rejects unapproved, stale, truncated, and tampered branch instructions', async () => {
  const options = await fixture();
  options.instructionMode = 'candidate';
  await expect(
    loadReviewInstructions({
      ...options,
      env: {
        ...options.env,
        AI_REVIEW_APPROVED_CONTROLLER_SHA: 'b'.repeat(40),
      },
    })
  ).rejects.toThrow('exact PR head');
  const file = options.evidence.candidateInstructions.files[0];
  file.source.ref = 'b'.repeat(40);
  await expect(loadReviewInstructions(options)).rejects.toThrow(
    'unavailable at approved head'
  );
  file.source.ref = options.evidence.pullRequest.head.sha;
  file.truncated = true;
  await expect(loadReviewInstructions(options)).rejects.toThrow(
    'unavailable at approved head'
  );
  file.truncated = false;
  file.text += ' Changed without a matching hash.';
  await expect(loadReviewInstructions(options)).rejects.toThrow(
    'hash mismatch'
  );
});
