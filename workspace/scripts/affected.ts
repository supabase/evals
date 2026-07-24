#!/usr/bin/env tsx
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(process.argv[1]), '..', '..');
const requireFromFramework = createRequire(
  join(ROOT, 'apps/framework/package.json')
);
const ALIASES: Record<string, string> = {
  functions: 'edge-functions',
  rest: 'data-api',
  api: 'data-api',
};

type Experiment = { name: string; skills: string[] };
type Eval = {
  id: string;
  product: string[];
  topic: string[];
  interface?: string;
};

async function loadExperiments(): Promise<Experiment[]> {
  const dir = join(ROOT, 'experiments');
  const experiments: Experiment[] = [];

  for (const file of readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .sort()) {
    // Experiment files are runtime-selected plugins, matching run-eval.ts discovery.
    const module = await import(pathToFileURL(join(dir, file)).href);
    const config = module.default as { skills?: string[] };
    experiments.push({
      name: file.replace(/\.ts$/, ''),
      skills: config.skills ?? [],
    });
  }

  return experiments;
}

async function discoverEvals(): Promise<Eval[]> {
  // Resolve from the repo root because this script intentionally lives outside that package.
  const parserPath = requireFromFramework.resolve(
    '@supabase-evals/core/eval-markdown'
  );
  const { parseEvalMarkdown } = await import(pathToFileURL(parserPath).href);
  const dir = join(ROOT, 'evals');
  if (!existsSync(dir)) return [];

  const evals: Eval[] = [];
  for (const id of readdirSync(dir).sort()) {
    const evalDir = join(dir, id);
    if (!statSync(evalDir).isDirectory()) continue;

    const promptPath = join(evalDir, 'PROMPT.md');
    if (!existsSync(promptPath)) continue; // stray/partial dir: skip, don't abort the mapper
    const metadata = parseEvalMarkdown(
      readFileSync(promptPath, 'utf8'),
      `evals/${id}/PROMPT.md`
    ).metadata;
    evals.push({
      id,
      product: metadata.product,
      topic: metadata.topic,
      interface: metadata.interface,
    });
  }

  return evals;
}

function addPathTokens(
  segments: string[],
  vocabulary: Set<string>,
  destination: Set<string>
): void {
  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/\.[^.]+$/, '');
    const token = ALIASES[segment] ?? segment;
    if (vocabulary.has(token)) destination.add(token);
  }
}

function matchingEvalIds(evals: Eval[], tokens: Set<string>): string[] {
  return evals
    .filter((entry) =>
      [...entry.product, ...entry.topic].some((token) => tokens.has(token))
    )
    .map((entry) => entry.id);
}

async function main(): Promise<void> {
  const paths = [...new Set(process.argv.slice(2))];
  if (paths.length === 0) {
    console.log('Usage: affected.ts <changed-path>...');
    return;
  }

  const [experiments, evals] = await Promise.all([
    loadExperiments(),
    discoverEvals(),
  ]);
  const vocabulary = new Set(
    evals.flatMap((entry) => [...entry.product, ...entry.topic])
  );
  const skills = new Set<string>();
  const docsTokens = new Set<string>();
  const mcpTokens = new Set<string>();
  const unknownPaths: string[] = [];
  let allMcpEvals = false;
  let serverWide = false;

  for (const rawPath of paths) {
    const path = rawPath.replaceAll('\\', '/');
    let recognized = false;

    const skillMatch = path.match(/(?:^|\/)skills\/([^/]+)(?:\/|$)/);
    if (skillMatch) {
      skills.add(skillMatch[1]);
      recognized = true;
    }

    const docsMarker = 'apps/docs/content/';
    const docsIndex = path.indexOf(docsMarker);
    if (docsIndex !== -1) {
      addPathTokens(
        path.slice(docsIndex + docsMarker.length).split('/'),
        vocabulary,
        docsTokens
      );
      recognized = true;
    }

    const isMcp =
      path.includes('mcp-server-supabase/src/') ||
      path.includes('/tools/') ||
      path.startsWith('tools/') ||
      /^src\/(?:server\.ts|index\.ts|transports\/)/.test(path);
    if (isMcp) {
      recognized = true;
      const file = basename(path);
      const stem = file.replace(/\.ts$/, '');

      if (
        file === 'server.ts' ||
        file === 'index.ts' ||
        /(?:^|\/)transports\//.test(path)
      ) {
        serverWide = true;
      } else if (stem === 'docs-tools') {
        allMcpEvals = true;
      } else {
        addPathTokens(stem.split('-'), vocabulary, mcpTokens);
      }
    }

    if (!recognized) unknownPaths.push(rawPath);
  }

  if (unknownPaths.length > 0) {
    console.log(`Ignored unknown paths: ${unknownPaths.join(', ')}`);
  }

  let commandCount = 0;

  if (skills.size > 0) {
    const names = experiments
      .filter((experiment) =>
        experiment.skills.some((skill) => skills.has(skill))
      )
      .map((experiment) => experiment.name);
    if (names.length > 0) {
      console.log(
        `mise run eval -- ${names.map((name) => `--experiment ${name}`).join(' ')} --suite regression`
      );
      commandCount++;
    } else {
      console.log(
        `No experiments use changed skills: ${[...skills].sort().join(', ')}`
      );
    }
  }

  if (docsTokens.size > 0) {
    const ids = matchingEvalIds(evals, docsTokens);
    if (ids.length > 0) {
      // Docs impact is only measurable against the LOCAL index: the local mcp
      // build (mcp-eval) pointed at the local content API. A bare `mise run
      // eval` would query the production docs API and never see the edit.
      // URL also lives in ab.sh / docs-api.sh / workspace README — keep in sync.
      console.log('# needs: mise run docs-index && mise run docs-api');
      console.log(
        `SUPABASE_CONTENT_API_URL=http://127.0.0.1:3001/docs/api/graphql mise run mcp-eval -- ${ids.map((id) => `--eval ${id}`).join(' ')}`
      );
      commandCount++;
    }
  }

  if (mcpTokens.size > 0 || allMcpEvals) {
    const ids = new Set(matchingEvalIds(evals, mcpTokens));
    if (allMcpEvals) {
      for (const entry of evals) {
        if (entry.interface === 'mcp') ids.add(entry.id);
      }
    }
    if (ids.size > 0) {
      // mcp-eval builds submodules/mcp and selects it via SUPABASE_MCP_SERVER_PATH;
      // a bare `mise run eval` would run the published npx server instead.
      console.log(
        `mise run mcp-eval -- ${[...ids]
          .sort()
          .map((id) => `--eval ${id}`)
          .join(' ')}`
      );
      commandCount++;
    }
  }

  if (serverWide) {
    console.log('mise run mcp-eval -- --smoke');
    commandCount++;
  }

  if (commandCount === 0) console.log('No affected evals.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
