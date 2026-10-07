import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import type { SupabaseInvocation } from '../lib/cli-invocations.js';
import { readRowStrings, type RowStringsProbe } from '../lib/markers.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import {
  maskUrlCredentials,
  probeStackReady,
  resolveStackWithAgentHomes,
  urlPort,
  type StackProbe,
} from '../lib/stack.js';
import { CLIENTS, type Client, type ProjectDirs } from './projects.js';

export type ClientStacks = Record<Client, StackProbe>;
export type ClientRows = Record<Client, RowStringsProbe>;
export type RowCountProbe =
  | { ok: true; count: number }
  | { ok: false; notes: string };
export type ClientRowCounts = Record<Client, RowCountProbe>;

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

/**
 * Resolves each client's stack from inside its own project directory, falling
 * back to any relocated CLI home the agent started that project under.
 */
export async function resolveClientStacks(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dirs: ProjectDirs,
  invocations: readonly SupabaseInvocation[] = []
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
        : await resolveStackWithAgentHomes(
            ctx,
            { kind: 'project', dir },
            invocations
          );
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

/**
 * Row count per project, queried separately because `readRowStrings` flattens
 * every string column of every row into one list.
 */
export async function readClientRowCounts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: ClientStacks
): Promise<ClientRowCounts> {
  const counts = {} as ClientRowCounts;
  for (const client of CLIENTS) {
    const stack = stacks[client];
    if (!stack.ok) {
      counts[client] = { ok: false, notes: stack.notes };
      continue;
    }
    try {
      const result = await ctx.exec(
        `psql ${shellQuote(stack.dbUrl)} -tAc 'select count(*) from public.clients'`
      );
      const stdout = result.stdout.trim();
      counts[client] =
        result.ok && /^\d+$/.test(stdout)
          ? { ok: true, count: Number(stdout) }
          : { ok: false, notes: describeFailure(result) };
    } catch (error) {
      counts[client] = { ok: false, notes: errorMessage(error) };
    }
  }
  return counts;
}

export function checkSingleClientRow(counts: ClientRowCounts): CheckResult {
  const name = 'each clients table holds exactly one row';
  return {
    name,
    passed: CLIENTS.every((client) => {
      const probe = counts[client];
      return probe.ok && probe.count === 1;
    }),
    notes: CLIENTS.map((client) => {
      const probe = counts[client];
      return `${client}: ${probe.ok ? `${probe.count} row${probe.count === 1 ? '' : 's'}` : probe.notes}`;
    }).join('; '),
  };
}

/** The note explaining why a version-swapped run is judged against the installed CLI. */
export function describeCliOverride(cliOverride: readonly string[]): string {
  return `agent ran ${cliOverride.join(', ')}; scorer uses the installed CLI`;
}

export async function checkBothStacksReady(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stacks: ClientStacks,
  cliOverride: readonly string[] = []
): Promise<CheckResult> {
  const name = 'both stacks reach ready';
  const probes = await Promise.all(
    CLIENTS.map((client) => probeStackReady(ctx, stacks[client]))
  );
  return {
    name,
    passed: probes.every(({ ready }) => ready),
    notes: [
      ...CLIENTS.map((client, i) => {
        const stack = stacks[client];
        const relocated =
          stack.ok && stack.relocatedHome !== undefined
            ? `, relocated home: ${stack.relocatedHome}`
            : '';
        return `${client}: ${probes[i].notes}${relocated}`;
      }),
      ...(cliOverride.length > 0 ? [describeCliOverride(cliOverride)] : []),
    ].join('; '),
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
