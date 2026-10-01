import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { readRowStrings, type RowStringsProbe } from '../lib/markers.js';
import {
  maskUrlCredentials,
  probeStackReady,
  resolveStack,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import { CLIENTS, type Client, type ProjectDirs } from './projects.js';

export type ClientStacks = Record<Client, StackProbe>;
export type ClientRows = Record<Client, RowStringsProbe>;

export function stackPorts(stack: StackProbe): {
  db: number | undefined;
  api: number | undefined;
} {
  if (!stack.ok) return { db: undefined, api: undefined };
  return {
    db: urlPort(stack.dbUrl),
    api: stack.apiUrl === undefined ? undefined : urlPort(stack.apiUrl),
  };
}

/** Resolves each client's stack from inside its own project directory. */
export async function resolveClientStacks(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dirs: ProjectDirs
): Promise<ClientStacks> {
  const stacks = {} as ClientStacks;
  for (const client of CLIENTS) {
    const dir = dirs.found[client];
    stacks[client] =
      dir === undefined
        ? {
            ok: false,
            notes: `no project directory (${dirs.problems[client] ?? 'not found'})`,
          }
        : await resolveStack(ctx, { kind: 'project', dir });
  }
  return stacks;
}

export async function readClientRows(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: ClientStacks
): Promise<ClientRows> {
  const rows = {} as ClientRows;
  for (const client of CLIENTS) {
    const stack = stacks[client];
    rows[client] = stack.ok
      ? await readRowStrings(ctx, stack, 'public.clients')
      : { ok: false, notes: stack.notes };
  }
  return rows;
}

export async function checkBothStacksReady(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: ClientStacks
): Promise<CheckResult> {
  const name = 'both stacks reach ready';
  const probes = await Promise.all(
    CLIENTS.map((client) => probeStackReady(ctx, stacks[client]))
  );
  return {
    name,
    passed: probes.every(({ ready }) => ready),
    notes: CLIENTS.map((client, i) => `${client}: ${probes[i].notes}`).join(
      '; '
    ),
  };
}

/**
 * Two independent stacks must listen on different DB ports; matching ports
 * mean one project's lookup reached the other's stack, or one was clobbered.
 */
export function checkDistinctPorts(stacks: ClientStacks): CheckResult {
  const name = 'stacks are on distinct ports';
  const [a, b] = CLIENTS.map((client) => stacks[client]);
  if (!a.ok || !b.ok) {
    return {
      name,
      passed: false,
      notes: CLIENTS.map((client) => {
        const stack = stacks[client];
        return `${client}: ${stack.ok ? 'resolved' : stack.notes}`;
      }).join('; '),
    };
  }
  const portA = urlPort(a.dbUrl);
  const portB = urlPort(b.dbUrl);
  if (portA === undefined || portB === undefined) {
    return {
      name,
      passed: false,
      notes: `could not parse a port from one or both DB URLs (client-a: ${maskUrlCredentials(
        a.dbUrl
      )}, client-b: ${maskUrlCredentials(b.dbUrl)})`,
    };
  }
  const passed = portA !== portB;
  return {
    name,
    passed,
    notes: passed
      ? `client-a db port ${portA}, client-b db port ${portB}`
      : `client-a and client-b both resolved to db port ${portA} — stacks are not independent`,
  };
}
