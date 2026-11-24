import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalStackEvalContext } from '@supabase-evals/core';

export const SETTINGS_FILE = 'app/.env';
const SETTING = 'DATABASE_URL';

export type Tool = {
  user: string;
  password: string;
  database: string;
  host: string;
  port: string;
};

export type ToolRead = { tool: Tool } | { failure: string };

/**
 * The scorer never learns the account's name or password from the agent's
 * transcript. It reads the string the agent left in the settings file and
 * takes the credentials out of it the way the tool would.
 */
export function readTool(hostWorkspace: string): ToolRead {
  const path = join(hostWorkspace, SETTINGS_FILE);
  if (!existsSync(path)) {
    return { failure: `${SETTINGS_FILE} is gone` };
  }
  const values = readFileSync(path, 'utf8')
    .split('\n')
    .map(
      (line) =>
        new RegExp(`^\\s*(?:export\\s+)?${SETTING}\\s*=(.*)$`).exec(line)?.[1]
    )
    .filter((value): value is string => value !== undefined)
    .map((value) =>
      value
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim()
    )
    .filter((value) => value.length > 0);
  const raw = values.at(-1);
  if (raw === undefined) {
    return { failure: `${SETTING} is empty in ${SETTINGS_FILE}` };
  }
  if (!URL.canParse(raw)) {
    return { failure: `${SETTING} is not a connection string that parses` };
  }
  const url = new URL(raw);
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return {
      failure: `the user or password in ${SETTING} does not decode as written`,
    };
  }
  if (user === '') {
    return { failure: `${SETTING} names no user` };
  }
  if (password === '') {
    return { failure: `${SETTING} carries no password` };
  }
  return {
    tool: {
      user,
      password,
      database: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
      host: url.hostname,
      port: url.port || '5432',
    },
  };
}

export type ToolResult = {
  ok: boolean;
  stdout: string;
  // SQLSTATE of the statement's error. Absent when it ran, or when the
  // connection itself failed.
  code?: string;
  message: string;
};

/** Runs one statement as the tool's account. Never throws. */
export type AsTool = (sql: string) => Promise<ToolResult>;

export type ToolSession = { asTool: AsTool } | { failure: string };

/**
 * Connects the way Prisma would: to the host and port the string names, with
 * the string's own account and password.
 */
export async function openToolSession(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  tool: Tool
): Promise<ToolSession> {
  const { host: hostname, port } = tool;
  if (!/^[\w.-]+$/.test(hostname) || !/^\d+$/.test(port)) {
    return { failure: `unexpected database address ${hostname}:${port}` };
  }
  const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  const decode = (value: string) => `"$(printf %s ${b64(value)} | base64 -d)"`;

  const asTool: AsTool = async (sql) => {
    try {
      const result = await ctx.exec(
        `PGPASSWORD=${decode(tool.password)} PGCONNECT_TIMEOUT=10 psql -h ${hostname} -p ${port} -U ${decode(tool.user)} -d ${decode(tool.database)} -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -c ${decode(sql)}`,
        { timeoutMs: 60_000 }
      );
      const stdout = (result.stdout ?? '').trim();
      if (result.exitCode === 0) {
        return { ok: true, stdout, message: '' };
      }
      const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
      return {
        ok: false,
        stdout,
        code: /ERROR:\s+([0-9A-Z]{5})\b/.exec(output)?.[1],
        message: firstError(output),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, stdout: '', message: message.slice(0, 300) };
    }
  };
  return { asTool };
}

function firstError(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const named = lines.filter((line) =>
    /\b(ERROR|FATAL|DETAIL|HINT)\b/i.test(line)
  );
  return ((named.length > 0 ? named.join(' ') : lines[0]) ?? 'no output').slice(
    0,
    300
  );
}
