#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactSecrets } from './redact-review-evidence.mjs';
import {
  DEFAULT_RAW_RESULT_LIMITS,
  buildSkippedRawResultEvidence,
  collectRawResultEvidence,
} from './raw-eval-artifacts.mjs';

export const SCHEMA_VERSION = 'evals-ai-review-evidence-v1';

export const DEFAULT_INSTRUCTION_PATHS = [
  'CONTRIBUTING.md',
  '.github/ai-review/config.yml',
  '.github/ai-review/README.md',
  '.github/ai-review/review-contract.md',
  '.github/ai-review/evidence.schema.json',
  '.github/ai-review/prompts/claude-review.md',
  '.github/ai-review/prompts/codex-review.md',
  '.github/ai-review/prompts/consolidate.md',
  '.github/ai-review/review-output.schema.json',
];

const DEFAULT_OPTIONS = {
  includeExternalContext: true,
  maxComments: 40,
  maxDiffBytes: 2_000_000,
  maxFileBytes: 120_000,
  maxFiles: 80,
  maxRefreshRuns: 6,
  maxTotalFileBytes: 800_000,
  outputPath: '',
  rawArtifactDirs: [],
  skipLogs: false,
  skipRawArtifacts: false,
};

const RESULT_ONLY_PATHS = new Set([
  'apps/web/src/data/eval-results.json',
  'apps/web/src/data/regression-eval-results.json',
  'apps/web/src/data/docs-eval-results.json',
  'apps/web/src/data/cli-eval-results.json',
]);

const KNOWN_EVAL_SUITES = new Set([
  'benchmark',
  'cli',
  'docs',
  'other',
  'regression',
]);

const TEXT_LIMIT = 24_000;

export function truncateText(text, maxBytes, env = process.env) {
  const redacted = redactSecrets(text, env);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  if (bytes <= maxBytes) {
    return { text: redacted, bytes, truncated: false };
  }
  const buffer = Buffer.from(redacted, 'utf8').subarray(0, maxBytes);
  return {
    text: `${buffer.toString('utf8')}\n...[truncated after ${maxBytes} bytes]`,
    bytes,
    truncated: true,
  };
}

export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function isResultOnlyPath(path) {
  return RESULT_ONLY_PATHS.has(path);
}

export function classifyRunCurrentness({
  runHeadSha,
  currentHeadSha,
  compare,
}) {
  if (!runHeadSha) {
    return {
      kind: 'missing-run-head',
      current: false,
      explanation: 'The workflow run did not expose a head SHA.',
    };
  }
  if (runHeadSha === currentHeadSha) {
    return {
      kind: 'exact-current-head',
      current: true,
      explanation:
        'The workflow run head SHA exactly matches the current PR head.',
    };
  }
  if (!compare) {
    return {
      kind: 'stale-unknown',
      current: false,
      explanation:
        'The workflow run head SHA differs from the current PR head and the collector could not compare the two commits.',
    };
  }

  const files = Array.isArray(compare.files) ? compare.files : [];
  const changedPaths = files
    .map((file) => (typeof file.filename === 'string' ? file.filename : ''))
    .filter(Boolean);
  const allResultOnly =
    changedPaths.length > 0 &&
    changedPaths.every((path) => isResultOnlyPath(path));

  if (compare.status === 'ahead' && allResultOnly) {
    return {
      kind: 'stale-result-only-descendant',
      current: false,
      explanation:
        'The run is not current-head evidence, but the current PR head only adds known eval result files on top of that run head.',
      changedPaths,
    };
  }
  if (compare.status === 'ahead') {
    return {
      kind: 'stale-descendant-with-source-changes',
      current: false,
      explanation:
        'The current PR head descends from the run head and includes source or review-relevant changes after the run.',
      changedPaths,
    };
  }
  if (compare.status === 'identical') {
    return {
      kind: 'exact-current-head',
      current: true,
      explanation:
        'GitHub compare reports the run head and current PR head are identical.',
      changedPaths,
    };
  }
  return {
    kind: 'stale-diverged-or-rewritten',
    current: false,
    explanation:
      'The run head differs from the current PR head and is not a simple ancestor with result-only changes.',
    changedPaths,
  };
}

export function parseContextLinks(text) {
  const input = String(text ?? '');
  const urls = new Set(input.match(/https?:\/\/[^\s<>)\]]+/g) ?? []);
  const links = [];
  for (const url of urls) {
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    links.push({
      url: trimmed,
      type: classifyUrl(trimmed),
    });
  }

  const linearKeys = new Set(input.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []);
  for (const key of linearKeys) {
    links.push({
      type: 'linear-key',
      key,
      url: null,
    });
  }

  return links;
}

function classifyUrl(url) {
  if (/https:\/\/[^/]*slack\.com\/archives\//i.test(url)) return 'slack';
  if (/https:\/\/linear\.app\//i.test(url)) return 'linear';
  if (/https:\/\/github\.com\//i.test(url)) return 'github';
  if (/braintrust/i.test(url)) return 'braintrust';
  if (/https:\/\/vercel\.com\/supabase\/evals\/sandboxes\//i.test(url)) {
    return 'vercel-sandbox';
  }
  return 'url';
}

export function extractEvalIds(files) {
  const evals = new Map();
  for (const file of files) {
    const path = file.filename ?? file.path ?? '';
    const match = /^evals\/([^/]+)\/([^/]+)\//.exec(path);
    if (!match) continue;
    const [, first, second] = match;
    const suite = KNOWN_EVAL_SUITES.has(first) ? first : null;
    const id = suite ? second : first;
    const key = `${suite ?? 'unscoped'}:${id}`;
    const entry = evals.get(key) ?? { suite, id, paths: [] };
    entry.paths.push(path);
    evals.set(key, entry);
  }
  return [...evals.values()].sort((a, b) =>
    `${a.suite}:${a.id}`.localeCompare(`${b.suite}:${b.id}`)
  );
}

export function selectSourceContextFiles(files, options = DEFAULT_OPTIONS) {
  const selected = [];
  for (const file of files) {
    const path = file.filename ?? file.path ?? '';
    if (!path || file.status === 'removed') continue;
    if (path === 'pnpm-lock.yaml' || isResultOnlyPath(path)) continue;
    if (
      path.startsWith('evals/') ||
      path.startsWith('experiments/') ||
      path.startsWith('packages/') ||
      path.startsWith('apps/framework/') ||
      path.startsWith('apps/web/src/') ||
      path.startsWith('.github/workflows/') ||
      path.startsWith('.github/ai-review/') ||
      path === 'package.json' ||
      path === 'CONTRIBUTING.md' ||
      path === 'README.md'
    ) {
      selected.push(path);
    }
    if (selected.length >= options.maxFiles) break;
  }
  return selected;
}

export function parseCodeowners(text) {
  const rules = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

export function ownersForPath(path, rules) {
  let owners = [];
  for (const rule of rules) {
    if (codeownerPatternMatches(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

function codeownerPatternMatches(pattern, path) {
  if (pattern === '*') return true;
  const normalized = pattern.replace(/^\//, '');
  if (normalized.endsWith('/')) return path.startsWith(normalized);
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function buildMissingAccess(source, reason, links = []) {
  return {
    source,
    status: 'missing-access',
    reason,
    links,
    items: [],
  };
}

function parseArgs(args) {
  const parsed = {
    ...DEFAULT_OPTIONS,
    instructionPaths: [...DEFAULT_INSTRUCTION_PATHS],
    rawArtifactDirs: [],
    repo: '',
    prNumber: 0,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      const value = args[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--repo':
        parsed.repo = next();
        break;
      case '--pr':
        parsed.prNumber = Number(next());
        break;
      case '--output':
        parsed.outputPath = next();
        break;
      case '--instruction-path':
        parsed.instructionPaths.push(next());
        break;
      case '--only-instruction-paths':
        parsed.instructionPaths = [];
        break;
      case '--max-comments':
        parsed.maxComments = Number(next());
        break;
      case '--max-diff-bytes':
        parsed.maxDiffBytes = Number(next());
        break;
      case '--max-file-bytes':
        parsed.maxFileBytes = Number(next());
        break;
      case '--max-files':
        parsed.maxFiles = Number(next());
        break;
      case '--max-refresh-runs':
        parsed.maxRefreshRuns = Number(next());
        break;
      case '--raw-artifact-dir':
        parsed.rawArtifactDirs.push(next());
        break;
      case '--skip-raw-artifacts':
        parsed.skipRawArtifacts = true;
        break;
      case '--max-total-file-bytes':
        parsed.maxTotalFileBytes = Number(next());
        break;
      case '--skip-external-context':
        parsed.includeExternalContext = false;
        break;
      case '--skip-logs':
        parsed.skipLogs = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.help) {
    if (!/^[^/]+\/[^/]+$/.test(parsed.repo)) {
      throw new Error(
        'Pass --repo as owner/name, for example --repo supabase/evals'
      );
    }
    if (!Number.isSafeInteger(parsed.prNumber) || parsed.prNumber <= 0) {
      throw new Error('Pass --pr as a positive PR number');
    }
  }

  return parsed;
}

function usage() {
  return `Usage:
  node .github/ai-review/collect-evidence.mjs --repo supabase/evals --pr <number> --output /tmp/ai-review/evidence.json

Options:
  --instruction-path <path>       Add a PR-head instruction path to fetch without fallback.
  --only-instruction-paths        Clear default instruction paths before adding custom paths.
  --skip-external-context         Preserve Linear/Slack links but do not attempt token-backed reads.
  --skip-logs                     Skip gh run log reads; run/job/artifact metadata is still collected.
  --max-refresh-runs <n>          Number of eval-refresh runs to inspect. Default: ${DEFAULT_OPTIONS.maxRefreshRuns}.
  --raw-artifact-dir <path>       Local read-only raw-results artifact directory to inspect before downloads.
  --skip-raw-artifacts            Skip raw-results artifact fallback evidence collection.
  --max-diff-bytes <n>            Inline diff byte cap. Default: ${DEFAULT_OPTIONS.maxDiffBytes}.`;
}

function createGhIo(env = process.env) {
  return {
    env,
    now: () => new Date().toISOString(),
    async readLocalFile(path) {
      return readFile(path, 'utf8');
    },
    gh(args, options = {}) {
      const result = spawnSync('gh', args, {
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const message = redactSecrets(
          result.stderr || result.stdout,
          env
        ).trim();
        const error = new Error(`gh ${args.join(' ')} failed: ${message}`);
        error.status = result.status;
        throw error;
      }
      return result.stdout;
    },
    ghBuffer(args, options = {}) {
      const result = spawnSync('gh', args, {
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const output = Buffer.concat([
          result.stderr ?? Buffer.alloc(0),
          result.stdout ?? Buffer.alloc(0),
        ]).toString('utf8');
        const message = redactSecrets(output, env).trim();
        const error = new Error(`gh ${args.join(' ')} failed: ${message}`);
        error.status = result.status;
        throw error;
      }
      return result.stdout;
    },
    async fetchJson(url, init = {}) {
      const response = await fetch(url, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Request failed (${response.status}) for ${url}: ${redactSecrets(text, env)}`
        );
      }
      return text ? JSON.parse(text) : null;
    },
  };
}

async function githubJson(io, endpoint) {
  const raw = io.gh(['api', endpoint]);
  return JSON.parse(raw);
}

async function githubJsonMaybe(io, endpoint) {
  try {
    return await githubJson(io, endpoint);
  } catch (error) {
    return { error };
  }
}

async function listGithubPages(io, endpoint, pageSize = 100, maxPages = 10) {
  const joiner = endpoint.includes('?') ? '&' : '?';
  const values = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageEndpoint = `${endpoint}${joiner}per_page=${pageSize}&page=${page}`;
    const value = await githubJson(io, pageEndpoint);
    const pageValues = Array.isArray(value) ? value : value.items;
    if (!Array.isArray(pageValues)) return values;
    values.push(...pageValues);
    if (pageValues.length < pageSize) return values;
  }
  return values;
}

async function collectEvidence(options, io = createGhIo()) {
  const repo = options.repo;
  const pr = await githubJson(io, `repos/${repo}/pulls/${options.prNumber}`);
  const files = await listGithubPages(
    io,
    `repos/${repo}/pulls/${options.prNumber}/files`
  );
  const issueComments = (
    await listGithubPages(
      io,
      `repos/${repo}/issues/${options.prNumber}/comments`
    )
  ).slice(-options.maxComments);
  const reviews = (
    await listGithubPages(io, `repos/${repo}/pulls/${options.prNumber}/reviews`)
  ).slice(-options.maxComments);
  const reviewComments = (
    await listGithubPages(
      io,
      `repos/${repo}/pulls/${options.prNumber}/comments`
    )
  ).slice(-options.maxComments);

  const rawDiff = io.gh(
    [
      'pr',
      'diff',
      String(options.prNumber),
      '--repo',
      repo,
      '--color',
      'never',
    ],
    {
      maxBuffer: Math.max(options.maxDiffBytes * 3, 10 * 1024 * 1024),
    }
  );
  const diff = truncateText(rawDiff, options.maxDiffBytes, io.env);
  const codeownerRules = await readCodeowners(io);
  const headSha = pr.head?.sha ?? '';
  const baseSha = pr.base?.sha ?? '';
  const changedEvals = extractEvalIds(files);

  const [
    checkRuns,
    statuses,
    actionsRuns,
    evalRefreshRuns,
    candidateInstructions,
    sourceContext,
  ] = await Promise.all([
    collectCheckRuns(io, repo, headSha),
    collectStatuses(io, repo, headSha),
    collectActionsRuns(io, repo, headSha),
    collectEvalRefreshRuns(io, repo, pr, options),
    collectCandidateInstructions(io, repo, headSha, options.instructionPaths),
    collectSourceContext(io, repo, headSha, files, options),
  ]);
  const rawArtifactDirs = [
    ...(options.rawArtifactDirs ?? []),
    ...rawArtifactDirsFromEnv(io.env),
  ];
  const rawResultEvidence = options.skipRawArtifacts
    ? buildSkippedRawResultEvidence(
        'Raw-results artifact fallback evidence was disabled for this invocation.',
        changedEvals
      )
    : await collectRawResultEvidence({
        repo,
        runs: evalRefreshRuns.runs ?? [],
        changedEvals,
        rawArtifactDirs,
        io,
        env: io.env,
        limits: DEFAULT_RAW_RESULT_LIMITS,
      });

  const discussion = collectDiscussion(
    issueComments,
    reviews,
    reviewComments,
    io.env
  );
  const linkSources = [
    pr.title,
    pr.body ?? '',
    ...discussion.issueComments.map((comment) => comment.body),
    ...discussion.reviews.map((review) => review.body),
    ...discussion.reviewComments.map((comment) => comment.body),
  ];
  const links = dedupeLinks(linkSources.flatMap(parseContextLinks));
  const externalContext = options.includeExternalContext
    ? await collectExternalContext(io, links)
    : [
        buildMissingAccess(
          'linear',
          'External context reads were disabled for this invocation.',
          linksForType(links, 'linear')
        ),
        buildMissingAccess(
          'slack',
          'External context reads were disabled for this invocation.',
          linksForType(links, 'slack')
        ),
      ];

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: io.now(),
    collector: {
      name: 'evals-ai-review-evidence-collector',
      repository: repo,
      sourceRevision: await currentRevision(),
      referenceImplementation: {
        repository: 'supabase/cli',
        ref: 'develop',
        commit: '3cb948c5a70d31fbcb0fd1dcc616ee196a125cd0',
        paths: [
          '.github/ai-review',
          '.github/scripts/ai-review',
          '.github/workflows/ai-review.yml',
        ],
      },
    },
    invocation: {
      repo,
      prNumber: options.prNumber,
      includeExternalContext: options.includeExternalContext,
      candidateInstructionPaths: options.instructionPaths,
      limits: {
        maxComments: options.maxComments,
        maxDiffBytes: options.maxDiffBytes,
        maxFileBytes: options.maxFileBytes,
        maxFiles: options.maxFiles,
        maxRefreshRuns: options.maxRefreshRuns,
        maxTotalFileBytes: options.maxTotalFileBytes,
        rawArtifactDirs,
        rawArtifactLimits: DEFAULT_RAW_RESULT_LIMITS,
        skipLogs: options.skipLogs,
        skipRawArtifacts: options.skipRawArtifacts,
      },
    },
    pullRequest: {
      number: pr.number,
      url: pr.html_url,
      apiUrl: pr.url,
      title: redactSecrets(pr.title, io.env),
      body: truncateText(pr.body ?? '', TEXT_LIMIT, io.env),
      state: pr.state,
      isDraft: Boolean(pr.draft),
      author: {
        login: pr.user?.login ?? null,
        type: pr.user?.type ?? null,
      },
      base: {
        repo: pr.base?.repo?.full_name ?? repo,
        ref: pr.base?.ref ?? '',
        sha: baseSha,
      },
      head: {
        repo: pr.head?.repo?.full_name ?? null,
        ref: pr.head?.ref ?? '',
        sha: headSha,
      },
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    },
    changedFiles: files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      owner: ownersForPath(file.filename, codeownerRules),
      rawUrl: file.raw_url ?? null,
      blobUrl: file.blob_url ?? null,
      patch: file.patch
        ? {
            ...truncateText(file.patch, 40_000, io.env),
            sha256: hashText(file.patch),
          }
        : null,
    })),
    changedEvals,
    diff: {
      source: `gh pr diff ${options.prNumber} --repo ${repo} --color never`,
      sha256: hashText(rawDiff),
      ...diff,
    },
    sourceContext,
    discussion,
    linkedContext: {
      links,
      externalContext,
    },
    currentHeadCi: {
      headSha,
      checkRuns,
      statuses,
      actionsRuns,
    },
    evalRefreshRuns,
    rawResultEvidence,
    candidateInstructions,
    trustedSources: [
      {
        path: 'CONTRIBUTING.md#reviewing-an-eval',
        informed:
          'Eval rubric, refreshed-result expectations, and failure classification.',
      },
      {
        path: '.github/CODEOWNERS',
        informed:
          'Changed-file ownership for final human review routing. This collector does not modify CODEOWNERS.',
      },
      {
        path: '.github/workflows/eval-refresh.yml',
        informed:
          'Refresh-run artifact names, retention windows, result commit behavior, and CI evidence locations.',
      },
      {
        path: 'apps/framework/scripts/upload-braintrust.ts',
        informed:
          'Braintrust run summary links emitted into the eval-refresh job summary/logs.',
      },
    ],
    limitations: buildLimitations({
      diff,
      sourceContext,
      candidateInstructions,
      externalContext,
      evalRefreshRuns,
      rawResultEvidence,
    }),
  };
}

function rawArtifactDirsFromEnv(env = process.env) {
  return String(env.AI_REVIEW_RAW_ARTIFACT_DIRS ?? '')
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function currentRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function readCodeowners(io) {
  try {
    return parseCodeowners(await io.readLocalFile('.github/CODEOWNERS'));
  } catch {
    return [];
  }
}

async function collectCheckRuns(io, repo, headSha) {
  if (!headSha) return [];
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/commits/${headSha}/check-runs?per_page=100`
  );
  if (value.error) {
    return [
      {
        status: 'unavailable',
        reason: redactSecrets(value.error.message, io.env),
      },
    ];
  }
  return (value.check_runs ?? []).map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    detailsUrl: run.details_url,
    htmlUrl: run.html_url,
    app: run.app?.slug ?? run.app?.name ?? null,
  }));
}

async function collectStatuses(io, repo, headSha) {
  if (!headSha) return [];
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/commits/${headSha}/status`
  );
  if (value.error) {
    return [
      {
        status: 'unavailable',
        reason: redactSecrets(value.error.message, io.env),
      },
    ];
  }
  return (value.statuses ?? []).map((status) => ({
    context: status.context,
    state: status.state,
    description: redactSecrets(status.description ?? '', io.env),
    targetUrl: status.target_url,
    createdAt: status.created_at,
    updatedAt: status.updated_at,
  }));
}

async function collectActionsRuns(io, repo, headSha) {
  if (!headSha) return [];
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`
  );
  if (value.error) {
    return [
      {
        status: 'unavailable',
        reason: redactSecrets(value.error.message, io.env),
      },
    ];
  }
  return (value.workflow_runs ?? []).map((run) => summarizeWorkflowRun(run));
}

async function collectEvalRefreshRuns(io, repo, pr, options) {
  const branch = pr.head?.ref ?? '';
  const currentHeadSha = pr.head?.sha ?? '';
  const endpoint = branch
    ? `repos/${repo}/actions/workflows/eval-refresh.yml/runs?branch=${encodeURIComponent(branch)}&per_page=50`
    : `repos/${repo}/actions/workflows/eval-refresh.yml/runs?per_page=50`;
  const value = await githubJsonMaybe(io, endpoint);
  if (value.error) {
    return {
      workflow: '.github/workflows/eval-refresh.yml',
      status: 'unavailable',
      reason: redactSecrets(value.error.message, io.env),
      runs: [],
    };
  }

  const runs = [];
  for (const run of (value.workflow_runs ?? []).slice(
    0,
    options.maxRefreshRuns
  )) {
    const compare =
      run.head_sha && run.head_sha !== currentHeadSha
        ? await compareCommits(io, repo, run.head_sha, currentHeadSha)
        : null;
    const [artifacts, jobs] = await Promise.all([
      collectArtifacts(io, repo, run.id),
      collectJobs(io, repo, run.id),
    ]);
    const logEvidence = options.skipLogs
      ? {
          status: 'skipped',
          braintrustLinks: [],
          braintrustAllExperimentsLinks: [],
          sandboxLinks: [],
          limitations: [
            'Log parsing was disabled for this collector invocation.',
          ],
        }
      : collectRunLogEvidence(io, repo, run.id);

    runs.push({
      ...summarizeWorkflowRun(run),
      sourceRevision: {
        runHeadSha: run.head_sha,
        currentPrHeadSha: currentHeadSha,
        ...classifyRunCurrentness({
          runHeadSha: run.head_sha,
          currentHeadSha,
          compare,
        }),
      },
      artifacts,
      jobs,
      evidenceLinks: logEvidence,
    });
  }

  return {
    workflow: '.github/workflows/eval-refresh.yml',
    status: 'collected',
    runs,
  };
}

function summarizeWorkflowRun(run) {
  return {
    id: run.id,
    name: run.name,
    displayTitle: redactSecrets(run.display_title ?? '', process.env),
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

async function compareCommits(io, repo, fromSha, toSha) {
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/compare/${fromSha}...${toSha}`
  );
  return value.error ? null : value;
}

async function collectArtifacts(io, repo, runId) {
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`
  );
  if (value.error) {
    return [
      {
        status: 'unavailable',
        reason: redactSecrets(value.error.message, io.env),
      },
    ];
  }
  return (value.artifacts ?? []).map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    sizeInBytes: artifact.size_in_bytes,
    expired: Boolean(artifact.expired),
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
    archiveDownloadUrl: artifact.archive_download_url,
    expectedContents: expectedArtifactContents(artifact.name),
  }));
}

function expectedArtifactContents(name) {
  if (name === 'raw-results') {
    return {
      trusted: false,
      retentionDays: 3,
      layout:
        'raw-results-<experiment>__<eval>/<eval>/run-<n>/result.json and workspace.tgz; inspect without executing and with archive traversal/size guards.',
    };
  }
  if (name === 'eval-results-json') {
    return {
      trusted: true,
      retentionDays: 7,
      layout:
        'apps/web/src/data/*eval-results.json exported dashboard result files.',
    };
  }
  return null;
}

async function collectJobs(io, repo, runId) {
  const value = await githubJsonMaybe(
    io,
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`
  );
  if (value.error) {
    return [
      {
        status: 'unavailable',
        reason: redactSecrets(value.error.message, io.env),
      },
    ];
  }
  return (value.jobs ?? []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    htmlUrl: job.html_url,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  }));
}

function collectRunLogEvidence(io, repo, runId) {
  try {
    const log = io.gh(['run', 'view', String(runId), '--repo', repo, '--log'], {
      maxBuffer: 80 * 1024 * 1024,
    });
    return {
      status: 'collected',
      braintrustLinks: uniqueMatches(
        log,
        /https?:\/\/[^\s)]+braintrust[^\s)]*/gi
      ),
      braintrustAllExperimentsLinks: uniqueMatches(
        log,
        /https?:\/\/[^\s)]+braintrust[^\s)]*\/experiments\?search=[^\s)]*/gi
      ),
      sandboxLinks: uniqueMatches(
        log,
        /https:\/\/vercel\.com\/supabase\/evals\/sandboxes\/[^\s)]+/gi
      ),
      limitations: [],
    };
  } catch (error) {
    return {
      status: 'unavailable',
      braintrustLinks: [],
      braintrustAllExperimentsLinks: [],
      sandboxLinks: [],
      limitations: [redactSecrets(error.message, io.env)],
    };
  }
}

function uniqueMatches(text, regex) {
  return [...new Set(String(text).match(regex) ?? [])].map((url) =>
    url.replace(/[.,;:!?]+$/, '')
  );
}

async function collectCandidateInstructions(
  io,
  repo,
  headSha,
  instructionPaths
) {
  const paths = [...new Set(instructionPaths)];
  const files = [];
  for (const path of paths) {
    const result = await fetchFileAtRef(io, repo, path, headSha, 200_000);
    files.push({
      path,
      source: {
        repo,
        ref: headSha,
        trust: 'pr-head-candidate-instructions',
        noFallback: true,
      },
      ...result,
    });
  }
  return {
    status: 'collected',
    headSha,
    noFallbackToMain: true,
    files,
  };
}

async function collectSourceContext(io, repo, headSha, files, options) {
  const selected = selectSourceContextFiles(files, options);
  const collected = [];
  let totalBytes = 0;

  for (const path of selected) {
    if (collected.length >= options.maxFiles) break;
    if (totalBytes >= options.maxTotalFileBytes) {
      collected.push({
        path,
        source: {
          repo,
          ref: headSha,
          trust: 'pr-head-untrusted-content',
        },
        status: 'skipped',
        reason: `Skipped after reaching maxTotalFileBytes=${options.maxTotalFileBytes}.`,
      });
      continue;
    }
    const result = await fetchFileAtRef(
      io,
      repo,
      path,
      headSha,
      options.maxFileBytes
    );
    if (result.status === 'found') totalBytes += result.bytes;
    collected.push({
      path,
      source: {
        repo,
        ref: headSha,
        trust: 'pr-head-untrusted-content',
      },
      ...result,
    });
  }

  return {
    source: {
      repo,
      ref: headSha,
      trust: 'pr-head-untrusted-content',
    },
    selectedPaths: selected,
    files: collected,
    limits: {
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
      maxTotalFileBytes: options.maxTotalFileBytes,
    },
  };
}

async function fetchFileAtRef(io, repo, path, ref, maxBytes) {
  if (!ref) {
    return { status: 'missing', reason: 'No ref available.' };
  }
  const endpoint = `repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
  const value = await githubJsonMaybe(io, endpoint);
  if (value.error) {
    return {
      status: 'missing',
      reason: redactSecrets(value.error.message, io.env),
    };
  }
  if (value.type !== 'file' || value.encoding !== 'base64') {
    return {
      status: 'unsupported',
      reason: `GitHub contents response was ${value.type ?? 'unknown'} with ${value.encoding ?? 'no'} encoding.`,
    };
  }
  const text = Buffer.from(value.content ?? '', 'base64').toString('utf8');
  const truncated = truncateText(text, maxBytes, io.env);
  return {
    status: 'found',
    htmlUrl: value.html_url,
    gitBlobSha: value.sha,
    size: value.size,
    sha256: hashText(text),
    ...truncated,
  };
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function collectDiscussion(issueComments, reviews, reviewComments, env) {
  return {
    issueComments: issueComments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      htmlUrl: comment.html_url,
      body: truncateText(comment.body ?? '', TEXT_LIMIT, env).text,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      author: review.user?.login ?? null,
      state: review.state,
      submittedAt: review.submitted_at,
      htmlUrl: review.html_url,
      body: truncateText(review.body ?? '', TEXT_LIMIT, env).text,
    })),
    reviewComments: reviewComments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? null,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      htmlUrl: comment.html_url,
      body: truncateText(comment.body ?? '', TEXT_LIMIT, env).text,
    })),
  };
}

function dedupeLinks(links) {
  const seen = new Set();
  const deduped = [];
  for (const link of links) {
    const key = link.url ?? `${link.type}:${link.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}

function linksForType(links, type) {
  return links.filter(
    (link) => link.type === type || link.type === `${type}-key`
  );
}

async function collectExternalContext(io, links) {
  const linearLinks = links.filter(
    (link) => link.type === 'linear' || link.type === 'linear-key'
  );
  const slackLinks = links.filter((link) => link.type === 'slack');
  return [
    await collectLinearContext(io, linearLinks),
    await collectSlackContext(io, slackLinks),
  ];
}

async function collectLinearContext(io, links) {
  if (links.length === 0) {
    return { source: 'linear', status: 'not-linked', links: [], items: [] };
  }
  const token = io.env.LINEAR_API_KEY;
  if (!token) {
    return buildMissingAccess(
      'linear',
      'LINEAR_API_KEY is not available; preserved Linear links/keys without reading private issue context.',
      links
    );
  }

  const keys = [...new Set(links.map(linearKeyFromLink).filter(Boolean))].slice(
    0,
    10
  );
  const items = [];
  for (const key of keys) {
    try {
      const data = await io.fetchJson('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query Issue($id: String!) {
            issue(id: $id) {
              identifier
              title
              url
              state { name }
              description
              comments(first: 5) {
                nodes { body createdAt user { name displayName } }
              }
            }
          }`,
          variables: { id: key },
        }),
      });
      const issue = data?.data?.issue;
      if (!issue) {
        items.push({ key, status: 'missing' });
      } else {
        items.push({
          key,
          status: 'found',
          url: issue.url,
          title: redactSecrets(issue.title, io.env),
          state: issue.state?.name ?? null,
          description: truncateText(issue.description ?? '', TEXT_LIMIT, io.env)
            .text,
          comments: (issue.comments?.nodes ?? []).map((comment) => ({
            author: comment.user?.displayName ?? comment.user?.name ?? null,
            createdAt: comment.createdAt,
            body: truncateText(comment.body ?? '', TEXT_LIMIT, io.env).text,
          })),
        });
      }
    } catch (error) {
      items.push({
        key,
        status: 'unavailable',
        reason: redactSecrets(error.message, io.env),
      });
    }
  }
  return { source: 'linear', status: 'collected', links, items };
}

function linearKeyFromLink(link) {
  if (link.key) return link.key;
  const url = link.url ?? '';
  const match = /\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\/|$)/i.exec(url);
  return match?.[1]?.toUpperCase() ?? null;
}

async function collectSlackContext(io, links) {
  if (links.length === 0) {
    return { source: 'slack', status: 'not-linked', links: [], items: [] };
  }
  const token = io.env.SLACK_BOT_TOKEN || io.env.SLACK_USER_TOKEN;
  if (!token) {
    return buildMissingAccess(
      'slack',
      'SLACK_BOT_TOKEN or SLACK_USER_TOKEN is not available; preserved Slack links without reading private thread context.',
      links
    );
  }

  const items = [];
  for (const link of links.slice(0, 10)) {
    const parsed = parseSlackArchiveUrl(link.url);
    if (!parsed) {
      items.push({ url: link.url, status: 'unsupported-url' });
      continue;
    }
    try {
      const url = new URL('https://slack.com/api/conversations.replies');
      url.searchParams.set('channel', parsed.channel);
      url.searchParams.set('ts', parsed.ts);
      url.searchParams.set('limit', '10');
      const data = await io.fetchJson(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!data?.ok) {
        items.push({
          url: link.url,
          status: 'unavailable',
          reason: redactSecrets(
            data?.error ?? 'Slack API returned ok=false',
            io.env
          ),
        });
        continue;
      }
      items.push({
        url: link.url,
        status: 'found',
        channel: parsed.channel,
        ts: parsed.ts,
        messages: (data.messages ?? []).map((message) => ({
          user: message.user ?? message.username ?? null,
          ts: message.ts,
          text: truncateText(message.text ?? '', TEXT_LIMIT, io.env).text,
        })),
      });
    } catch (error) {
      items.push({
        url: link.url,
        status: 'unavailable',
        reason: redactSecrets(error.message, io.env),
      });
    }
  }
  return { source: 'slack', status: 'collected', links, items };
}

function parseSlackArchiveUrl(url) {
  const match = /\/archives\/([^/]+)\/p(\d{10})(\d{6})/.exec(url ?? '');
  if (!match) return null;
  return { channel: match[1], ts: `${match[2]}.${match[3]}` };
}

function buildLimitations({
  diff,
  sourceContext,
  candidateInstructions,
  externalContext,
  evalRefreshRuns,
  rawResultEvidence,
}) {
  const limitations = [];
  if (diff.truncated) {
    limitations.push({
      type: 'diff-truncated',
      message: `Diff was truncated at collector limit; full diff bytes=${diff.bytes}.`,
    });
  }
  for (const file of sourceContext.files) {
    if (file.truncated) {
      limitations.push({
        type: 'source-file-truncated',
        path: file.path,
        message: `Source context was truncated at collector limit; full bytes=${file.bytes}.`,
      });
    }
    if (file.status !== 'found') {
      limitations.push({
        type: 'source-file-missing',
        path: file.path,
        message: file.reason ?? file.status,
      });
    }
  }
  for (const file of candidateInstructions.files) {
    if (file.status !== 'found') {
      limitations.push({
        type: 'candidate-instruction-missing',
        path: file.path,
        message:
          'Candidate instruction was not present at the exact PR head commit; collector did not fall back to main.',
      });
    }
  }
  for (const context of externalContext) {
    if (context.status === 'missing-access') {
      limitations.push({
        type: `${context.source}-missing-access`,
        message: context.reason,
      });
    }
  }
  for (const run of evalRefreshRuns.runs ?? []) {
    if (!run.sourceRevision?.current) {
      limitations.push({
        type: 'stale-eval-refresh-run',
        runId: run.id,
        message: run.sourceRevision?.explanation,
      });
    }
    for (const artifact of run.artifacts ?? []) {
      if (artifact.expired) {
        limitations.push({
          type: 'expired-artifact',
          runId: run.id,
          artifact: artifact.name,
          message: `${artifact.name} expired at ${artifact.expiresAt}.`,
        });
      }
    }
    if (run.evidenceLinks?.status === 'unavailable') {
      limitations.push({
        type: 'run-log-unavailable',
        runId: run.id,
        message: run.evidenceLinks.limitations?.join('; '),
      });
    }
  }
  for (const limitation of rawResultEvidence?.limitations ?? []) {
    limitations.push({
      type: `raw-result-${limitation.type ?? 'limitation'}`,
      runId: limitation.runId,
      path: limitation.path,
      message: limitation.message ?? limitation.reason ?? limitation.type,
    });
  }
  return limitations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const evidence = await collectEvidence(options);
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.outputPath) {
    const output = resolve(options.outputPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    console.error(`Wrote ${output}`);
  } else {
    process.stdout.write(json);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(redactSecrets(error.stack || error.message));
    process.exitCode = 1;
  });
}

export { collectEvidence, parseArgs, parseSlackArchiveUrl };
