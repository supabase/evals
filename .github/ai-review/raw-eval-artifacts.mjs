import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path, { basename, dirname, join, relative, resolve } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { redactSecrets } from './redact-review-evidence.mjs';

export const DEFAULT_RAW_RESULT_LIMITS = {
  maxArchiveBytes: 80 * 1024 * 1024,
  maxArchiveEntries: 2_000,
  maxArchiveTotalUncompressedBytes: 120 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxResultFiles: 64,
  maxSelectedResults: 24,
  maxSuccessesPerEval: 1,
  maxFailureShapes: 16,
  maxChecks: 24,
  maxToolCalls: 8,
  maxToolCallBytes: 3_000,
  maxTranscriptEntries: 8,
  maxTranscriptEntryBytes: 3_000,
  maxTranscriptBytes: 18_000,
  maxWorkspaceFiles: 4,
  maxWorkspaceFileBytes: 12_000,
};

const BRAINTRUST_TRACE_LIMITATION = {
  type: 'braintrust-trace-not-loaded',
  message:
    'Collector records Braintrust URLs from workflow logs when present, but does not infer or load trace contents unless the trace payload is actually available; raw result artifacts are used as fallback evidence.',
};

export function buildSkippedRawResultEvidence(reason, changedEvals = []) {
  return {
    status: 'skipped',
    strategy: 'raw-results-artifact-fallback',
    reason,
    braintrustTraceAccess: {
      status: 'not-loaded',
      reason: BRAINTRUST_TRACE_LIMITATION.message,
    },
    changedEvals: summarizeChangedEvals(changedEvals),
    limits: DEFAULT_RAW_RESULT_LIMITS,
    sources: [],
    selectedResultPaths: [],
    failedCheckShapes: [],
    results: [],
    limitations: [
      { type: 'raw-result-evidence-skipped', message: reason },
      BRAINTRUST_TRACE_LIMITATION,
    ],
  };
}

export async function collectRawResultEvidence({
  repo = '',
  runs = [],
  changedEvals = [],
  rawArtifactDirs = [],
  io = {},
  env = process.env,
  limits = {},
} = {}) {
  const effectiveLimits = { ...DEFAULT_RAW_RESULT_LIMITS, ...limits };
  const changedEvalIds = new Set(
    summarizeChangedEvals(changedEvals)
      .map((evalInfo) => evalInfo.id)
      .filter(Boolean)
  );
  const limitations = [BRAINTRUST_TRACE_LIMITATION];
  const sources = [];
  const candidates = [];

  if (changedEvalIds.size === 0) {
    limitations.push({
      type: 'no-changed-evals',
      message:
        'No changed eval ids were available, so raw result artifacts were not selected.',
    });
    return buildRawEvidencePacket({
      status: 'missing',
      changedEvals,
      limits: effectiveLimits,
      sources,
      results: [],
      limitations,
    });
  }

  for (const run of runs ?? []) {
    const matchingLocalDirs = localDirsForRun(rawArtifactDirs, run);
    for (const dir of matchingLocalDirs) {
      const source = {
        type: 'local-directory',
        path: dir,
        runId: run.id,
        headSha: run.headSha,
        sourceRevision: run.sourceRevision ?? null,
      };
      const result = await readRawResultSource({
        source,
        changedEvalIds,
        env,
        limits: effectiveLimits,
      });
      sources.push(result.source);
      candidates.push(...result.results);
      limitations.push(...result.limitations);
    }

    if (matchingLocalDirs.length > 0) continue;

    const rawArtifacts = (run.artifacts ?? []).filter(
      (artifact) => artifact?.name === 'raw-results'
    );
    if (rawArtifacts.length === 0) {
      sources.push({
        runId: run.id,
        headSha: run.headSha,
        sourceRevision: run.sourceRevision ?? null,
        status: 'missing',
        reason:
          'No raw-results artifact metadata was present for this refresh run.',
      });
      limitations.push({
        type: 'raw-results-artifact-missing',
        runId: run.id,
        message:
          'No raw-results artifact metadata was present for this refresh run.',
      });
      continue;
    }

    for (const artifact of rawArtifacts) {
      if (artifact.expired) {
        sources.push({
          runId: run.id,
          headSha: run.headSha,
          sourceRevision: run.sourceRevision ?? null,
          artifact: summarizeArtifact(artifact),
          status: 'expired',
          reason: `${artifact.name} expired at ${artifact.expiresAt ?? 'unknown time'}.`,
        });
        limitations.push({
          type: 'raw-results-artifact-expired',
          runId: run.id,
          artifact: artifact.name,
          message: `${artifact.name} expired at ${artifact.expiresAt ?? 'unknown time'}.`,
        });
        continue;
      }

      if (!artifact.archiveDownloadUrl) {
        sources.push({
          runId: run.id,
          headSha: run.headSha,
          sourceRevision: run.sourceRevision ?? null,
          artifact: summarizeArtifact(artifact),
          status: 'missing',
          reason:
            'The artifact metadata did not include an archive download URL.',
        });
        limitations.push({
          type: 'raw-results-artifact-download-url-missing',
          runId: run.id,
          artifact: artifact.name,
          message:
            'The artifact metadata did not include an archive download URL.',
        });
        continue;
      }

      if (typeof io.ghBuffer !== 'function') {
        sources.push({
          runId: run.id,
          headSha: run.headSha,
          sourceRevision: run.sourceRevision ?? null,
          artifact: summarizeArtifact(artifact),
          status: 'unavailable',
          reason: 'Collector IO does not support binary artifact downloads.',
        });
        limitations.push({
          type: 'raw-results-artifact-download-unavailable',
          runId: run.id,
          artifact: artifact.name,
          message: 'Collector IO does not support binary artifact downloads.',
        });
        continue;
      }

      try {
        const buffer = io.ghBuffer(['api', artifact.archiveDownloadUrl], {
          maxBuffer: effectiveLimits.maxArchiveBytes + 1,
        });
        if (buffer.byteLength > effectiveLimits.maxArchiveBytes) {
          throw new Error(
            `Downloaded artifact bytes=${buffer.byteLength} exceeded maxArchiveBytes=${effectiveLimits.maxArchiveBytes}.`
          );
        }
        const source = {
          type: 'github-artifact-zip',
          repo,
          runId: run.id,
          headSha: run.headSha,
          sourceRevision: run.sourceRevision ?? null,
          artifact: summarizeArtifact(artifact),
        };
        const result = await readRawResultSource({
          source,
          buffer,
          changedEvalIds,
          env,
          limits: effectiveLimits,
        });
        sources.push(result.source);
        candidates.push(...result.results);
        limitations.push(...result.limitations);
      } catch (error) {
        sources.push({
          runId: run.id,
          headSha: run.headSha,
          sourceRevision: run.sourceRevision ?? null,
          artifact: summarizeArtifact(artifact),
          status: 'unavailable',
          reason: redactSecrets(error.message, env),
        });
        limitations.push({
          type: 'raw-results-artifact-download-failed',
          runId: run.id,
          artifact: artifact.name,
          message: redactSecrets(error.message, env),
        });
      }
    }
  }

  const selection = selectRepresentativeResults(candidates, effectiveLimits);
  limitations.push(...selection.limitations);

  return buildRawEvidencePacket({
    status: selection.results.length > 0 ? 'collected' : 'missing',
    changedEvals,
    limits: effectiveLimits,
    sources,
    results: selection.results,
    failedCheckShapes: selection.failedCheckShapes,
    limitations,
  });
}

export async function readRawResultSource({
  source,
  buffer = null,
  changedEvalIds = new Set(),
  env = process.env,
  limits = DEFAULT_RAW_RESULT_LIMITS,
} = {}) {
  const effectiveLimits = { ...DEFAULT_RAW_RESULT_LIMITS, ...limits };
  const limitations = [];
  const entries =
    source.type === 'local-directory'
      ? await readDirectoryEntries(source.path, effectiveLimits, limitations)
      : readZipEntries(buffer, effectiveLimits, limitations);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const resultEntries = entries
    .filter(
      (entry) =>
        entry.path.endsWith('/result.json') || entry.path === 'result.json'
    )
    .slice(0, effectiveLimits.maxResultFiles);
  const results = [];

  if (resultEntries.length === effectiveLimits.maxResultFiles) {
    limitations.push({
      type: 'raw-result-file-limit',
      source: describeSource(source),
      message: `Stopped after maxResultFiles=${effectiveLimits.maxResultFiles}.`,
    });
  }

  for (const entry of resultEntries) {
    const result = summarizeResultEntry({
      entry,
      byPath,
      source,
      changedEvalIds,
      env,
      limits: effectiveLimits,
      limitations,
    });
    if (result) results.push(result);
  }

  return {
    source: {
      ...source,
      status: results.length > 0 ? 'collected' : 'missing-matching-results',
      resultFileCount: resultEntries.length,
      selectedResultCount: results.length,
      limitations,
    },
    results,
    limitations,
  };
}

export function readZipEntries(
  buffer,
  limits = DEFAULT_RAW_RESULT_LIMITS,
  limitations = []
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Zip reader requires a Buffer.');
  }
  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw new Error(
      `Zip archive bytes=${buffer.byteLength} exceeded maxArchiveBytes=${limits.maxArchiveBytes}.`
    );
  }

  const entries = [];
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0)
    throw new Error('Zip end-of-central-directory record was not found.');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > limits.maxArchiveEntries) {
    throw new Error(
      `Zip entry count=${totalEntries} exceeded maxArchiveEntries=${limits.maxArchiveEntries}.`
    );
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.byteLength) {
    throw new Error('Zip central directory extends past the archive boundary.');
  }

  let offset = centralDirectoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid zip central directory header.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    offset = nameStart + nameLength + extraLength + commentLength;

    const normalized = normalizeArchivePath(name);
    if (!normalized || isUnsafeArchivePath(name)) {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: name,
        message:
          'Rejected absolute, traversal, or platform-specific archive path.',
      });
      continue;
    }
    if (isZipSymlink(externalAttributes)) {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: normalized,
        message: 'Rejected symlink entry from zip archive.',
      });
      continue;
    }
    if (normalized.endsWith('/')) continue;
    if ((flags & 1) === 1) {
      limitations.push({
        type: 'unsupported-archive-entry',
        path: normalized,
        message: 'Encrypted zip entries are not read.',
      });
      continue;
    }
    if (method !== 0 && method !== 8) {
      limitations.push({
        type: 'unsupported-archive-entry',
        path: normalized,
        message: `Unsupported zip compression method ${method}.`,
      });
      continue;
    }
    if (uncompressedSize > limits.maxFileBytes) {
      limitations.push({
        type: 'archive-entry-too-large',
        path: normalized,
        message: `Entry bytes=${uncompressedSize} exceeded maxFileBytes=${limits.maxFileBytes}.`,
      });
      continue;
    }
    if (!isInterestingRawEntry(normalized)) continue;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxArchiveTotalUncompressedBytes) {
      throw new Error(
        `Zip uncompressed bytes exceeded maxArchiveTotalUncompressedBytes=${limits.maxArchiveTotalUncompressedBytes}.`
      );
    }

    const data = readZipEntryData({
      buffer,
      localHeaderOffset,
      compressedSize,
      uncompressedSize,
      method,
      path: normalized,
    });
    entries.push({ path: normalized, data, bytes: data.byteLength });
  }

  return entries;
}

export function readTgzEntries(
  buffer,
  limits = DEFAULT_RAW_RESULT_LIMITS,
  limitations = []
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Tgz reader requires a Buffer.');
  }
  if (buffer.byteLength > limits.maxArchiveBytes) {
    throw new Error(
      `Tgz archive bytes=${buffer.byteLength} exceeded maxArchiveBytes=${limits.maxArchiveBytes}.`
    );
  }

  const tar = gunzipSync(buffer, {
    maxOutputLength: limits.maxArchiveTotalUncompressedBytes + 1,
  });
  if (tar.byteLength > limits.maxArchiveTotalUncompressedBytes) {
    throw new Error(
      `Tgz uncompressed bytes exceeded maxArchiveTotalUncompressedBytes=${limits.maxArchiveTotalUncompressedBytes}.`
    );
  }
  return readTarEntries(tar, limits, limitations);
}

export function isUnsafeArchivePath(entryPath) {
  if (
    !entryPath ||
    entryPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(entryPath)
  )
    return true;
  if (entryPath.includes('\\')) return true;
  const normalized = path.posix.normalize(entryPath);
  return (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  );
}

function buildRawEvidencePacket({
  status,
  changedEvals,
  limits,
  sources,
  results,
  failedCheckShapes = [],
  limitations,
}) {
  return {
    status,
    strategy: 'raw-results-artifact-fallback',
    braintrustTraceAccess: {
      status: 'not-loaded',
      reason: BRAINTRUST_TRACE_LIMITATION.message,
    },
    changedEvals: summarizeChangedEvals(changedEvals),
    limits,
    sources,
    selectedResultPaths: results.map((result) => result.resultPath),
    failedCheckShapes,
    results,
    limitations: dedupeLimitations(limitations),
  };
}

function summarizeChangedEvals(changedEvals) {
  return (changedEvals ?? [])
    .map((evalInfo) => ({
      suite: evalInfo.suite ?? null,
      id: evalInfo.id,
      paths: Array.isArray(evalInfo.paths) ? evalInfo.paths : [],
    }))
    .filter(
      (evalInfo) => typeof evalInfo.id === 'string' && evalInfo.id.length > 0
    );
}

function localDirsForRun(rawArtifactDirs, run) {
  const runId = String(run.id ?? '');
  return [...new Set(rawArtifactDirs ?? [])].filter((dir) => {
    const name = basename(resolve(dir));
    if (runId && name.includes(runId)) return true;
    return !/\d{6,}/.test(name);
  });
}

async function readDirectoryEntries(root, limits, limitations) {
  const rootPath = resolve(root);
  const entries = [];
  let visited = 0;
  await walk(rootPath);
  return entries;

  async function walk(currentPath) {
    if (visited >= limits.maxArchiveEntries) {
      limitations.push({
        type: 'archive-entry-limit',
        path: relative(rootPath, currentPath),
        message: `Stopped after maxArchiveEntries=${limits.maxArchiveEntries}.`,
      });
      return;
    }
    visited += 1;

    const info = await lstat(currentPath);
    const rel = normalizeArchivePath(
      relative(rootPath, currentPath).split(path.sep).join('/')
    );
    if (info.isSymbolicLink()) {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: rel,
        message: 'Rejected symlink from local artifact directory.',
      });
      return;
    }
    if (info.isDirectory()) {
      const children = await readdir(currentPath);
      for (const child of children) await walk(join(currentPath, child));
      return;
    }
    if (!info.isFile()) return;
    if (!rel || isUnsafeArchivePath(rel)) {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: rel,
        message: 'Rejected unsafe local artifact path.',
      });
      return;
    }
    if (!isInterestingRawEntry(rel)) return;
    if (info.size > limits.maxFileBytes) {
      limitations.push({
        type: 'archive-entry-too-large',
        path: rel,
        message: `Entry bytes=${info.size} exceeded maxFileBytes=${limits.maxFileBytes}.`,
      });
      return;
    }
    const data = await readFile(currentPath);
    entries.push({ path: rel, data, bytes: data.byteLength });
  }
}

function isInterestingRawEntry(entryPath) {
  return (
    entryPath.endsWith('/result.json') ||
    entryPath === 'result.json' ||
    entryPath.endsWith('/session-archive.tar.gz') ||
    entryPath.endsWith('/workspace.tgz')
  );
}

function summarizeResultEntry({
  entry,
  byPath,
  source,
  changedEvalIds,
  env,
  limits,
  limitations,
}) {
  let raw;
  try {
    raw = JSON.parse(entry.data.toString('utf8'));
  } catch (error) {
    limitations.push({
      type: 'raw-result-json-invalid',
      path: entry.path,
      message: redactSecrets(error.message, env),
    });
    return null;
  }

  if (changedEvalIds.size > 0 && !changedEvalIds.has(raw.eval)) return null;

  const checks = summarizeChecks(raw.checks, env, limits);
  const failedCheckNames = checks.failed.map((check) => check.name);
  const transcript = summarizeTranscript(
    raw.transcript,
    'result.json#transcript',
    env,
    limits
  );
  if (transcript.status !== 'found') {
    const sessionEntry = byPath.get(
      `${dirname(entry.path)}/session-archive.tar.gz`
    );
    if (sessionEntry) {
      transcript.fallback = summarizeSessionArchive(
        sessionEntry,
        env,
        limits,
        limitations
      );
    }
  }

  const workspaceExcerpts =
    transcript.status === 'found'
      ? []
      : summarizeWorkspaceExcerpts(
          byPath.get(`${dirname(entry.path)}/workspace.tgz`),
          env,
          limits,
          limitations
        );

  return {
    source: {
      type: source.type,
      path: source.path ?? null,
      repo: source.repo ?? null,
      runId: source.runId ?? null,
      headSha: source.headSha ?? null,
      sourceRevision: source.sourceRevision ?? null,
      artifact: source.artifact ?? null,
    },
    resultPath: entry.path,
    resultSha256: sha256(entry.data),
    experiment: asString(raw.experiment),
    experimentSuite: asString(raw.experimentSuite),
    eval: asString(raw.eval),
    run: raw.run ?? null,
    passed: raw.passed === true,
    stage: asString(raw.stage),
    interface: asString(raw.interface),
    cliVersion: asString(raw.cliVersion),
    checks,
    failedCheckShape:
      failedCheckNames.length > 0
        ? {
            eval: asString(raw.eval),
            key: sha256(Buffer.from(failedCheckNames.join('\n'))),
            failedCheckNames,
            representativeResultPath: entry.path,
            experiment: asString(raw.experiment),
            run: raw.run ?? null,
          }
        : null,
    toolCalls: summarizeToolCalls(raw.toolCalls, env, limits),
    transcript,
    workspaceExcerpts,
    agentReport: truncateText(
      raw.agentReport ?? '',
      limits.maxTranscriptEntryBytes,
      env
    ),
    stoppedReason: raw.stoppedReason ?? null,
    usage: summarizeUsage(raw.usage),
    stepCount: Number.isFinite(raw.stepCount) ? raw.stepCount : null,
    toolCallCount: Number.isFinite(raw.toolCallCount)
      ? raw.toolCallCount
      : null,
  };
}

function summarizeChecks(rawChecks, env, limits) {
  const checks = Array.isArray(rawChecks) ? rawChecks : [];
  const summarized = checks.map((check) => ({
    name: asString(check?.name),
    passed: check?.passed === true,
    notes: check?.notes ? truncateText(check.notes, 1_200, env) : null,
    judgeNotes: check?.judgeNotes
      ? truncateText(check.judgeNotes, 1_200, env)
      : null,
  }));
  const selectedIndexes = new Set();
  summarized.forEach((check, index) => {
    if (!check.passed) selectedIndexes.add(index);
    if (/truth|explain|metric/i.test(check.name)) selectedIndexes.add(index);
  });
  if (selectedIndexes.size === 0) {
    for (
      let index = 0;
      index < Math.min(summarized.length, limits.maxChecks);
      index += 1
    ) {
      selectedIndexes.add(index);
    }
  }
  const selected = [...selectedIndexes]
    .sort((a, b) => a - b)
    .slice(0, limits.maxChecks)
    .map((index) => summarized[index]);
  return {
    total: summarized.length,
    passed: summarized.filter((check) => check.passed).length,
    failed: summarized.filter((check) => !check.passed),
    selected,
    truncated:
      selected.length < selectedIndexes.size ||
      summarized.length > limits.maxChecks,
  };
}

function summarizeToolCalls(rawToolCalls, env, limits) {
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
  const indexes = selectEdgeIndexes(toolCalls.length, limits.maxToolCalls);
  return {
    total: toolCalls.length,
    selected: indexes.map((index) =>
      summarizeToolCall(toolCalls[index], env, limits)
    ),
    truncated: toolCalls.length > indexes.length,
  };
}

function summarizeToolCall(toolCall, env, limits) {
  const command =
    toolCall?.command ??
    toolCall?.input?.command ??
    toolCall?.body?.command ??
    '';
  const output = toolCall?.result ?? toolCall?.output ?? '';
  return {
    name: toolCall?.name ?? toolCall?.tool?.toolName ?? null,
    toolKind: toolCall?.tool?.kind ?? null,
    command: command
      ? truncateText(command, limits.maxToolCallBytes, env)
      : null,
    output: output ? truncateText(output, limits.maxToolCallBytes, env) : null,
  };
}

function summarizeTranscript(rawTranscript, transcriptSource, env, limits) {
  if (!Array.isArray(rawTranscript)) {
    return {
      status: 'missing',
      source: transcriptSource,
      totalEntries: 0,
      selected: [],
      truncated: false,
    };
  }
  const indexes = selectEdgeIndexes(
    rawTranscript.length,
    limits.maxTranscriptEntries
  );
  let bytes = 0;
  const selected = [];
  for (const index of indexes) {
    const entry = summarizeTranscriptEntry(rawTranscript[index], env, limits);
    const entryBytes = JSON.stringify(entry).length;
    if (bytes + entryBytes > limits.maxTranscriptBytes) break;
    bytes += entryBytes;
    selected.push(entry);
  }
  return {
    status: 'found',
    source: transcriptSource,
    totalEntries: rawTranscript.length,
    selected,
    truncated: rawTranscript.length > selected.length,
  };
}

function summarizeTranscriptEntry(entry, env, limits) {
  const text =
    entry?.content ??
    entry?.output ??
    entry?.result ??
    entry?.input?.command ??
    entry?.command ??
    '';
  return {
    type: entry?.type ?? null,
    role: entry?.role ?? null,
    name: entry?.name ?? entry?.toolName ?? null,
    text: text ? truncateText(text, limits.maxTranscriptEntryBytes, env) : null,
  };
}

function summarizeSessionArchive(entry, env, limits, limitations) {
  try {
    const entries = readTgzEntries(entry.data, limits, limitations).filter(
      (archiveEntry) => archiveEntry.path.endsWith('.jsonl')
    );
    const jsonl = entries[0];
    if (!jsonl) {
      return {
        status: 'missing',
        source: entry.path,
        selected: [],
        totalEntries: 0,
      };
    }
    const parsed = [];
    for (const line of jsonl.data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line));
      } catch {
        parsed.push({ type: 'raw', content: line });
      }
    }
    return summarizeTranscript(parsed, `${entry.path}#jsonl`, env, limits);
  } catch (error) {
    limitations.push({
      type: 'session-archive-unavailable',
      path: entry.path,
      message: redactSecrets(error.message, env),
    });
    return {
      status: 'unavailable',
      source: entry.path,
      selected: [],
      totalEntries: 0,
    };
  }
}

function summarizeWorkspaceExcerpts(entry, env, limits, limitations) {
  if (!entry) return [];
  try {
    const excerpts = [];
    const entries = readTgzEntries(entry.data, limits, limitations).filter(
      (archiveEntry) => isRelevantWorkspacePath(archiveEntry.path)
    );
    for (const archiveEntry of entries.slice(0, limits.maxWorkspaceFiles)) {
      excerpts.push({
        path: archiveEntry.path,
        ...truncateText(
          archiveEntry.data.toString('utf8'),
          limits.maxWorkspaceFileBytes,
          env
        ),
      });
    }
    return excerpts;
  } catch (error) {
    limitations.push({
      type: 'workspace-archive-unavailable',
      path: entry.path,
      message: redactSecrets(error.message, env),
    });
    return [];
  }
}

function isRelevantWorkspacePath(entryPath) {
  return (
    entryPath.endsWith('/supabase/config.toml') ||
    entryPath.endsWith('/package.json') ||
    entryPath.endsWith('/README.md') ||
    entryPath.endsWith('.log') ||
    entryPath.endsWith('.txt')
  );
}

function selectRepresentativeResults(candidates, limits) {
  const results = [];
  const failedCheckShapes = [];
  const seenSuccesses = new Map();
  const seenFailureShapes = new Set();
  const limitations = [];
  const sorted = [...candidates].sort((a, b) =>
    `${a.eval}:${a.experiment}:${a.run}:${a.resultPath}`.localeCompare(
      `${b.eval}:${b.experiment}:${b.run}:${b.resultPath}`
    )
  );

  for (const result of sorted) {
    if (!result.passed || results.length >= limits.maxSelectedResults) continue;
    const count = seenSuccesses.get(result.eval) ?? 0;
    if (count >= limits.maxSuccessesPerEval) continue;
    seenSuccesses.set(result.eval, count + 1);
    results.push(result);
  }

  for (const result of sorted) {
    if (!result.failedCheckShape || results.length >= limits.maxSelectedResults)
      continue;
    const shapeKey = `${result.eval}:${result.failedCheckShape.key}`;
    if (seenFailureShapes.has(shapeKey)) continue;
    if (failedCheckShapes.length >= limits.maxFailureShapes) {
      limitations.push({
        type: 'failed-check-shape-limit',
        message: `Stopped after maxFailureShapes=${limits.maxFailureShapes}.`,
      });
      break;
    }
    seenFailureShapes.add(shapeKey);
    failedCheckShapes.push({
      eval: result.eval,
      key: result.failedCheckShape.key,
      failedCheckNames: result.failedCheckShape.failedCheckNames,
      representativeResultPath: result.resultPath,
      experiment: result.experiment,
      run: result.run,
    });
    results.push(result);
  }

  if (candidates.length > results.length) {
    limitations.push({
      type: 'raw-results-selection-omitted',
      message: `Selected ${results.length} representative raw results from ${candidates.length} matching result files.`,
      selected: results.length,
      total: candidates.length,
    });
  }

  return { results, failedCheckShapes, limitations };
}

function selectEdgeIndexes(length, max) {
  if (length <= 0 || max <= 0) return [];
  if (length <= max) return Array.from({ length }, (_, index) => index);
  const head = Math.max(1, Math.floor(max / 3));
  const tail = max - head;
  const indexes = new Set();
  for (let index = 0; index < head; index += 1) indexes.add(index);
  for (let index = Math.max(head, length - tail); index < length; index += 1)
    indexes.add(index);
  return [...indexes].sort((a, b) => a - b);
}

function readTarEntries(tar, limits, limitations) {
  const entries = [];
  let offset = 0;
  let count = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    count += 1;
    if (count > limits.maxArchiveEntries) {
      throw new Error(
        `Tar entry count exceeded maxArchiveEntries=${limits.maxArchiveEntries}.`
      );
    }

    const name = tarString(header, 0, 100);
    const size = Number.parseInt(tarString(header, 124, 12).trim() || '0', 8);
    const typeflag = tarString(header, 156, 1) || '0';
    const prefix = tarString(header, 345, 155);
    const entryPath = normalizeArchivePath(prefix ? `${prefix}/${name}` : name);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength)
      throw new Error('Tar entry extends past archive boundary.');
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (!entryPath || isUnsafeArchivePath(entryPath)) {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: entryPath || name,
        message: 'Rejected absolute or traversal tar entry.',
      });
      continue;
    }
    if (typeflag === '2' || typeflag === '1') {
      limitations.push({
        type: 'unsafe-archive-entry',
        path: entryPath,
        message: 'Rejected tar link entry.',
      });
      continue;
    }
    if (typeflag === '5') continue;
    if (typeflag !== '0' && typeflag !== '\0') {
      limitations.push({
        type: 'unsupported-archive-entry',
        path: entryPath,
        message: `Unsupported tar entry type ${JSON.stringify(typeflag)}.`,
      });
      continue;
    }
    if (size > limits.maxFileBytes) {
      limitations.push({
        type: 'archive-entry-too-large',
        path: entryPath,
        message: `Entry bytes=${size} exceeded maxFileBytes=${limits.maxFileBytes}.`,
      });
      continue;
    }
    if (
      !isInterestingRawEntry(entryPath) &&
      !entryPath.endsWith('.jsonl') &&
      !isRelevantWorkspacePath(entryPath)
    ) {
      continue;
    }
    entries.push({
      path: entryPath,
      data: tar.subarray(dataStart, dataEnd),
      bytes: size,
    });
  }
  return entries;
}

function readZipEntryData({
  buffer,
  localHeaderOffset,
  compressedSize,
  uncompressedSize,
  method,
  path: entryPath,
}) {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error(`Invalid local zip header for ${entryPath}.`);
  }
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.byteLength) {
    throw new Error(`Zip entry ${entryPath} extends past archive boundary.`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (method === 0) return compressed;
  const inflated = inflateRawSync(compressed, {
    maxOutputLength: uncompressedSize + 1,
  });
  if (inflated.byteLength !== uncompressedSize) {
    throw new Error(`Zip entry ${entryPath} inflated to an unexpected size.`);
  }
  return inflated;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function isZipSymlink(externalAttributes) {
  const mode = (externalAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function normalizeArchivePath(entryPath) {
  const normalized = path.posix.normalize(String(entryPath ?? ''));
  return normalized === '.' ? '' : normalized;
}

function tarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end >= 0 ? end : slice.length).toString('utf8');
}

function summarizeArtifact(artifact) {
  return {
    id: artifact.id ?? null,
    name: artifact.name ?? null,
    sizeInBytes: artifact.sizeInBytes ?? artifact.size_in_bytes ?? null,
    expired: Boolean(artifact.expired),
    expiresAt: artifact.expiresAt ?? artifact.expires_at ?? null,
  };
}

function summarizeUsage(usage) {
  if (!Array.isArray(usage)) return [];
  return usage.map((item) => ({
    model: item.model ?? null,
    inputTokens: item.inputTokens ?? null,
    outputTokens: item.outputTokens ?? null,
    cacheReadInputTokens: item.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: item.cacheWriteInputTokens ?? null,
  }));
}

function dedupeLimitations(limitations) {
  const seen = new Set();
  const deduped = [];
  for (const limitation of limitations) {
    const key = JSON.stringify(limitation);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(limitation);
  }
  return deduped;
}

function describeSource(source) {
  return source.path ?? `${source.type}:${source.runId ?? 'unknown-run'}`;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function truncateText(value, maxBytes, env) {
  const redacted = redactSecrets(value, env);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  if (bytes <= maxBytes) return { text: redacted, bytes, truncated: false };
  return {
    text: `${Buffer.from(redacted, 'utf8').subarray(0, maxBytes).toString('utf8')}\n...[truncated after ${maxBytes} bytes]`,
    bytes,
    truncated: true,
  };
}
