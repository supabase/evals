import type {
  CommandResult,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';

export const TEST_DB_URL =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** `url` is the connection string the scorer passed to psql. */
export type FakePsql = (sql: string, url: string) => Partial<CommandResult>;

export type FakeContextOptions = {
  /** Answers each SQL text the scorer pipes into psql. */
  psql: FakePsql;
  files?: Record<string, string>;
  toolCalls?: ToolCallRecord[];
};

function done(result: Partial<CommandResult>): CommandResult {
  const ok = result.ok ?? true;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** A scoring context whose sandbox resolves a stack and answers psql from `psql`. */
export function fakeContext(
  options: FakeContextOptions
): LocalStackEvalContext {
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.includes('status') && command.includes('supabase')) {
      return done({ stdout: JSON.stringify({ DB_URL: TEST_DB_URL }) });
    }
    const piped = command.match(
      /^echo (\S+) \| base64 -d \| psql '?([^' ]+)'? /
    );
    if (piped) {
      return done(
        options.psql(Buffer.from(piped[1], 'base64').toString('utf8'), piped[2])
      );
    }
    if (command.includes('select 1')) return done({ stdout: '1\n' });
    return done({ ok: false, stderr: `unexpected command: ${command}` });
  };
  return {
    workspace: '/workspace',
    exec,
    readFile: async (path: string) => {
      const content = options.files?.[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    environmentMarker: async () => undefined,
    toolCalls: options.toolCalls ?? [],
    transcript: [],
  } as unknown as LocalStackEvalContext;
}

/** A shell tool call as an agent parser records it. */
export function shellCall(command: string, result = ''): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'Bash' },
    name: 'shell',
    body: { command },
    command,
    result,
    ts: 0,
  } as unknown as ToolCallRecord;
}
