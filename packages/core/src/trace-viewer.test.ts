import { describe, expect, it } from 'vitest';
import { evalResultToTraceSpans } from './trace-viewer.js';
import type { ToolCallRecord, TranscriptPart } from './index.js';
import type { SkillResult } from './eval-metadata.js';
import type { CheckResult } from './eval-metadata.js';

const transcript: TranscriptPart[] = [
  {
    type: 'message',
    role: 'user',
    content: 'Why is my RLS policy blocking reads?',
  },
  { type: 'message', role: 'assistant', content: 'Let me load the RLS skill.' },
  {
    type: 'tool_call',
    name: 'load_skill',
    input: { skill_name: 'supabase-rls' },
    output: { instructions: '...' },
  },
  {
    type: 'tool_call',
    name: 'sql',
    input: { query: 'select * from policies;' },
    error: 'permission denied',
  },
];

const toolCalls: ToolCallRecord[] = [
  {
    endpoint: 'load_skill',
    body: { skill_name: 'supabase-rls' },
    loadedSkills: ['supabase-rls'],
    result: { instructions: '...' },
    ts: 0,
  },
  {
    endpoint: 'sql',
    body: { query: 'select * from policies;' },
    error: 'permission denied',
    ts: 0,
  },
];

const skills: SkillResult = {
  available: ['supabase-rls', 'supabase-migrations', 'supabase-cli'],
  loaded: ['supabase-rls'],
};

const checks: CheckResult[] = [
  { name: 'rls policy correct', passed: false, notes: 'missed USING clause' },
];

describe('evalResultToTraceSpans', () => {
  const data = evalResultToTraceSpans({
    evalId: 'investigate-rls-01',
    passed: false,
    transcript,
    toolCalls,
    agentReport: 'The policy is missing a USING clause.',
    skills,
    checks,
    experimentDisplay: { agent: 'ai-sdk', modelId: 'claude-sonnet-5' },
    attempts: 2,
  });

  it('returns one root agent_invocation span wrapping all children', () => {
    expect(data.spans).toHaveLength(1);
    const root = data.spans[0]!;
    expect(root.type).toBe('agent_invocation');
    expect(root.id).toBe('eval:investigate-rls-01');
    expect(root.status).toBe('error'); // passed=false
    expect(root.output).toBe('The policy is missing a USING clause.');
    // user + assistant + 2 tool calls + 1 failed check
    expect(root.children).toHaveLength(5);
  });

  it('maps assistant messages to llm_call and user/system to event', () => {
    const children = data.spans[0]!.children!;
    expect(children[0]!.type).toBe('event'); // user
    expect(children[0]!.title).toBe('User');
    expect(children[1]!.type).toBe('llm_call'); // assistant
    expect(children[1]!.title).toBe('Assistant');
  });

  it('puts a user message under `input`, not `output` (it fed INTO the turn, not out of it)', () => {
    const user = data.spans[0]!.children![0]!;
    expect(user.input).toBe('Why is my RLS policy blocking reads?');
    expect(user.output).toBeUndefined();
  });

  it('puts an assistant message under `output`, not `input` (it is the turn output)', () => {
    const assistant = data.spans[0]!.children![1]!;
    expect(assistant.output).toBe('Let me load the RLS skill.');
    expect(assistant.input).toBeUndefined();
  });

  it('pairs tool_call parts with ToolCallRecords by order and copies loadedSkills as attributes', () => {
    const children = data.spans[0]!.children!;
    const loadSkill = children[2]!;
    expect(loadSkill.type).toBe('tool_execution');
    expect(loadSkill.title).toBe('Tool: load_skill');
    expect(loadSkill.status).toBe('success');
    expect(loadSkill.attributes).toEqual([
      { key: 'skill', value: { stringValue: 'supabase-rls' } },
    ]);
  });

  it('marks a tool_call with an error as error status and surfaces the error as output', () => {
    const sql = data.spans[0]!.children![3]!;
    expect(sql.type).toBe('tool_execution');
    expect(sql.status).toBe('error');
    expect(sql.output).toBe('permission denied');
  });

  it('adds an error event span per failed check', () => {
    const checkSpan = data.spans[0]!.children![4]!;
    expect(checkSpan.type).toBe('event');
    expect(checkSpan.status).toBe('error');
    expect(checkSpan.title).toContain('rls policy correct');
  });

  it('records span count and builds badges', () => {
    expect(data.traceRecord.id).toBe('investigate-rls-01');
    expect(data.traceRecord.spansCount).toBe(6); // root + 5 children
    expect(data.traceRecord.agentDescription).toBe('claude-sonnet-5');
    const labels = data.badges.map((b) => b.label);
    expect(labels).toContain('Failed');
    expect(labels).toContain('1/3 skills');
    expect(labels).toContain('2 attempts');
    expect(labels).toContain('claude-sonnet-5');
  });

  it('sets tokensCount on assistant spans from real per-turn usage', () => {
    const withUsage: TranscriptPart[] = [
      {
        type: 'message',
        role: 'assistant',
        content: 'Loading a skill.',
        usage: { inputTokens: 500, outputTokens: 20, totalTokens: 520 },
      },
    ];
    const data = evalResultToTraceSpans({
      evalId: 'e3',
      passed: true,
      transcript: withUsage,
      toolCalls: [],
      agentReport: 'done',
    });
    expect(data.spans[0]!.children![0]!.tokensCount).toBe(520);
    expect(data.traceRecord.totalTokens).toBe(520);
  });

  it('leaves tokensCount undefined when a turn has no usage', () => {
    const noUsage: TranscriptPart[] = [
      { type: 'message', role: 'assistant', content: 'No usage here.' },
    ];
    const data = evalResultToTraceSpans({
      evalId: 'e4',
      passed: true,
      transcript: noUsage,
      toolCalls: [],
      agentReport: 'done',
    });
    expect(data.spans[0]!.children![0]!.tokensCount).toBeUndefined();
    expect(data.traceRecord.totalTokens).toBeUndefined();
  });

  it('attributes the context-size jump between two turns to a load_skill span in the gap', () => {
    const withSkillLoad: TranscriptPart[] = [
      {
        type: 'message',
        role: 'assistant',
        content: "I'll load the RLS skill.",
        usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
      },
      {
        type: 'tool_call',
        name: 'load_skill',
        input: { skill_name: 'supabase-rls' },
        output: { instructions: '...' },
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Now applying the fix.',
        // Context grew by 1800 tokens (2800 - 1000) after the skill loaded —
        // that's the skill fragment's real cost in this run's context window.
        usage: { inputTokens: 2800, outputTokens: 15, totalTokens: 2815 },
      },
    ];
    const skillLoadCalls: ToolCallRecord[] = [
      {
        endpoint: 'load_skill',
        body: { skill_name: 'supabase-rls' },
        loadedSkills: ['supabase-rls'],
        result: { instructions: '...' },
        ts: 0,
      },
    ];

    const data = evalResultToTraceSpans({
      evalId: 'e5',
      passed: true,
      transcript: withSkillLoad,
      toolCalls: skillLoadCalls,
      agentReport: 'done',
    });

    const children = data.spans[0]!.children!;
    expect(children[0]!.tokensCount).toBe(1010); // first turn's own cost
    expect(children[1]!.title).toBe('Tool: load_skill');
    expect(children[1]!.tokensCount).toBe(1800); // context growth attributed to the load
    expect(children[2]!.tokensCount).toBe(2815); // second turn's own cost
  });

  it('attributes context growth to skill loads that closed an earlier turn, once a later turn reveals the delta', () => {
    // Reproduces a real ai-sdk run shape: text ("I'll load skills") is its own
    // step with no usage recorded on it; the SECOND load_skill call is what
    // closes step 1 (usage.inputTokens=6000 is the baseline BEFORE either
    // load's result lands in context — results only show up in the NEXT
    // turn's inputTokens). `list_projects` closes step 2 with inputTokens
    // jumping to 11500 — that whole 5500-token jump is what step 1 (both
    // loads' results, since no baseline existed before them either) added,
    // split evenly across the two load_skill spans since they're the only
    // ones in the gap.
    const stepShapedRun: TranscriptPart[] = [
      {
        type: 'message',
        role: 'assistant',
        content: "I'll load skills first.",
      },
      { type: 'tool_call', name: 'load_skill', input: { name: 'supabase' } },
      {
        type: 'tool_call',
        name: 'load_skill',
        input: { name: 'supabase-postgres-best-practices' },
        output: { instructions: 'b' },
        usage: { inputTokens: 6000, outputTokens: 200, totalTokens: 6200 },
      },
      {
        type: 'tool_call',
        name: 'list_projects',
        output: { projects: [] },
        usage: { inputTokens: 11500, outputTokens: 300, totalTokens: 11800 },
      },
    ];
    const stepShapedCalls: ToolCallRecord[] = [
      {
        endpoint: 'load_skill',
        body: { name: 'supabase' },
        loadedSkills: ['supabase'],
        ts: 0,
      },
      {
        endpoint: 'load_skill',
        body: { name: 'supabase-postgres-best-practices' },
        loadedSkills: ['supabase-postgres-best-practices'],
        result: { instructions: 'b' },
        ts: 0,
      },
      {
        endpoint: 'list_projects',
        body: {},
        result: { projects: [] },
        ts: 0,
      },
    ];

    const data = evalResultToTraceSpans({
      evalId: 'e-step-shaped',
      passed: true,
      transcript: stepShapedRun,
      toolCalls: stepShapedCalls,
      agentReport: 'done',
    });

    const children = data.spans[0]!.children!;
    // children: [Assistant, Tool: load_skill(supabase), Tool: load_skill(pg-bp), Tool: list_projects]
    const firstLoad = children[1]!;
    const secondLoad = children[2]!;
    const listProjects = children[3]!;
    expect(firstLoad.title).toBe('Tool: load_skill');
    expect(secondLoad.title).toBe('Tool: load_skill');
    expect(listProjects.title).toBe('Tool: list_projects');

    // No prior turn existed before step 1 closed, so its own turn-closing
    // usage (6200) never leaks onto the load span that carried it — only the
    // delta-attribution pass sets tokensCount on a load span.
    // Delta since the run's start (there's no earlier resolved baseline) to
    // step 2's inputTokens (11500) is 11500 - 6000 = 5500, split across the
    // two pending loads = 2750 each.
    expect(firstLoad.tokensCount).toBe(2750);
    expect(secondLoad.tokensCount).toBe(2750);
    // list_projects itself never gets a delta-attributed cost (only
    // load_skill spans do) and closed no further turn to attribute anything.
    expect(listProjects.tokensCount).toBeUndefined();
  });

  it('splits a context-size jump evenly across multiple skill loads in the same gap', () => {
    const twoLoads: TranscriptPart[] = [
      {
        type: 'message',
        role: 'assistant',
        content: 'Loading two skills.',
        usage: { inputTokens: 500, outputTokens: 5, totalTokens: 505 },
      },
      {
        type: 'tool_call',
        name: 'load_skill',
        input: { skill_name: 'supabase' },
        output: { instructions: 'a' },
      },
      {
        type: 'tool_call',
        name: 'load_skill',
        input: { skill_name: 'supabase-postgres-best-practices' },
        output: { instructions: 'b' },
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Continuing.',
        usage: { inputTokens: 1500, outputTokens: 10, totalTokens: 1510 },
      },
    ];
    const twoLoadCalls: ToolCallRecord[] = [
      {
        endpoint: 'load_skill',
        body: { skill_name: 'supabase' },
        loadedSkills: ['supabase'],
        result: { instructions: 'a' },
        ts: 0,
      },
      {
        endpoint: 'load_skill',
        body: { skill_name: 'supabase-postgres-best-practices' },
        loadedSkills: ['supabase-postgres-best-practices'],
        result: { instructions: 'b' },
        ts: 0,
      },
    ];

    const data = evalResultToTraceSpans({
      evalId: 'e6',
      passed: true,
      transcript: twoLoads,
      toolCalls: twoLoadCalls,
      agentReport: 'done',
    });

    const children = data.spans[0]!.children!;
    // 1500 - 500 = 1000, split evenly across the two loads.
    expect(children[1]!.tokensCount).toBe(500);
    expect(children[2]!.tokensCount).toBe(500);
  });

  it('does not attribute a negative or zero context delta to a skill load', () => {
    const compaction: TranscriptPart[] = [
      {
        type: 'message',
        role: 'assistant',
        content: 'Loading a skill.',
        usage: { inputTokens: 2000, outputTokens: 10, totalTokens: 2010 },
      },
      {
        type: 'tool_call',
        name: 'load_skill',
        input: { skill_name: 'supabase' },
        output: { instructions: 'a' },
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Context got compacted.',
        usage: { inputTokens: 1200, outputTokens: 10, totalTokens: 1210 },
      },
    ];
    const loadCall: ToolCallRecord[] = [
      {
        endpoint: 'load_skill',
        body: { skill_name: 'supabase' },
        loadedSkills: ['supabase'],
        result: { instructions: 'a' },
        ts: 0,
      },
    ];

    const data = evalResultToTraceSpans({
      evalId: 'e7',
      passed: true,
      transcript: compaction,
      toolCalls: loadCall,
      agentReport: 'done',
    });

    const children = data.spans[0]!.children!;
    expect(children[1]!.tokensCount).toBeUndefined();
  });

  it('passes status when the run passed, and a passed check still gets its own span', () => {
    const ok = evalResultToTraceSpans({
      evalId: 'e2',
      passed: true,
      transcript: [{ type: 'message', role: 'assistant', content: 'done' }],
      toolCalls: [],
      agentReport: '',
      skills: { available: ['s'], loaded: ['s'] },
      checks: [{ name: 'c', passed: true }],
    });
    expect(ok.spans[0]!.status).toBe('success');
    expect(ok.spans[0]!.children).toHaveLength(2); // assistant + the passed check
    const checkSpan = ok.spans[0]!.children![1]!;
    expect(checkSpan.title).toBe('Check passed: c');
    expect(checkSpan.status).toBe('success');
    expect(ok.badges[0]).toEqual({ label: 'Passed', tone: 'success' });
  });

  it('labels a failed check distinctly from a passed one', () => {
    const mixed = evalResultToTraceSpans({
      evalId: 'e8',
      passed: false,
      transcript: [{ type: 'message', role: 'assistant', content: 'done' }],
      toolCalls: [],
      agentReport: '',
      checks: [
        { name: 'a', passed: true },
        { name: 'b', passed: false, notes: 'missing index' },
      ],
    });
    const [, checkA, checkB] = mixed.spans[0]!.children!;
    expect(checkA!.title).toBe('Check passed: a');
    expect(checkA!.status).toBe('success');
    expect(checkB!.title).toBe('Check failed: b');
    expect(checkB!.status).toBe('error');
    expect(checkB!.output).toBe('missing index');
  });

  describe('real per-span duration', () => {
    it('computes a span duration as the gap to the next real timestamp', () => {
      const timed = evalResultToTraceSpans({
        evalId: 'e9',
        passed: true,
        transcript: [
          { type: 'tool_call', name: 'search_docs', input: {} },
          { type: 'tool_call', name: 'execute_sql', input: {} },
        ],
        toolCalls: [
          { endpoint: 'search_docs', body: {}, ts: 1_000 },
          { endpoint: 'execute_sql', body: {}, ts: 3_500 },
        ],
        agentReport: '',
      });
      const [first, second] = timed.spans[0]!.children!;
      expect(first!.duration).toBe(2_500);
      expect(first!.endTime).toEqual(new Date(3_500));
      // Nothing follows the last span, so its own duration stays unknown.
      expect(second!.duration).toBe(0);
    });

    it('leaves duration at 0 when no part carries a real timestamp', () => {
      const untimed = evalResultToTraceSpans({
        evalId: 'e10',
        passed: true,
        transcript: [
          { type: 'tool_call', name: 'a', input: {} },
          { type: 'tool_call', name: 'b', input: {} },
        ],
        toolCalls: [
          { endpoint: 'a', body: {}, ts: 0 },
          { endpoint: 'b', body: {}, ts: 0 },
        ],
        agentReport: '',
      });
      for (const child of untimed.spans[0]!.children!) {
        expect(child.duration).toBe(0);
      }
      expect(untimed.traceRecord.durationMs).toBe(0);
    });

    it('sets the root span and traceRecord duration to the earliest-to-latest real span', () => {
      const timed = evalResultToTraceSpans({
        evalId: 'e11',
        passed: true,
        transcript: [
          { type: 'tool_call', name: 'a', input: {} },
          { type: 'tool_call', name: 'b', input: {} },
          { type: 'tool_call', name: 'c', input: {} },
        ],
        toolCalls: [
          { endpoint: 'a', body: {}, ts: 10_000 },
          { endpoint: 'b', body: {}, ts: 12_000 },
          { endpoint: 'c', body: {}, ts: 17_000 },
        ],
        agentReport: '',
      });
      const root = timed.spans[0]!;
      expect(root.duration).toBe(7_000);
      expect(root.startTime).toEqual(new Date(10_000));
      expect(root.endTime).toEqual(new Date(17_000));
      expect(timed.traceRecord.durationMs).toBe(7_000);
    });

    it('an untimed part inherits the last known real position, not a fabricated one', () => {
      // A step-level ts (ai-sdk) only lands on the LAST part of a step, so an
      // earlier tool call in a multi-call step has no ts of its own — it
      // should sit at the previous real position, and the elapsed time to
      // the next real timestamp attaches to it, not silently vanish.
      const timed = evalResultToTraceSpans({
        evalId: 'e12',
        passed: true,
        transcript: [
          { type: 'tool_call', name: 'timed-a', input: {} },
          { type: 'tool_call', name: 'untimed', input: {} },
          { type: 'tool_call', name: 'timed-b', input: {} },
        ],
        toolCalls: [
          { endpoint: 'timed-a', body: {}, ts: 5_000 },
          { endpoint: 'untimed', body: {}, ts: 0 },
          { endpoint: 'timed-b', body: {}, ts: 9_000 },
        ],
        agentReport: '',
      });
      const [a, untimed, b] = timed.spans[0]!.children!;
      expect(a!.duration).toBe(0); // same position as `untimed` — no gap
      expect(untimed!.duration).toBe(4_000); // owns the gap to the next real ts
      expect(b!.duration).toBe(0);
    });
  });
});
