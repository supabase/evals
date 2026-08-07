import { Sandbox } from '@vercel/sandbox';
import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { FatalError, getWritable } from 'workflow';

const EVAL_REPOSITORY = 'https://github.com/supabase/evals.git';
const EVAL_REF = 'main';
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DOCKER_BOOTSTRAP_TIMEOUT_MS = 2 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const EVAL_TIMEOUT_MS = 20 * 60 * 1000;
const AGENT_STREAM_PREFIX = '__EVALS_AGENT_STREAM__=';

export interface EvalWorkItem {
  experiment: string;
  evalId: string;
  ref?: string;
}

export interface EvalResult {
  sandboxName: string;
  passed: boolean;
  attempts: number;
  checks: Array<{ name: string; passed: boolean }>;
}

type EvalSummary = Omit<EvalResult, 'sandboxName'>;

export async function runEvalWorkflow(item: EvalWorkItem): Promise<EvalResult> {
  'use workflow';

  const sandbox = await createEvalSandbox(item);

  let result: EvalSummary;
  try {
    result = await runEvalInSandbox(sandbox, item);
  } catch (error) {
    await deleteEvalSandbox(sandbox);
    throw error;
  }

  await deleteEvalSandbox(sandbox);
  return { sandboxName: sandbox.name, ...result };
}

async function createEvalSandbox(item: EvalWorkItem): Promise<Sandbox> {
  'use step';

  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    throw new FatalError('OPENAI_API_KEY is required to run the eval probe');
  }

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create({
      source: {
        type: 'git',
        url: EVAL_REPOSITORY,
        revision: item.ref ?? EVAL_REF,
        depth: 1,
      },
      runtime: 'node24',
      timeout: SANDBOX_TIMEOUT_MS,
      persistent: false,
      env: { OPENAI_API_KEY: openAiApiKey },
      tags: { purpose: 'eval', eval: item.evalId },
    });

    console.log(`Created Sandbox ${sandbox.name}`);
    await initializeSubmodules(sandbox);
    await prepareDocker(sandbox);
    return sandbox;
  } catch (error) {
    if (sandbox) {
      try {
        await sandbox.delete();
      } catch (deleteError) {
        console.error(`Failed to delete Sandbox ${sandbox.name}`, deleteError);
      }
    }
    throw error;
  }
}

/** Initializes the skills submodule in Vercel's Git source checkout. */
async function initializeSubmodules(sandbox: Sandbox): Promise<void> {
  const submodules = await sandbox.runCommand({
    cmd: 'git',
    args: [
      '-C',
      sandbox.cwd,
      '-c',
      'url.https://github.com/.insteadOf=git@github.com:',
      'submodule',
      'update',
      '--init',
      '--recursive',
    ],
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await requireSuccess(
    submodules.exitCode,
    await submodules.stderr(),
    'initialize Git submodules'
  );
}

/** Installs and starts the Docker daemon required by local-stack evals. */
async function prepareDocker(sandbox: Sandbox): Promise<void> {
  const install = await sandbox.runCommand({
    cmd: 'dnf',
    args: ['install', '-y', 'docker'],
    sudo: true,
    timeoutMs: DOCKER_BOOTSTRAP_TIMEOUT_MS,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await requireSuccess(
    install.exitCode,
    await install.stderr(),
    'install Docker'
  );

  await sandbox.runCommand({
    cmd: 'dockerd',
    sudo: true,
    detached: true,
    stdout: process.stdout,
    stderr: process.stderr,
  });

  const ready = await sandbox.runCommand({
    cmd: 'sh',
    args: ['-lc', 'until sudo docker info >/dev/null 2>&1; do sleep 1; done'],
    timeoutMs: DOCKER_BOOTSTRAP_TIMEOUT_MS,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await requireSuccess(ready.exitCode, await ready.stderr(), 'start Docker');
}

async function runEvalInSandbox(
  sandbox: Sandbox,
  item: EvalWorkItem
): Promise<EvalSummary> {
  'use step';

  const install = await sandbox.runCommand({
    cmd: 'corepack',
    args: ['pnpm', 'install', '--frozen-lockfile'],
    cwd: sandbox.cwd,
    timeoutMs: INSTALL_TIMEOUT_MS,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await requireSuccess(
    install.exitCode,
    await install.stderr(),
    'pnpm install'
  );

  const output = createWorkflowOutput();
  try {
    const evaluation = await sandbox.runCommand({
      cmd: 'corepack',
      args: [
        'pnpm',
        '--filter',
        '@supabase-evals/framework',
        'exec',
        'tsx',
        'harness/run-eval.ts',
        `--experiment=${item.experiment}`,
        `--eval=${item.evalId}`,
        '--runs=1',
        '--timeout-sec=720',
      ],
      cwd: sandbox.cwd,
      timeoutMs: EVAL_TIMEOUT_MS,
      env: { EVALS_STREAM_AGENT_OUTPUT: '1' },
      stdout: output,
      stderr: output,
    });
    await requireSuccess(
      evaluation.exitCode,
      await evaluation.stderr(),
      'eval framework'
    );
  } finally {
    output.end();
    await finished(output);
  }

  const resultPath = `results/${item.experiment}/${item.evalId}.json`;
  const summary = await sandbox.runCommand({
    cmd: 'node',
    args: [
      '-e',
      `const result = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log(JSON.stringify({ passed: result.passed, attempts: result.attempts, checks: (result.checks ?? []).map(({ name, passed }) => ({ name, passed })) }));`,
      resultPath,
    ],
    cwd: sandbox.cwd,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  await requireSuccess(
    summary.exitCode,
    await summary.stderr(),
    'eval summary'
  );

  const result: unknown = JSON.parse(await summary.stdout());
  if (!isEvalSummary(result)) {
    throw new FatalError('eval summary had an unexpected shape');
  }

  return result;
}

/** Converts Sandbox output into one durable Workflow Stream entry per line. */
function createWorkflowOutput(): Writable {
  const writer = getWritable<string>().getWriter();
  const agentWriter = getWritable<string>({ namespace: 'agent' }).getWriter();
  let pending = '';
  let agentPending = '';

  const flushAgentLines = async (): Promise<void> => {
    const newline = agentPending.lastIndexOf('\n');
    if (newline === -1) return;

    const complete = agentPending.slice(0, newline);
    agentPending = agentPending.slice(newline + 1);
    for (const line of complete.split('\n')) {
      if (line) await agentWriter.write(line);
    }
  };

  const flush = async (text: string): Promise<void> => {
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (!line.startsWith(AGENT_STREAM_PREFIX)) {
        await writer.write(line);
        continue;
      }

      agentPending += Buffer.from(
        line.slice(AGENT_STREAM_PREFIX.length),
        'base64'
      ).toString();
      await flushAgentLines();
    }
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const newline = pending.lastIndexOf('\n');
      if (newline === -1) {
        callback();
        return;
      }

      const complete = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      void flush(complete).then(() => callback(), callback);
    },
    final(callback) {
      void flush(pending)
        .then(async () => {
          if (agentPending) await agentWriter.write(agentPending);
          writer.releaseLock();
          agentWriter.releaseLock();
        })
        .then(() => callback(), callback);
    },
  });
}

// A retry must create a new Sandbox, not reuse a possibly-corrupted one.
runEvalInSandbox.maxRetries = 0;

async function deleteEvalSandbox(sandbox: Sandbox): Promise<void> {
  'use step';

  console.log(`Deleting Sandbox ${sandbox.name}`);
  await sandbox.delete();
}

/** Throws a retryable error when a Sandbox command fails. */
function requireSuccess(
  exitCode: number,
  stderr: string,
  command: string
): void {
  if (exitCode === 0) return;
  throw new Error(`${command} failed: ${stderr}`);
}

/** Narrows the untrusted JSON summary produced in the Sandbox. */
function isEvalSummary(value: unknown): value is EvalSummary {
  if (!value || typeof value !== 'object') return false;
  if (!('passed' in value) || typeof value.passed !== 'boolean') return false;
  if (!('attempts' in value) || typeof value.attempts !== 'number')
    return false;
  if (!('checks' in value) || !Array.isArray(value.checks)) return false;

  return value.checks.every(
    (check) =>
      check &&
      typeof check === 'object' &&
      'name' in check &&
      typeof check.name === 'string' &&
      'passed' in check &&
      typeof check.passed === 'boolean'
  );
}
