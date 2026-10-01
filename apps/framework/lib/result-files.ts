import { existsSync } from 'node:fs';
import { glob, readdir, readFile } from 'node:fs/promises';
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

/** Finds an eval prompt within `evals/`. */
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
  /** Path relative to `results/`. */
  sourcePath: string;
  absolutePath: string;
  result: ReturnType<typeof rawEvalResultSchema.parse>;
}

export interface CollectOptions {
  includeExperiment?: (experiment: string) => boolean;
  includeEval?: (evalId: string) => boolean;
  /** Called when a result file fails schema validation. */
  onUnparseable?: (sourcePath: string, message: string) => void;
  resultsDir?: string;
}

/** Reads the canonical `results/<experiment>/<eval>/run-<n>/result.json` layout. */
export async function collectResultFiles({
  includeExperiment,
  includeEval,
  onUnparseable,
  resultsDir = RESULTS_DIR,
}: CollectOptions = {}): Promise<ResultFile[]> {
  if (!existsSync(resultsDir)) {
    return [];
  }
  const files: ResultFile[] = [];
  const paths: string[] = [];
  // Two patterns because `*` alone skips dot-prefixed eval directories.
  for await (const absolutePath of glob([
    join(resultsDir, '*', '*', 'run-*', 'result.json'),
    join(resultsDir, '*', '.*', 'run-*', 'result.json'),
  ])) {
    paths.push(absolutePath);
  }
  for (const absolutePath of paths.sort()) {
    const sourcePath = relative(resultsDir, absolutePath).split(sep).join('/');
    const [experiment, evalId, runEntry] = sourcePath.split('/');
    if (experiment.startsWith('.') || experiment.startsWith('_')) {
      continue;
    }
    if (!/^run-\d+$/.test(runEntry)) {
      continue;
    }
    if (includeExperiment && !includeExperiment(experiment)) {
      continue;
    }
    if (includeEval && !includeEval(evalId)) {
      continue;
    }
    const raw: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
    const parsed = rawEvalResultSchema.safeParse(raw);
    if (!parsed.success) {
      onUnparseable?.(sourcePath, parsed.error.issues[0]?.message ?? '');
      continue;
    }
    files.push({ sourcePath, absolutePath, result: parsed.data });
  }
  return files;
}
