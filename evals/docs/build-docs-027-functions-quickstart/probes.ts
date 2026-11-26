import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';

import type { StackState } from './stack.js';

export const FUNCTION = 'welcome';

// Permanent: the published results series is keyed on these strings.
export const CHECK = {
  running: 'the local stack is running',
  answers: 'the welcome function answers a request',
  greets: 'the greeting names whoever asked',
  json: 'the response says it is JSON',
  guide: 'the agent read the Edge Functions quickstart the prompt referenced',
} as const;

export type Answer = {
  status: number;
  body: string;
  contentType: string;
  reached: boolean;
};

export type Probe = {
  /** Two run-scoped names, so a literal the handler hardcodes cannot match. */
  names: [string, string];
  answers: [Answer, Answer];
};

// A cold worker can still be fetching its imports when the first request lands.
// Retry only the answers that mean "not up yet", so a function that never boots
// still fails.
const NOT_UP_YET = [0, 502, 503];
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 4_000;

/**
 * Calls the function the way the guide's own request does: a publishable key in
 * the `apikey` header, a JSON body with a `name`. Never throws.
 */
export async function probeWelcome(
  stack: StackState,
  retryDelayMs = RETRY_DELAY_MS
): Promise<Probe> {
  const run = randomUUID().slice(0, 8);
  const names: [string, string] = [
    `Marguerite Oyelaran ${run}`,
    `Tobias Lindqvist ${run}`,
  ];
  const first = await send(stack, names[0], retryDelayMs);
  const second = await send(stack, names[1], retryDelayMs);
  return { names, answers: [first, second] };
}

export function checkStackIsRunning(stack: StackState): CheckResult {
  return {
    name: CHECK.running,
    passed: stack.running,
    notes: stack.running ? stack.apiUrl : stack.error,
  };
}

export function checkFunctionAnswers(probe: Probe | undefined): CheckResult {
  if (!probe) return notRun(CHECK.answers, 'the local stack is not running');
  const [answer] = probe.answers;
  return {
    name: CHECK.answers,
    passed: isServed(answer),
    notes: describe(answer),
  };
}

export function checkGreetsByName(probe: Probe | undefined): CheckResult {
  if (!probe) return notRun(CHECK.greets, 'the local stack is not running');
  if (!isServed(probe.answers[0])) {
    return notRun(
      CHECK.greets,
      `nothing served: ${describe(probe.answers[0])}`
    );
  }

  const wrong = probe.names
    .map((name, i) => ({ name, answer: probe.answers[i] }))
    .filter(({ name, answer }) => messageOf(answer.body) !== `Hello ${name}!`);

  return {
    name: CHECK.greets,
    passed: wrong.length === 0,
    notes:
      wrong.length === 0
        ? `both names greeted: ${probe.names.map((name) => `Hello ${name}!`).join('; ')}`
        : `sent "${wrong[0].name}", expected "Hello ${wrong[0].name}!", got ${describe(wrong[0].answer)}`,
  };
}

// What `supabase.functions.invoke` keys on: it parses the body as JSON only when
// the response says so, and otherwise hands the app a string. The seed's
// `data.message` needs the parsed object.
export function checkSaysItIsJson(probe: Probe | undefined): CheckResult {
  if (!probe) return notRun(CHECK.json, 'the local stack is not running');
  const [answer] = probe.answers;
  if (!isServed(answer) || answer.status < 200 || answer.status >= 300) {
    return notRun(CHECK.json, `no successful answer: ${describe(answer)}`);
  }
  const mediaType = answer.contentType.split(';')[0].trim().toLowerCase();
  return {
    name: CHECK.json,
    passed: mediaType === 'application/json',
    notes: `content-type: ${answer.contentType || '(none)'}`,
  };
}

async function send(
  stack: StackState,
  name: string,
  retryDelayMs: number
): Promise<Answer> {
  let answer = await once(stack, name);
  for (
    let attempt = 1;
    attempt < ATTEMPTS && NOT_UP_YET.includes(answer.status);
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    answer = await once(stack, name);
  }
  return answer;
}

async function once(stack: StackState, name: string): Promise<Answer> {
  try {
    const response = await fetch(`${stack.apiUrl}/functions/v1/${FUNCTION}`, {
      method: 'POST',
      headers: {
        apikey: stack.publishableKey as string,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
      reached: true,
    };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      contentType: '',
      reached: false,
    };
  }
}

// 404, 502 and 503 are the gateway or runtime answering for a function that is
// not there or never booted. Anything else came from the function.
function isServed(answer: Answer): boolean {
  return answer.reached && ![404, 502, 503].includes(answer.status);
}

function messageOf(body: string): unknown {
  try {
    return JSON.parse(body)?.message;
  } catch {
    return undefined;
  }
}

function describe(answer: Answer): string {
  if (!answer.reached) {
    return `nothing served at /functions/v1/${FUNCTION}: ${answer.body}`;
  }
  if (/name resolution|dns|fetch failed/i.test(answer.body)) {
    return `status ${answer.status}: the worker could not reach the network to load its imports, so this run measured nothing about the handler: ${preview(answer.body)}`;
  }
  if (answer.status === 502 || answer.status === 503) {
    return `status ${answer.status}: the worker never ran, so this run measured nothing about the handler: ${preview(answer.body)}`;
  }
  return `status ${answer.status}: ${preview(answer.body)}`;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat || '(empty)';
}

function notRun(name: string, why: string): CheckResult {
  return { name, passed: false, notes: `not run: ${why}` };
}
