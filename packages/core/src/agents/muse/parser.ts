/**
 * Muse Code transcript parser, for the session logs Muse writes to disk
 * (`<XDG_DATA_HOME>/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, plus
 * one log per child session under it). The runner concatenates the main log
 * and its child logs; see ./runner.ts for why stdout isn't used.
 *
 * Each line is an envelope:
 *   {"schema_version":1,"stream":{"kind":"session","id":"<session>"},
 *    "sequence":N,"recorded_at":<µs>,"payload_type":"…","payload":{…}}
 * A log also opens with a `retained_frame` line (a permission transaction),
 * and holds `retained_marker` lines where Muse dropped a live-only progress
 * record. Neither carries transcript content.
 *
 * The transcript comes from `runtime.session` records whose payload is
 * `{"kind":"run","event":{"kind":…}}`. These shapes are from real runs of the
 * pinned build against Meta's API, and match the session-log reader bundled
 * in the binary for Muse's own `read-session` skill:
 *   started                       the prompt; its time is `promptAt`
 *   model_response_created        opens a model request (`response_id`)
 *   model_completed               that request's token usage
 *   assistant_message_committed   assistant text for a `response_id`
 *   reasoning_summary_committed   a readable summary of the request's reasoning
 *   assistant_tool_calls_committed  `tool_calls: [{call_id, name, args}]`
 *   tool_result_batch_committed   `results: [{tool_call_id, text}]`, the text
 *                                 the model saw
 *   run_fatal_error_classified    `error_class` of a failed run
 *   terminal                      `completed` / `failed` / …, with `reason`
 * Whether a tool call succeeded comes from its task: a `tool.<name>` task is
 * scheduled with idempotency key `tool:<call_id>` and ends `completed`,
 * `failed`, `cancelled`, or `rejected`.
 *
 * Sessions play three roles. The main session is the agent. Subagents it
 * spawns do the agent's work, so their tool calls are part of the transcript.
 * Reminder agents (skill-, goal-, verify-reminder) watch the agent and nudge
 * it; they are the harness's own model calls. Every session's requests count
 * toward usage and appear as request markers, but only the main session's text
 * is the agent's.
 *
 * The parser is strict on purpose. The version is pinned, so an envelope, run
 * event, task, or payload type it doesn't know means the parser is missing
 * something that may matter to scoring. It throws, the run is recorded as
 * errored rather than scored, and the gap is fixed from the real record.
 */

import { isRecord } from '../../json.js';
import type {
  ParsedTranscript,
  RequestUsage,
  ToolCall,
  TranscriptEvent,
} from '../../transcript/types.js';
import type { AgentTranscriptParser } from '../../parsers/types.js';
import type { AgentUsage } from '../../eval-metadata.js';
import {
  normalizeToolName,
  type AgentToolMap,
} from '../../parsers/shared/normalize.js';
import {
  extractArgs,
  extractLoadedSkillsFromText,
  type ArgFieldMap,
} from '../../parsers/shared/extract.js';

/** One envelope record from a Muse session log. */
interface MuseRecord {
  sessionId: string;
  sequence: number;
  payloadSchemaVersion: unknown;
  /** Epoch microseconds. */
  recordedAt: number;
  payloadType: string;
  payload: Record<string, unknown>;
}

/**
 * Muse's built-in tool names (its default toolset, from the model request the
 * pinned build sends), and the canonical names they map to. Tools without a
 * canonical counterpart (memory, goals, cron, workflow) stay `unknown`, with
 * their raw name kept.
 */
const MUSE_TOOLS: AgentToolMap = {
  tools: {
    read_file: 'file_read',
    write_file: 'file_write',
    edit_file: 'file_edit',
    bash: 'shell',
    // Sends input to a command `bash` left running.
    bash_input: 'shell',
    // ripgrep over the workspace.
    search: 'grep',
    web_search: 'web_search',
    web_fetch: 'web_fetch',
    subagent_spawn: 'agent_task',
    subagent_status: 'agent_task',
    subagent_send_message: 'agent_task',
    subagent_wait: 'agent_task',
    subagent_read_result: 'agent_task',
    subagent_cancel: 'agent_task',
    // Claude Code's TodoWrite and Grok's todo_write map the same way.
    write_todos: 'agent_task',
  },
};

/** Where Muse's tools put the fields scorers read, from their schemas. */
const MUSE_ARG_FIELDS: ArgFieldMap = {
  path: ['path'],
  command: ['command'],
  url: ['url'],
  cwd: ['workdir'],
};

/**
 * Tool result run events. Real runs use `tool_result_batch_committed`; the
 * session reader bundled with Muse also accepts the other three, so they are
 * read the same way rather than rejected.
 */
const TOOL_RESULT_EVENTS = new Set([
  'tool_result_batch_committed',
  'tool_result',
  'tool_results_committed',
  'tool_result_committed',
]);

/** Run event kinds the parser reads. */
const HANDLED_RUN_EVENTS = new Set([
  'started',
  'model_response_created',
  'model_completed',
  'assistant_message_committed',
  'assistant_tool_calls_committed',
  'reasoning_summary_committed',
  'run_fatal_error_classified',
  'terminal',
  ...TOOL_RESULT_EVENTS,
]);

/**
 * Run event kinds that carry nothing the transcript needs: context assembly,
 * request configuration, reasoning deltas, reminder decisions, compaction,
 * hooks, workflows, and resource sampling. Taken from real runs and from the
 * event names compiled into the pinned binary. Listed rather than ignored by
 * default so a new kind fails loudly.
 */
const IGNORED_RUN_EVENTS = new Set([
  'code_mode_cell_grant_recorded',
  'code_mode_profile_activated',
  'context_block_diagnostic',
  'context_block_updated',
  'context_compaction_candidate',
  'context_compaction_fallback',
  'context_compaction_installed',
  'context_projection_checkpoint',
  'fork_child_seed_snapshot',
  'goal_progress_nudge_fired',
  'goal_usage_attribution',
  'hook_decision_applied',
  'hook_run_started',
  'hook_run_terminal',
  'inbox_delivery_anomaly',
  'inbox_item_drained',
  'inbox_item_queued',
  'memory_reminder_child_session_linked',
  'model_input_file_unavailable',
  'model_input_file_uploaded',
  'model_input_trace_recorded',
  'model_request_configured',
  'provider_request_options_configured',
  'reasoning_committed',
  'reasoning_delta',
  'reasoning_summary_delta',
  'reminder_installed',
  'reminder_proposal',
  'reminder_reconciler_outcome',
  'reminder_snoozed',
  'resource_usage_sampled',
  'skill_read_observed',
  'skill_reminder_decision',
  'source_dirty_excluded',
  'subagent_input_command_settled',
  'task_stream_linked',
  'tool_results_cleared',
  'user_input_prompt_requested',
  'user_input_prompt_settled',
  'workflow_child_control_reconciled',
  'workflow_child_control_requested',
  'workflow_child_journal_replay_recorded',
  'workflow_child_lifecycle',
  'workflow_child_result_protocol_recorded',
  'workflow_child_result_submitted',
  'workflow_prompt_proposal_ready',
  'workflow_run_launched',
  'workflow_run_paused',
  'workflow_script_fact',
]);

/**
 * Task kinds the parser accepts. A task is a unit of work Muse schedules: a
 * model response, a reminder agent, a tool call, or a subagent.
 */
const KNOWN_TASK_KINDS = [
  /^model\./,
  /^reminder\.agent\./,
  /^tool\./,
  /^workflow\./,
];

/** Lifecycle steps of a task; only `proposed` names the task's kind. */
const TASK_EVENTS = new Set([
  'proposed',
  'accepted',
  'scheduled',
  'side_effect_intent',
  'started',
  'status',
  'output',
  'tool_delta',
  'tool_output_ref',
  'completed',
  'failed',
  'cancelled',
  'rejected',
]);

/** How a task ended. */
const TASK_ENDINGS = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/**
 * Top-level payload types that carry session bookkeeping only. Two others are
 * read: `runtime.mcp_tool_identity_catalog` (MCP tool names) and
 * `subagent.control.child_session_bound` (which sessions are subagents).
 */
const IGNORED_PAYLOAD_TYPES = new Set([
  'async.owner.attempt_admitted',
  'reminder.cleanup_effect.started',
  'reminder.cleanup_effect.terminal',
  'run.model.configured',
  'runtime.command_intake.received',
  'runtime.command_intake.session_name.received',
  'runtime.command_intake.settled',
  'runtime.mcp_tool_identity_catalog',
  'runtime.retained_fact',
  'runtime.session.capture_selection',
  'runtime.session.metadata',
  'runtime.session.route_facts',
  'runtime.session.task',
  'runtime.session.task_source_committed',
  'runtime.user_intent.accepted',
  'runtime.user_intent.materialized',
  'session.end',
  'session.name.changed',
  'session.opened.observed',
  'session.workspace_branch.observed',
  'subagent.control.attempt_admitted',
  'subagent.control.result_ready',
  'subagent.control.resume_context_recorded',
  'subagent.control.runtime_observed',
  'subagent.control.spawn_accepted',
  'subagent.control.start_attested',
  'subagent.control.status_updated',
  'subagent.control.wait_parked',
  'tool_batch.effect.started',
  'tool_batch.effect.terminal',
]);

const MCP_CATALOG = 'runtime.mcp_tool_identity_catalog';
const SUBAGENT_BOUND = 'subagent.control.child_session_bound';

/** `runtime.session` payload kinds that describe the session, not the run. */
const SESSION_STATE_KINDS = new Set([
  'security_mode',
  'agent_tree_initialized',
]);

/**
 * The string fields each handled run event must carry. A handled event
 * missing one means the schema moved, so it throws rather than yielding a
 * blank report or a default stop reason.
 */
const REQUIRED_STRING_FIELDS: Record<string, readonly string[]> = {
  started: ['prompt'],
  model_response_created: ['response_id'],
  assistant_message_committed: ['response_id', 'text'],
  assistant_tool_calls_committed: ['response_id'],
  reasoning_summary_committed: ['response_id', 'text'],
  run_fatal_error_classified: ['error_class'],
  terminal: ['terminal'],
};

/** Parse and validate every envelope in a session log. Throws on a malformed one. */
export function readMuseRecords(raw: string): MuseRecord[] {
  const records: MuseRecord[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `Muse session log line ${index + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (isRecord(value) && 'retained_frame' in value) continue;
    // A placeholder for a live-only progress record Muse didn't keep (a tool's
    // streaming output, for one). Any other kind of marker is unknown.
    if (isRecord(value) && 'retained_marker' in value) {
      const omitted = value.omitted_record;
      if (
        value.retained_marker === 'omitted_live_only' &&
        isRecord(omitted) &&
        omitted.durability === 'ephemeral'
      ) {
        continue;
      }
      throw new Error(
        `Muse session log line ${index + 1} is a retained marker the parser doesn't know: ${line.slice(0, 200)}`
      );
    }
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      !isRecord(value.stream) ||
      typeof value.stream.id !== 'string' ||
      typeof value.sequence !== 'number' ||
      typeof value.recorded_at !== 'number' ||
      typeof value.payload_type !== 'string' ||
      !isRecord(value.payload)
    ) {
      throw new Error(
        `Muse session log line ${index + 1} is not a schema_version 1 envelope: ${line.slice(0, 200)}`
      );
    }
    records.push({
      sessionId: value.stream.id,
      sequence: value.sequence,
      payloadSchemaVersion: value.payload_schema_version,
      recordedAt: value.recorded_at,
      payloadType: value.payload_type,
      payload: value.payload,
    });
  }
  return records;
}

/**
 * Whether the log records an opened session. Muse writes a log before it
 * fetches the model catalog, so a run that fails at startup (rejected key,
 * unreachable API) leaves a log with only metadata in it.
 */
export function sessionOpened(raw: string): boolean {
  return readMuseRecords(raw).some(
    (r) => r.payloadType === 'session.opened.observed'
  );
}

/** The main session's id, from its `session.opened.observed` record. */
function mainSessionId(records: MuseRecord[]): string {
  for (const r of records) {
    if (r.payloadType !== 'session.opened.observed') continue;
    const id = isRecord(r.payload.record) && r.payload.record.session_id;
    if (typeof id === 'string') return id;
  }
  throw new Error('Muse session log has no session.opened.observed record');
}

/** A run event: `kind` plus its fields, or undefined for other records. */
function runEvent(r: MuseRecord): Record<string, unknown> | undefined {
  if (r.payloadType !== 'runtime.session') return undefined;
  if (r.payload.kind !== 'run' || !isRecord(r.payload.event)) return undefined;
  return r.payload.event;
}

/** A task event: `kind` plus its fields, or undefined for other records. */
function taskEvent(r: MuseRecord): Record<string, unknown> | undefined {
  if (r.payloadType !== 'runtime.session') return undefined;
  if (r.payload.kind !== 'task' || !isRecord(r.payload.event)) return undefined;
  return r.payload.event;
}

function unhandled(r: MuseRecord, what: string): Error {
  return new Error(
    `Muse ${what} is not handled by the parser: ${JSON.stringify(r.payload).slice(0, 300)}`
  );
}

/**
 * Check a record is one the parser understands, with the fields it reads.
 * Throws on anything else.
 */
function assertKnown(r: MuseRecord): void {
  // The session-opening record identifies the main session, so it is read
  // and its payload version matters, unlike the rest of the bookkeeping.
  if (
    r.payloadType === 'session.opened.observed' &&
    r.payloadSchemaVersion !== 1
  ) {
    throw unhandled(
      r,
      `session.opened.observed record with payload_schema_version ${String(r.payloadSchemaVersion)}`
    );
  }
  if (IGNORED_PAYLOAD_TYPES.has(r.payloadType)) return;
  if (r.payloadType === MCP_CATALOG) {
    mcpCatalogEntries(r);
    return;
  }
  if (r.payloadType === SUBAGENT_BOUND) {
    boundSubagent(r);
    return;
  }
  if (r.payloadType !== 'runtime.session') {
    throw unhandled(r, `payload type "${r.payloadType}"`);
  }
  const kind = r.payload.kind;
  if (typeof kind === 'string' && SESSION_STATE_KINDS.has(kind)) return;
  const event = r.payload.event;
  if (!isRecord(event) || typeof event.kind !== 'string') {
    throw unhandled(r, `runtime.session record of kind "${String(kind)}"`);
  }
  // Only the records the parser reads need a known payload version; Muse
  // versions bookkeeping payloads (route facts, agent tree) independently.
  if (r.payloadSchemaVersion !== 1) {
    throw unhandled(
      r,
      `${String(kind)} record with payload_schema_version ${String(r.payloadSchemaVersion)}`
    );
  }
  if (kind === 'task') {
    if (!TASK_EVENTS.has(event.kind)) {
      throw unhandled(r, `task event "${event.kind}"`);
    }
    if (event.kind !== 'proposed') return;
    const taskKind = event.task_kind;
    if (
      typeof taskKind !== 'string' ||
      !KNOWN_TASK_KINDS.some((pattern) => pattern.test(taskKind))
    ) {
      throw unhandled(r, `task kind "${String(taskKind)}"`);
    }
    return;
  }
  if (kind !== 'run') {
    throw unhandled(r, `runtime.session record of kind "${String(kind)}"`);
  }
  if (IGNORED_RUN_EVENTS.has(event.kind)) return;
  if (!HANDLED_RUN_EVENTS.has(event.kind)) {
    throw unhandled(r, `run event "${event.kind}"`);
  }
  for (const field of REQUIRED_STRING_FIELDS[event.kind] ?? []) {
    if (typeof event[field] !== 'string') {
      throw unhandled(r, `${event.kind} event without a string ${field}`);
    }
  }
}

/**
 * Token usage of one `model_completed` event, in this repo's convention
 * (`ModelUsage` in eval-metadata.ts): cache reads and writes are part of
 * `inputTokens`, and reasoning is part of `outputTokens`.
 *
 * Muse follows the same convention, checked against real runs: a follow-up
 * request reported 25,560 input tokens with 24,945 of them cached (the
 * previous request's 25,250-token prompt plus the new turn), and a one-token
 * answer reported 184 output tokens with 173 of them reasoning. A request
 * contradicting that throws instead of being miscounted.
 */
function requestUsage(event: Record<string, unknown>): RequestUsage {
  const usage = event.usage;
  if (!isRecord(usage)) {
    throw new Error('Muse model_completed event has no usage');
  }
  // The first of `keys` present must be a number; `fallback` if none is.
  const count = (keys: readonly string[], fallback?: number) => {
    const key = keys.find((k) => usage[k] !== undefined);
    const value = key === undefined ? fallback : usage[key];
    if (typeof value !== 'number') {
      throw new Error(
        `Muse model_completed usage has no numeric ${keys.join(' or ')}`
      );
    }
    return value;
  };
  const input = count(['input_tokens']);
  const output = count(['output_tokens']);
  // `cached_tokens` is the older name; real runs report both, equal.
  const cacheRead = count(['cache_read_tokens', 'cached_tokens']);
  const cacheWrite = count(['cache_write_tokens'], 0);
  const reasoning = count(['reasoning_tokens'], 0);
  if (cacheRead + cacheWrite > input || reasoning > output) {
    throw new Error(
      `Muse usage breaks its own convention: ${JSON.stringify(usage)} (cache tokens should be part of input, reasoning part of output)`
    );
  }
  return {
    inputTokens: input,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
  };
}

function isoTime(recordedAtMicros: number): string {
  return new Date(Math.floor(recordedAtMicros / 1000)).toISOString();
}

/** Request id unique across the main session and its children. */
function requestKey(sessionId: string, responseId: string): string {
  return `${sessionId}:${responseId}`;
}

/**
 * Sessions that are reminder agents, from the links their parents record.
 * Every other session is the agent (the main session) or a subagent doing
 * its work.
 */
function reminderSessions(records: MuseRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    const event = runEvent(r);
    if (
      event?.kind === 'memory_reminder_child_session_linked' &&
      typeof event.child_session_id === 'string'
    ) {
      ids.add(event.child_session_id);
    }
  }
  return ids;
}

/** A finished task: its kind, how it ended, and the tool call it ran, if any. */
interface TaskOutcome {
  sessionId: string;
  taskKind?: string;
  callId?: string;
  ending?: string;
  reason?: string;
}

/** Every task in the run, keyed by session and task id. */
function taskOutcomes(records: MuseRecord[]): Map<string, TaskOutcome> {
  const tasks = new Map<string, TaskOutcome>();
  for (const r of records) {
    const event = taskEvent(r);
    if (!event || typeof event.task_id !== 'string') continue;
    const key = `${r.sessionId}:${event.task_id}`;
    const task = tasks.get(key) ?? { sessionId: r.sessionId };
    tasks.set(key, task);
    if (event.kind === 'proposed' && typeof event.task_kind === 'string') {
      task.taskKind = event.task_kind;
    } else if (
      event.kind === 'scheduled' &&
      typeof event.idempotency_key === 'string' &&
      event.idempotency_key.startsWith('tool:')
    ) {
      task.callId = event.idempotency_key.slice('tool:'.length);
    } else if (typeof event.kind === 'string' && TASK_ENDINGS.has(event.kind)) {
      task.ending = event.kind;
      if (typeof event.reason === 'string') task.reason = event.reason;
    }
  }
  return tasks;
}

/** The tool a Muse MCP tool name stands for. */
interface McpIdentity {
  server: string;
  toolName: string;
}

/**
 * The entries of an MCP tool identity catalog, checked. Muse gives the model
 * its own name for each MCP tool and records the server's real name here:
 * `mcp__everything__get_env` is the `everything` server's `get-env`.
 */
function mcpCatalogEntries(r: MuseRecord): [string, McpIdentity][] {
  if (r.payloadSchemaVersion !== 1 || !Array.isArray(r.payload.entries)) {
    throw unhandled(r, 'MCP tool identity catalog');
  }
  return r.payload.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.canonical_id !== 'string' ||
      typeof entry.server_name !== 'string' ||
      typeof entry.raw_tool_name !== 'string'
    ) {
      throw unhandled(r, 'MCP tool identity catalog entry');
    }
    return [
      entry.canonical_id,
      { server: entry.server_name, toolName: entry.raw_tool_name },
    ];
  });
}

/** Every MCP tool identity Muse recorded in the run. */
function mcpIdentities(records: MuseRecord[]): Map<string, McpIdentity> {
  const identities = new Map<string, McpIdentity>();
  for (const r of records) {
    if (r.payloadType !== MCP_CATALOG) continue;
    for (const [id, identity] of mcpCatalogEntries(r)) {
      identities.set(id, identity);
    }
  }
  return identities;
}

/** The child session a `child_session_bound` record gives a subagent, checked. */
function boundSubagent(r: MuseRecord): string {
  const bound = r.payload.record;
  if (
    r.payloadSchemaVersion !== 1 ||
    !isRecord(bound) ||
    typeof bound.child_session_id !== 'string' ||
    bound.storage_layout !== 'nested_session_v1'
  ) {
    throw unhandled(r, 'subagent session binding');
  }
  return bound.child_session_id;
}

/** The tool arguments as an object. Unparseable JSON is kept as `raw_args`, as Muse's own reader does. */
function toolArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {}
    return { raw_args: value };
  }
  return {};
}

/**
 * A tool call's identity. Muse names MCP tools `mcp__<server>__<tool>`, as
 * Claude Code does, with the tool's name rewritten for the model; the run's
 * identity catalog gives the server's real name. A name missing from the
 * catalog is split structurally. Anything else is one of Muse's own tools.
 */
function museToolCall(
  rawName: string,
  catalog: Map<string, McpIdentity>
): ToolCall {
  const identity = catalog.get(rawName);
  if (identity) return { kind: 'mcp', ...identity };
  if (rawName.startsWith('mcp__')) {
    const parts = rawName.split('__');
    if (parts.length >= 3) {
      return {
        kind: 'mcp',
        server: parts[1],
        toolName: parts.slice(2).join('__'),
      };
    }
  }
  return { kind: 'other', toolName: rawName };
}

/** Skills a tool call loaded: `read_skill`'s name, or a SKILL.md path read another way. */
function loadedSkills(
  name: string,
  args: Record<string, unknown>,
  path: string | undefined,
  command: string | undefined
): string[] {
  if (name === 'read_skill' && typeof args.name === 'string')
    return [args.name];
  if (path) return extractLoadedSkillsFromText(path);
  if (command) return extractLoadedSkillsFromText(command);
  return [];
}

/** One tool call from an `assistant_tool_calls_committed` event, checked. */
function readToolCall(
  r: MuseRecord,
  call: unknown
): { callId: string; name: string; args: Record<string, unknown> } {
  if (!isRecord(call) || typeof call.name !== 'string') {
    throw unhandled(r, 'tool call without a name');
  }
  const callId = call.call_id ?? call.id;
  if (typeof callId !== 'string') {
    throw unhandled(r, `tool call "${call.name}" without a call id`);
  }
  return { callId, name: call.name, args: toolArgs(call.args) };
}

/** The results of a tool result event, checked: one per call. */
function readToolResults(
  r: MuseRecord,
  event: Record<string, unknown>
): { callId: string; text: unknown }[] {
  const results = Array.isArray(event.results) ? event.results : [event];
  return results.map((result) => {
    const callId = isRecord(result)
      ? (result.tool_call_id ?? result.call_id)
      : undefined;
    if (!isRecord(result) || typeof callId !== 'string') {
      throw unhandled(r, 'tool result without a call id');
    }
    return {
      callId,
      text: result.text ?? result.output ?? result.result ?? '',
    };
  });
}

export const museParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const records = readMuseRecords(raw);
    for (const r of records) assertKnown(r);
    const main = mainSessionId(records);
    assertChildLogsPresent(records, main);
    const reminders = reminderSessions(records);
    const catalog = mcpIdentities(records);

    // How each tool call ended, from its task.
    const callSucceeded = new Map<string, boolean>();
    for (const task of taskOutcomes(records).values()) {
      if (!task.callId || !task.ending) continue;
      callSucceeded.set(
        `${task.sessionId}:${task.callId}`,
        task.ending === 'completed'
      );
    }

    const events: TranscriptEvent[] = [];
    // Each event's record time in microseconds, for ordering across sessions;
    // the events' own timestamps only keep milliseconds.
    const recordedAt = new Map<TranscriptEvent, number>();
    const push = (event: TranscriptEvent, r: MuseRecord) => {
      recordedAt.set(event, r.recordedAt);
      events.push(event);
    };
    // The open model request per session: Muse emits a response's text and
    // usage after `model_response_created` for that session.
    const openRequest = new Map<string, string>();
    // A request's first event, which carries its usage.
    const eventByRequest = new Map<string, TranscriptEvent>();
    // Tool names by call, to label results.
    const callNames = new Map<string, string>();

    for (const r of records) {
      const event = runEvent(r);
      if (!event) continue;
      const timestamp = isoTime(r.recordedAt);
      const isMain = r.sessionId === main;
      const isAgent = !reminders.has(r.sessionId);
      const requestOf = (responseId: unknown) =>
        typeof responseId === 'string'
          ? requestKey(r.sessionId, responseId)
          : undefined;

      switch (event.kind) {
        case 'model_response_created': {
          openRequest.set(r.sessionId, event.response_id as string);
          break;
        }
        case 'assistant_message_committed': {
          if (!isMain) break;
          const requestId = requestOf(event.response_id);
          const content = event.text as string;
          // Muse logs a response's usage before committing its text, so the
          // request usually has an empty marker already; the text fills it.
          const marker = requestId && eventByRequest.get(requestId);
          if (marker && marker.type === 'message' && !marker.content) {
            marker.content = content;
            marker.raw = r.payload;
            break;
          }
          const message: TranscriptEvent = {
            timestamp,
            type: 'message',
            role: 'assistant',
            content,
            ...(requestId ? { requestId } : {}),
            raw: r.payload,
          };
          if (requestId && !marker) eventByRequest.set(requestId, message);
          push(message, r);
          break;
        }
        case 'reasoning_summary_committed': {
          if (!isMain) break;
          push(
            {
              timestamp,
              type: 'thinking',
              content: event.text as string,
              requestId: requestOf(event.response_id),
              raw: r.payload,
            },
            r
          );
          break;
        }
        case 'model_completed': {
          const responseId = openRequest.get(r.sessionId);
          const usage = requestUsage(event);
          const requestId = requestOf(responseId);
          const first = requestId && eventByRequest.get(requestId);
          if (first) {
            first.usage = usage;
            break;
          }
          // A request with no event yet: an empty marker keeps its usage and
          // time. Text committed later fills it; a child session's request
          // stays a marker, since its text isn't the agent's.
          const marker: TranscriptEvent = {
            timestamp,
            type: 'message',
            role: 'assistant',
            content: '',
            ...(requestId ? { requestId } : {}),
            usage,
            raw: r.payload,
          };
          if (requestId) eventByRequest.set(requestId, marker);
          push(marker, r);
          break;
        }
        case 'assistant_tool_calls_committed': {
          if (!Array.isArray(event.tool_calls)) {
            throw unhandled(
              r,
              'assistant_tool_calls_committed without tool_calls'
            );
          }
          const calls = event.tool_calls.map((call) => readToolCall(r, call));
          if (!isAgent) break;
          const requestId = requestOf(event.response_id);
          for (const { callId, name, args } of calls) {
            callNames.set(callId, name);
            const { path, command, url, cwd } = extractArgs(
              args,
              MUSE_ARG_FIELDS
            );
            const skills = loadedSkills(name, args, path, command);
            push(
              {
                timestamp,
                ...(requestId ? { requestId } : {}),
                type: 'tool_call',
                tool: {
                  name: normalizeToolName(name, MUSE_TOOLS),
                  originalName: name,
                  call: museToolCall(name, catalog),
                  id: callId,
                  args,
                  ...(path ? { path } : {}),
                  ...(command ? { command } : {}),
                  ...(url ? { url } : {}),
                  ...(cwd ? { cwd } : {}),
                  ...(skills.length > 0 ? { loadedSkills: skills } : {}),
                },
                raw: r.payload,
              },
              r
            );
          }
          break;
        }
        case 'run_fatal_error_classified': {
          if (!isMain) break;
          push(
            {
              timestamp,
              type: 'error',
              content: `Muse run failed: ${String(event.error_class)}`,
              raw: r.payload,
            },
            r
          );
          break;
        }
        default: {
          if (!TOOL_RESULT_EVENTS.has(event.kind as string)) break;
          const results = readToolResults(r, event);
          if (!isAgent) break;
          for (const { callId, text } of results) {
            const name = callNames.get(callId) ?? 'unknown';
            const success = callSucceeded.get(`${r.sessionId}:${callId}`);
            push(
              {
                timestamp,
                type: 'tool_result',
                tool: {
                  name: normalizeToolName(name, MUSE_TOOLS),
                  originalName: name,
                  id: callId,
                  result: text,
                  ...(success === undefined ? {} : { success }),
                },
                raw: r.payload,
              },
              r
            );
          }
          break;
        }
      }
    }

    // Child logs follow the main log in `raw`; order everything by record time
    // so a subagent's calls sit where they happened. The sort is stable, so
    // events from one record keep their order.
    events.sort((a, b) => (recordedAt.get(a) ?? 0) - (recordedAt.get(b) ?? 0));
    return { events, errors: [] };
  },
};

/**
 * Every child session a parent says has a log (a reminder with a log path, or
 * a bound subagent) must be in `raw`, or its tool calls and model usage would
 * be missing with nothing failing. Only
 * checked once the main run has reached a terminal event: a run killed at the
 * time limit can link a child before the child's log is written.
 *
 * Muse writes no log for some reminder children (the skill reminder, in the
 * pinned build) and records their token usage nowhere, so those calls are
 * missing from usage regardless. In a traced test run, the skill reminder's
 * one request was 12,810 of 44,724 input tokens; the gap shrinks as the
 * agent's own requests grow.
 */
function assertChildLogsPresent(records: MuseRecord[], main: string): void {
  const finished = records.some(
    (r) => r.sessionId === main && runEvent(r)?.kind === 'terminal'
  );
  if (!finished) return;
  const present = new Set(records.map((r) => r.sessionId));
  for (const r of records) {
    if (r.payloadType === SUBAGENT_BOUND) {
      const child = boundSubagent(r);
      if (!present.has(child)) {
        throw new Error(
          `Muse subagent session ${child} has no log in the run's logs`
        );
      }
      continue;
    }
    const event = runEvent(r);
    if (
      event?.kind === 'memory_reminder_child_session_linked' &&
      typeof event.child_session_log_path === 'string' &&
      typeof event.child_session_id === 'string' &&
      !present.has(event.child_session_id)
    ) {
      throw new Error(
        `Muse child session ${event.child_session_id} has a log (${event.child_session_log_path}) that was not read`
      );
    }
  }
}

/** A failure in one session of the run that ended that session's work. */
export interface MuseFatalError {
  sessionId: string;
  isMain: boolean;
  /**
   * Muse's error class, or `provider_error` for a model request that failed
   * without one (Muse leaves a request for a nonexistent model unclassified,
   * for example).
   */
  errorClass: string;
  /** The session's own explanation. */
  reason?: string;
}

/**
 * Every fatal failure recorded in the run, from the main session and its
 * children, whether or not a terminal event followed it.
 */
export function fatalErrors(raw: string): MuseFatalError[] {
  const records = readMuseRecords(raw);
  const main = mainSessionId(records);
  const errors: MuseFatalError[] = [];
  for (const r of records) {
    const event = runEvent(r);
    if (
      event?.kind === 'run_fatal_error_classified' &&
      typeof event.error_class === 'string'
    ) {
      errors.push({
        sessionId: r.sessionId,
        isMain: r.sessionId === main,
        errorClass: event.error_class,
      });
    } else if (event?.kind === 'terminal' && typeof event.reason === 'string') {
      const open = [...errors]
        .reverse()
        .find((e) => e.sessionId === r.sessionId && e.reason === undefined);
      if (open) open.reason = event.reason;
    }
  }
  // A model request Muse gave up on (after its own retries) with no error
  // class in that session: the provider refused or failed it.
  const classified = new Set(errors.map((e) => e.sessionId));
  for (const task of taskOutcomes(records).values()) {
    if (
      task.ending === 'failed' &&
      task.taskKind?.startsWith('model.') &&
      !classified.has(task.sessionId)
    ) {
      errors.push({
        sessionId: task.sessionId,
        isMain: task.sessionId === main,
        errorClass: 'provider_error',
        ...(task.reason ? { reason: task.reason } : {}),
      });
    }
  }
  return errors;
}

/** The main session's last terminal event, with the error class that preceded it. */
export function lastTerminal(
  raw: string | undefined
): { terminal: string; reason?: string; errorClass?: string } | undefined {
  if (!raw) return undefined;
  const records = readMuseRecords(raw);
  const main = mainSessionId(records);
  let errorClass: string | undefined;
  let terminal:
    | { terminal: string; reason?: string; errorClass?: string }
    | undefined;
  for (const r of records) {
    if (r.sessionId !== main) continue;
    const event = runEvent(r);
    if (event?.kind === 'run_fatal_error_classified') {
      errorClass =
        typeof event.error_class === 'string' ? event.error_class : undefined;
    } else if (
      event?.kind === 'terminal' &&
      typeof event.terminal === 'string'
    ) {
      terminal = {
        terminal: event.terminal,
        ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
        ...(errorClass ? { errorClass } : {}),
      };
    }
  }
  return terminal;
}

/**
 * Model responses of the agent itself: the main session's `model_completed`
 * events. Reminder agents and subagents are excluded here but included in
 * usage, matching Claude Code and Grok, whose step count is the main
 * conversation's `num_turns` while their usage covers every model call.
 */
export function modelRequestCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const records = readMuseRecords(raw);
  const main = mainSessionId(records);
  const n = records.filter(
    (r) => r.sessionId === main && runEvent(r)?.kind === 'model_completed'
  ).length;
  return n || undefined;
}

/**
 * Whole-run token usage per model: every request in the main session and its
 * child sessions that Muse logged (see `assertChildLogsPresent` for the ones
 * it doesn't). Each request names the model that served it; `model` is the
 * fallback for one that doesn't.
 */
export function sessionUsage(
  raw: string | undefined,
  model: string
): AgentUsage | undefined {
  if (!raw) return undefined;
  const byModel = new Map<string, AgentUsage[number]>();
  for (const r of readMuseRecords(raw)) {
    const event = runEvent(r);
    if (event?.kind !== 'model_completed') continue;
    const usage = requestUsage(event);
    const served = typeof event.model === 'string' ? event.model : model;
    const totals = byModel.get(served) ?? {
      model: served,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    };
    totals.inputTokens += usage.inputTokens;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens;
    totals.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    totals.outputTokens += usage.outputTokens;
    byModel.set(served, totals);
  }
  return byModel.size > 0 ? [...byModel.values()] : undefined;
}

/** Epoch ms when the main session's run started (the prompt's time). */
export function sessionPromptAt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const records = readMuseRecords(raw);
  const main = mainSessionId(records);
  for (const r of records) {
    if (r.sessionId === main && runEvent(r)?.kind === 'started') {
      return Math.floor(r.recordedAt / 1000);
    }
  }
  return undefined;
}
