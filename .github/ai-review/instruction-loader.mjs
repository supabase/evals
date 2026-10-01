import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashText } from './collect-evidence.mjs';

const MAX_INSTRUCTION_BYTES = 150_000;
const PROMPTS = {
  claude: 'claude-review',
  codex: 'codex-review',
  consolidated: 'consolidate',
};

function boundedText(text, path) {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES
  ) {
    throw new Error(
      `Missing, empty, or oversized mandatory instruction: ${path}`
    );
  }
  return text;
}

export async function loadReviewInstructions({
  reviewer,
  evidence,
  instructionMode,
  cwd = process.cwd(),
  env = process.env,
}) {
  if (!Object.hasOwn(PROMPTS, reviewer))
    throw new Error('Unknown instruction reviewer.');
  if (!['trusted', 'candidate'].includes(instructionMode))
    throw new Error('Unknown instruction mode.');
  const head = evidence.pullRequest?.head?.sha;
  if (
    instructionMode === 'candidate' &&
    (!/^[a-f0-9]{40}$/.test(head ?? '') ||
      (env.AI_REVIEW_APPROVED_INSTRUCTION_SHA !== head &&
        env.AI_REVIEW_APPROVED_CONTROLLER_SHA !== head))
  ) {
    throw new Error(
      'Candidate instructions require approval of the exact PR head before model execution.'
    );
  }
  const parts = [];
  const sources = [];
  function add(kind, path, text, ref, sha, repo) {
    parts.push(`## ${kind}: ${path}\n\n${text}`);
    sources.push({
      kind,
      path,
      ref,
      sha,
      status: 'loaded',
      url: repo ? `https://github.com/${repo}/blob/${ref}/${path}` : null,
      informed: `Loaded review instructions; content SHA-256 ${hashText(text)}.`,
    });
  }
  const paths = [
    'CONTRIBUTING.md',
    '.github/ai-review/review-contract.md',
    `.github/ai-review/prompts/${PROMPTS[reviewer]}.md`,
  ];
  for (const path of paths) {
    let text;
    let ref;
    let sha;
    if (instructionMode === 'candidate') {
      const files = (evidence.candidateInstructions?.files ?? []).filter(
        (file) => file.path === path
      );
      const file = files[0];
      if (
        files.length !== 1 ||
        file.status !== 'found' ||
        file.source?.ref !== head ||
        file.truncated
      ) {
        throw new Error(
          `Mandatory candidate instruction unavailable at approved head: ${path}`
        );
      }
      text = boundedText(file.text, path);
      if (file.sha256 !== hashText(text))
        throw new Error(`Candidate instruction hash mismatch: ${path}`);
      ref = head;
      sha = head;
    } else {
      const local = resolve(cwd, path);
      if ((await stat(local)).size > MAX_INSTRUCTION_BYTES)
        throw new Error(`Oversized instruction: ${path}`);
      text = boundedText(await readFile(local, 'utf8'), path);
      ref = env.AI_REVIEW_CONTROLLER_REF || 'local trusted checkout';
      sha = hashText(text);
    }
    add(
      instructionMode === 'candidate'
        ? 'approved-pr-head-candidate-instruction'
        : 'trusted-controller-instruction',
      path,
      text,
      ref,
      sha,
      instructionMode === 'candidate' ? evidence.invocation?.repo : null
    );
  }
  return { text: parts.join('\n\n'), sources };
}
