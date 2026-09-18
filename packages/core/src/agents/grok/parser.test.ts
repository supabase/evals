import { describe, expect, it } from 'vitest';
import { grokParser } from './parser.js';
import { buildGrokConfig, grokRunner } from './runner.js';
import type { AgentSandbox } from '../types.js';

/** A sandbox that records what the runner asks it to run, and with what env. */
function recordingSandbox() {
  const calls: { command: string; env?: Record<string, string> }[] = [];
  const sandbox: AgentSandbox = {
    workspace: '/workspace',
    async exec(command, options) {
      calls.push({ command, env: options?.env });
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
    async readFile() {
      return '';
    },
  };
  return { sandbox, calls };
}

/**
 * Event shapes are taken verbatim from a real
 * `grok -p --output-format streaming-json --yolo` run, trimmed to the
 * structurally distinct lines (the real stream emits one `text`/`thought`
 * event per token).
 */
const SESSION = [
  // Tool inventory — carries no transcript meaning.
  JSON.stringify({
    type: 'available_commands',
    tools: ['read_file', 'use_tool'],
    commands: [],
  }),
  JSON.stringify({ type: 'thought', data: 'Let me' }),
  JSON.stringify({ type: 'thought', data: ' read it.' }),
  JSON.stringify({ type: 'text', data: "I'll read" }),
  JSON.stringify({ type: 'text', data: ' the file.' }),
  // A native read.
  JSON.stringify({
    type: 'tool_call',
    toolCallId: 'call-a-0',
    title: 'read_file',
    kind: 'read',
    status: 'pending',
    toolName: 'read_file',
    rawInput: { target_file: 'NOTES.md' },
  }),
  // Bare ack — no status, no output.
  JSON.stringify({
    type: 'tool_call_update',
    toolCallId: 'call-a-0',
    status: null,
    rawOutput: null,
  }),
  JSON.stringify({
    type: 'tool_call_update',
    toolCallId: 'call-a-0',
    status: 'completed',
    rawOutput: {
      type: 'ReadFile',
      FileContent: { content: '1→hello from the fixture\n', total_lines: 2 },
    },
  }),
  // An MCP call, which Grok routes through `use_tool`.
  JSON.stringify({
    type: 'tool_call',
    toolCallId: 'call-b-1',
    toolName: 'use_tool',
    kind: 'use_tool',
    rawInput: {
      tool_name: 'supabase-mcp__search_docs',
      tool_input: { query: 'rls policies' },
    },
  }),
  JSON.stringify({
    type: 'tool_call_update',
    toolCallId: 'call-b-1',
    status: 'completed',
    rawOutput: {
      type: 'MCP',
      tool_name: 'search_docs',
      server_name: 'supabase-mcp',
      output: { OkayOutput: 'docs result' },
    },
  }),
  // A shell command that failed, reported through Bash's own exit code.
  JSON.stringify({
    type: 'tool_call',
    toolCallId: 'call-c-2',
    toolName: 'run_terminal_command',
    kind: 'execute',
    rawInput: { command: 'supabase db push', description: 'push migrations' },
  }),
  JSON.stringify({
    type: 'tool_call_update',
    toolCallId: 'call-c-2',
    status: 'in_progress',
    rawOutput: { type: 'Bash', output_for_prompt: '', exit_code: 0 },
  }),
  JSON.stringify({
    type: 'tool_call_update',
    toolCallId: 'call-c-2',
    status: 'completed',
    rawOutput: {
      type: 'Bash',
      output_for_prompt: 'exit: 1\nconnection refused\n',
      exit_code: 1,
      timed_out: false,
    },
  }),
  JSON.stringify({ type: 'text', data: 'Done.' }),
  JSON.stringify({
    type: 'usage',
    usage: { input_tokens: 7856, output_tokens: 82 },
  }),
  JSON.stringify({
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 's1',
    num_turns: 2,
    usage: {
      input_tokens: 15733,
      cache_read_input_tokens: 384,
      cache_creation_input_tokens: 0,
      output_tokens: 155,
      total_tokens: 16272,
    },
    modelUsage: {
      'grok-4.6': {
        inputTokens: 15733,
        outputTokens: 155,
        cacheReadInputTokens: 384,
        cacheCreationInputTokens: 0,
        modelCalls: 2,
      },
    },
  }),
].join('\n');

describe('grok parser', () => {
  const { events, errors } = grokParser.parseTranscript(SESSION);

  it('parses without errors', () => {
    expect(errors).toEqual([]);
  });

  it('coalesces per-token text deltas into whole assistant messages', () => {
    const messages = events
      .filter((e) => e.type === 'message')
      .map((e) => e.content);
    expect(messages).toEqual(["I'll read the file.", 'Done.']);
  });

  it('coalesces per-token thought deltas into one thinking event', () => {
    const thinking = events.filter((e) => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content).toBe('Let me read it.');
  });

  it('normalizes a native read and its path', () => {
    const call = events.find(
      (e) => e.type === 'tool_call' && e.tool?.originalName === 'read_file'
    );
    expect(call?.tool?.name).toBe('file_read');
    expect(call?.tool?.path).toBe('NOTES.md');
    expect(call?.tool?.call).toEqual({
      kind: 'other',
      toolName: 'read_file',
    });
  });

  it('unwraps a use_tool call into its MCP server and tool', () => {
    const call = events.find(
      (e) => e.type === 'tool_call' && e.tool?.originalName === 'search_docs'
    );
    // Without unwrapping, scorers would see `use_tool` and lose the server.
    expect(call?.tool?.call).toEqual({
      kind: 'mcp',
      server: 'supabase-mcp',
      toolName: 'search_docs',
    });
    // The inner tool_input becomes the call's args, not the wrapper's.
    expect(call?.tool?.args).toEqual({ query: 'rls policies' });
  });

  it('names an unwrapped MCP tool tool_use, not unknown', () => {
    const call = events.find(
      (e) => e.type === 'tool_call' && e.tool?.originalName === 'search_docs'
    );
    expect(call?.tool?.name).toBe('tool_use');
  });

  it('unwraps an MCP result payload', () => {
    const result = events.find(
      (e) => e.type === 'tool_result' && e.tool?.originalName === 'search_docs'
    );
    expect(result?.tool?.result).toBe('docs result');
    expect(result?.tool?.success).toBe(true);
  });

  it("prefers bash's own exit code over the update status", () => {
    const result = events.find(
      (e) =>
        e.type === 'tool_result' &&
        e.tool?.originalName === 'run_terminal_command'
    );
    // status was "completed" — the command itself exited 1.
    expect(result?.tool?.success).toBe(false);
    expect(result?.tool?.result).toBe('exit: 1\nconnection refused\n');
  });

  it('emits one result per call, ignoring intermediate updates', () => {
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(3);
  });

  it('keeps calls and results paired by id', () => {
    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(calls.map((e) => e.tool?.id).sort()).toEqual(
      results.map((e) => e.tool?.id).sort()
    );
  });
});

describe('grok parser: tool names', () => {
  it('maps the plan tool to the same canonical name as the other agents', () => {
    // Claude Code's `TodoWrite` and opencode's `todowrite` are both agent_task;
    // leaving Grok's `todo_write` unmapped would undercount it in comparisons.
    const raw = JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call-t-0',
      toolName: 'todo_write',
      rawInput: { todos: [{ id: '1', content: 'start', status: 'pending' }] },
    });
    const { events } = grokParser.parseTranscript(raw);
    expect(events[0].tool?.name).toBe('agent_task');
  });

  it('reads a tool id out of rawInput.variant when toolName is a title', () => {
    // Web search really does arrive like this — a display title, with the id
    // only in `variant`.
    const raw = JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call-w-0',
      toolName: 'Web search:',
      rawInput: { variant: 'WebSearch', backend: true },
    });
    const { events } = grokParser.parseTranscript(raw);
    expect(events[0].tool?.name).toBe('web_search');
    expect(events[0].tool?.originalName).toBe('WebSearch');
  });

  it('keeps a known toolName even when rawInput carries a variant', () => {
    const raw = JSON.stringify({
      type: 'tool_call',
      toolCallId: 'call-r-0',
      toolName: 'read_file',
      rawInput: { target_file: 'NOTES.md', variant: 'Something' },
    });
    const { events } = grokParser.parseTranscript(raw);
    expect(events[0].tool?.name).toBe('file_read');
  });
});

describe('grok parser: unterminated calls', () => {
  it('still reports a call whose run was cut short', () => {
    const raw = [
      JSON.stringify({
        type: 'tool_call',
        toolCallId: 'call-x-0',
        toolName: 'run_terminal_command',
        rawInput: { command: 'sleep 900' },
      }),
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 'call-x-0',
        status: null,
        rawOutput: null,
      }),
    ].join('\n');
    const { events } = grokParser.parseTranscript(raw);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.tool?.originalName).toBe('run_terminal_command');
    expect(result?.tool?.success).toBeUndefined();
  });
});

describe('grok runner', () => {
  it('maps end_turn to the canonical stop reason', () => {
    const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
    expect(grokRunner.deriveStopReason!(SESSION, ok)).toBe('stop');
  });

  it('surfaces a non-end_turn stop reason verbatim', () => {
    const raw = JSON.stringify({ type: 'end', stopReason: 'max_turns' });
    const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
    expect(grokRunner.deriveStopReason!(raw, ok)).toBe('max_turns');
  });

  it('treats an error event with no terminal end as a failed run', () => {
    const raw = JSON.stringify({ type: 'error', message: 'rate limited' });
    const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
    expect(grokRunner.deriveStopReason!(raw, ok)).toBe('error');
  });

  it('lets a clean end outrank an error the run recovered from', () => {
    // Grok emits `error` for recoverable faults too, so an error before a
    // terminal end_turn is a retry that worked, not a failed run.
    const raw = [
      JSON.stringify({ type: 'error', message: 'rate limited, retrying' }),
      JSON.stringify({ type: 'end', stopReason: 'end_turn' }),
    ].join('\n');
    const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
    expect(grokRunner.deriveStopReason!(raw, ok)).toBe('stop');
  });

  it('folds cache reads into inputTokens, which Grok reports separately', () => {
    const usage = grokRunner.extractUsage!(SESSION, 'grok-4.6');
    expect(usage).toEqual([
      {
        model: 'grok-4.6',
        // 15733 reported + 384 cache read = every input token billed.
        inputTokens: 16117,
        cacheReadInputTokens: 384,
        cacheWriteInputTokens: 0,
        outputTokens: 155,
      },
    ]);
  });

  it('reports no usage for a truncated run, as the other CLI agents do', () => {
    // Same stream, cut before `end` — what a harness-killed run leaves behind.
    // The mid-run `usage` events could be summed into a total, but Claude Code
    // and Codex both lose usage on a timeout, and recovering it for Grok alone
    // would make it the only agent whose timeouts land in a cost comparison.
    const truncated = SESSION.split('\n')
      .filter((line) => !line.includes('"end"'))
      .join('\n');
    expect(truncated).toContain('"usage"');
    expect(grokRunner.extractUsage!(truncated, 'grok-4.6')).toBeUndefined();
  });

  it('reports no usage for a run that never reached the model', () => {
    expect(grokRunner.extractUsage!('', 'grok-4.6')).toBeUndefined();
  });

  it('writes MCP servers as a TOML table with a nested env table', () => {
    const toml = buildGrokConfig({
      'supabase-mcp': {
        command: 'npx',
        args: ['-y', '@supabase/mcp-server-supabase'],
        env: { SUPABASE_ACCESS_TOKEN: 'sbp_test' },
      },
    });
    expect(toml).toContain('[mcp_servers.supabase-mcp]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "@supabase/mcp-server-supabase"]');
    expect(toml).toContain('[mcp_servers.supabase-mcp.env]');
    expect(toml).toContain('SUPABASE_ACCESS_TOKEN = "sbp_test"');
  });

  it('disables the skills marketplace so no skill arrives over the network', () => {
    expect(buildGrokConfig({})).toContain('[marketplace]');
  });
});

describe('grok runner: GROK_HOME', () => {
  // `docker exec --env` forwards values verbatim. A `$HOME` passed that way
  // reaches the CLI unexpanded, resolves relative to the cwd, and lands Grok's
  // state in a directory literally named `$HOME` inside the scored workspace —
  // where it also never finds the config.toml staged at the real path, so MCP
  // servers silently never connect. It has to be assigned in the shell instead.
  const EXPANDS = 'GROK_HOME="$HOME/.eval/grok"';

  it('assigns GROK_HOME in the shell when running the agent', async () => {
    const { sandbox, calls } = recordingSandbox();
    await grokRunner.exec({
      sandbox,
      model: 'grok-4.6',
      apiKey: 'xai-test',
      userPromptPath: '"$HOME/.eval/user-prompt.txt"',
      mcpServers: {},
      timeoutSec: 60,
    });
    const run = calls.at(-1)!;
    expect(run.command).toContain(EXPANDS);
    expect(run.env).not.toHaveProperty('GROK_HOME');
  });

  it('assigns GROK_HOME in the shell when unpacking the binary', async () => {
    const { sandbox, calls } = recordingSandbox();
    await grokRunner.install(sandbox, grokRunner.defaultCliVersion, 'xai-test');
    const warmup = calls.at(-1)!;
    expect(warmup.command).toContain(EXPANDS);
    expect(warmup.env).not.toHaveProperty('GROK_HOME');
  });
});
