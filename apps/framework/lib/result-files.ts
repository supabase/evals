/**
 * Shared access to the raw run files under `results/`.
 *
 * Both destinations read through here — `export-results.ts` (the committed
 * results JSON) and `upload-braintrust.ts` (Braintrust experiments) — so the
 * two can never disagree about which runs exist.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import {
  evalSuiteSchema,
  rawEvalResultSchema,
} from '@supabase-evals/core/eval-metadata';
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
  type ExperimentDisplayMetadata,
} from '@supabase-evals/core';
import type { ExperimentSuite } from '@supabase-evals/core/eval-metadata';
import { discoverExperimentFiles } from './experiment-files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..', '..', '..');
const RESULTS_DIR = join(ROOT, 'results');
const EVALS_DIR = join(ROOT, 'evals');
const EXPERIMENTS_DIR = join(ROOT, 'experiments');

export interface ExperimentMetadata {
  display: ExperimentDisplayMetadata;
  /** An array because some experiments belong to more than one suite. */
  suites: ExperimentSuite[];
}

export async function loadExperimentMetadata(): Promise<
  Map<string, ExperimentMetadata>
> {
  const map = new Map<string, ExperimentMetadata>();
  for (const experiment of await discoverExperimentFiles(EXPERIMENTS_DIR)) {
    const mod = await import(pathToFileURL(experiment.path).href);
    const config: ExperimentConfig = mod.default;
    map.set(experiment.name, {
      display: getExperimentDisplayMetadata(config),
      suites: config.suite ?? [],
    });
  }
  return map;
}

export type PromptData = Awaited<ReturnType<typeof readPrompt>>;

/**
 * Results record only the eval id, so each suite folder is searched for it.
 * The startsWith guard stops an id like "../x" escaping `evals/`.
 */
export async function readPrompt(evalId: string) {
  const evalsDir = resolve(EVALS_DIR);
  if (!existsSync(evalsDir)) {
    return undefined;
  }
  for (const suiteDir of await readdir(evalsDir)) {
    const promptPath = resolve(evalsDir, suiteDir, evalId, 'PROMPT.md');
    if (
      !promptPath.startsWith(`${evalsDir}${sep}`) ||
      !existsSync(promptPath)
    ) {
      continue;
    }
    const parsed = parseEvalMarkdown(
      await readFile(promptPath, 'utf8'),
      promptPath
    );
    return {
      ...parsed.metadata,
      suite: evalSuiteSchema.parse(suiteDir),
      prompt: parsed.body,
      promptSourcePath: relative(ROOT, promptPath).split(sep).join('/'),
    };
  }
  return undefined;
}

export interface ResultFile {
  experiment: string;
  evalId: string;
  /** Path relative to `results/`, as recorded in the exported `sourcePath`. */
  sourcePath: string;
  absolutePath: string;
  result: ReturnType<typeof rawEvalResultSchema.parse>;
}

export interface CollectOptions {
  includeExperiment?: (experiment: string) => boolean;
  includeEval?: (evalId: string) => boolean;
  /** Called for a `result.json` that fails the schema, e.g. one written by an older harness. */
  onUnparseable?: (sourcePath: string, message: string) => void;
}

/** Walks the canonical `results/<experiment>/<eval>/run-<n>/result.json` layout. */
export async function collectResultFiles({
  includeExperiment,
  includeEval,
  onUnparseable,
}: CollectOptions = {}): Promise<ResultFile[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }
  const files: ResultFile[] = [];

  for (const experiment of await readdir(RESULTS_DIR)) {
    if (experiment.startsWith('.') || experiment.startsWith('_')) {
      continue;
    }
    if (includeExperiment && !includeExperiment(experiment)) {
      continue;
    }
    const experimentDir = join(RESULTS_DIR, experiment);
    if (!(await stat(experimentDir)).isDirectory()) {
      continue;
    }

    for (const evalId of await readdir(experimentDir)) {
      const evalDir = join(experimentDir, evalId);
      if (!(await stat(evalDir)).isDirectory()) {
        continue;
      }
      if (includeEval && !includeEval(evalId)) {
        continue;
      }

      for (const runEntry of (await readdir(evalDir)).sort()) {
        if (!/^run-\d+$/.test(runEntry)) {
          continue;
        }
        const absolutePath = join(evalDir, runEntry, 'result.json');
        if (!existsSync(absolutePath)) {
          continue;
        }
        const sourcePath = relative(RESULTS_DIR, absolutePath)
          .split(sep)
          .join('/');
        const raw: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
        const parsed = rawEvalResultSchema.safeParse(raw);
        if (!parsed.success) {
          onUnparseable?.(sourcePath, parsed.error.issues[0]?.message ?? '');
          continue;
        }
        files.push({
          experiment,
          evalId,
          sourcePath,
          absolutePath,
          result: parsed.data,
        });
      }
    }
  }
  return files;
}
