import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorLine, messageOf, readStack } from '../lib/local-stack.js';
import {
  DELIVERY_WINDOW_SECONDS,
  PROBE_SCRIPT,
  PROBE_TIMEOUT_SECONDS,
  STAGES,
  type Source,
  type Stage,
} from './probe-script.js';

const PROBE_CLIENT_VERSION = '2.118.0';

export const CHECK = {
  installed: "the scorer installed the app's locked dependencies",
  loads: 'the room screen can load watchRoom from src/live.js',
  mobile:
    'a room member sees a message from the mobile app as soon as it is saved',
  inbox:
    'a room member sees a message from the support inbox as soon as it is saved',
  web: 'a room member sees a message posted from the web app as soon as it is saved',
  outsider:
    "a signed-in person from another room never sees the room's messages",
  visitor: "a visitor who is not signed in never sees the room's messages",
  forged: 'a person from another room cannot slip a message into the room',
} as const;

type Exec = Pick<LocalStackEvalContext, 'exec'>;
type Who = 'member' | 'outsider' | 'visitor';
type Bystander = Exclude<Who, 'member'>;

type Delivery = { error: string; seen: string; route: string };

export type Probe = {
  stage: Stage;
  note: string;
  topics: string[];
  joins: Record<Bystander, string[]>;
  delivered: Partial<Record<Source, Delivery>>;
  leaks: Record<Bystander, string[]>;
  controlDelivered: boolean;
  forgery: {
    tried: string[];
    rowStored: boolean;
    rowNote: string;
    seen: string[];
  };
};

export type Outcome =
  | { probe: Probe }
  | { failure: string; installed: boolean };

export async function probeRooms(ctx: Exec): Promise<Outcome> {
  const runId = randomUUID().slice(0, 8);
  const probeDir = `/tmp/broadcast-eval-${runId}`;
  const installed = await install(ctx, probeDir);
  if (installed) return { installed: false, failure: installed };
  try {
    const stack = await readStack(ctx);
    const probe = await runProbe(ctx, probeDir, {
      EVAL_API_URL: stack.apiUrl,
      EVAL_ADMIN_KEY: stack.adminKey,
      EVAL_CLIENT_KEY: stack.clientKey,
      EVAL_DB_URL: await readDbUrl(ctx),
      EVAL_RUN_ID: runId,
    });
    return { probe };
  } catch (error) {
    return { installed: true, failure: messageOf(error) };
  }
}

async function install(ctx: Exec, probeDir: string): Promise<string> {
  const app = await ctx.exec('npm ci --no-audit --no-fund --silent', {
    timeoutMs: 300_000,
  });
  if (app.exitCode !== 0) {
    return `npm ci in the workspace failed: ${errorLine(`${app.stderr ?? ''}\n${app.stdout ?? ''}`)}`;
  }
  const own = await ctx.exec(
    `mkdir -p ${probeDir} && cd ${probeDir} && npm init -y >/dev/null && npm install --no-audit --no-fund --silent @supabase/supabase-js@${PROBE_CLIENT_VERSION}`,
    { timeoutMs: 300_000 }
  );
  if (own.exitCode !== 0) {
    return `installing the scorer's own client failed: ${errorLine(`${own.stderr ?? ''}\n${own.stdout ?? ''}`)}`;
  }
  return '';
}

async function readDbUrl(ctx: Exec): Promise<string> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  if (!parsed.DB_URL) throw new Error('supabase status reported no DB_URL');
  return parsed.DB_URL;
}

async function runProbe(
  ctx: Exec,
  probeDir: string,
  env: Record<string, string>
): Promise<Probe> {
  const vars = Object.entries(env)
    .map(([name, value]) => `${name}='${value}'`)
    .join(' ');
  const encoded = Buffer.from(PROBE_SCRIPT, 'utf8').toString('base64');
  const result = await ctx.exec(
    `echo ${encoded} | base64 -d > ${probeDir}/probe.mjs && ${vars} EVAL_WORKSPACE="$PWD" node ${probeDir}/probe.mjs`,
    { timeoutMs: (PROBE_TIMEOUT_SECONDS + 40) * 1000 }
  );
  const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
  if (line.startsWith('{')) return JSON.parse(line) as Probe;
  throw new Error(errorLine(`${result.stderr}\n${result.stdout}`));
}

function reached(outcome: Outcome, stage: Stage): outcome is { probe: Probe } {
  return (
    'probe' in outcome &&
    STAGES.indexOf(outcome.probe.stage) > STAGES.indexOf(stage)
  );
}

function notRun(outcome: Outcome, name: string): CheckResult {
  const reason =
    'failure' in outcome
      ? outcome.failure
      : outcome.probe.note || `the probe stopped at ${outcome.probe.stage}`;
  return { name, passed: false, notes: `not run: ${reason}` };
}

export function checkInstalled(outcome: Outcome): CheckResult {
  const failed = 'failure' in outcome && !outcome.installed;
  return {
    name: CHECK.installed,
    passed: !failed,
    notes: failed
      ? `${outcome.failure}. Scoring needs the npm registry, so read this as a lost run unless the agent changed the lockfile`
      : 'npm ci in the workspace and the pinned scorer client both installed',
  };
}

export function checkLoads(outcome: Outcome): CheckResult {
  if ('failure' in outcome) return notRun(outcome, CHECK.loads);
  const loaded = outcome.probe.stage !== 'load';
  return {
    name: CHECK.loads,
    passed: loaded,
    notes: loaded ? 'watchRoom is a function' : outcome.probe.note,
  };
}

export function checkMemberSees(outcome: Outcome, source: Source): CheckResult {
  const name = CHECK[source];
  if (!reached(outcome, 'post')) return notRun(outcome, name);
  const delivery = outcome.probe.delivered[source];
  if (!delivery) {
    return { name, passed: false, notes: 'the scorer never sent this message' };
  }
  const sent = delivery.error
    ? ` The send itself failed: ${delivery.error}.`
    : '';
  return {
    name,
    passed: delivery.seen !== '',
    notes:
      delivery.seen !== ''
        ? `delivered by ${delivery.route}: ${delivery.seen}`
        : `nothing carrying the message reached the callback within ${DELIVERY_WINDOW_SECONDS} seconds.${sent} The member's channels: ${listed(outcome.probe.topics)}`,
  };
}

export function checkNeverSees(outcome: Outcome, who: Bystander): CheckResult {
  const name = CHECK[who];
  if (!reached(outcome, 'post')) return notRun(outcome, name);
  const { probe } = outcome;
  const tried = listed(probe.joins[who]);
  if (probe.leaks[who].length > 0) {
    return {
      name,
      passed: false,
      notes: `got ${probe.leaks[who][0]}. Tried: ${tried}`,
    };
  }
  if (probe.topics.length === 0) {
    return {
      name,
      passed: false,
      notes: `could not measure: watchRoom joined nothing on the client it was given, so there was no topic to try directly. Tried: ${tried}`,
    };
  }
  return {
    name,
    passed: true,
    notes: `nothing carrying a room message arrived. Tried: ${tried}.${publicRefused(probe.joins[who])}`,
  };
}

export function checkCannotForge(outcome: Outcome): CheckResult {
  if (!reached(outcome, 'forge')) return notRun(outcome, CHECK.forged);
  const { probe } = outcome;
  const { forgery } = probe;
  const tried = listed(forgery.tried);
  if (forgery.rowStored || forgery.seen.length > 0) {
    return {
      name: CHECK.forged,
      passed: false,
      notes: [
        forgery.rowStored ? forgery.rowNote : '',
        forgery.seen.length > 0
          ? `the member's callback got ${forgery.seen[0]}`
          : '',
        `Tried: ${tried}`,
      ]
        .filter((part) => part !== '')
        .join('. '),
    };
  }
  const unmeasured = [
    probe.topics.length === 0
      ? 'watchRoom joined nothing on the client it was given, so there was no topic to send on'
      : '',
    probe.controlDelivered
      ? ''
      : "the scorer's own message on its private control topic never arrived",
    forgery.rowNote.startsWith('could not') ? forgery.rowNote : '',
  ].filter((part) => part !== '');
  if (unmeasured.length > 0) {
    return {
      name: CHECK.forged,
      passed: false,
      notes: `could not measure: ${unmeasured.join('; ')}. Tried: ${tried}`,
    };
  }
  return {
    name: CHECK.forged,
    passed: true,
    notes: `${forgery.rowNote}. The member's callback got none of the forged messages. Tried: ${tried}.${publicRefused(forgery.tried)}`,
  };
}

const PUBLIC_REFUSED =
  ' Public joins that never reached joined were refused, which counts as no leak and no forgery.';

function publicRefused(lines: string[]): string {
  return lines.some((line) =>
    / public (join )?(joining|errored|closed)$/.test(line)
  )
    ? PUBLIC_REFUSED
    : '';
}

function listed(lines: string[]): string {
  return lines.length > 0 ? lines.join('; ').slice(0, 600) : 'none';
}
