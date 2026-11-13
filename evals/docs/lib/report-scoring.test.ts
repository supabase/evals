import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';

import { feedbackSends } from './report-scoring.js';

const shell = (command: string): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'exec_command' },
  body: {},
  command: `/bin/bash -lc '${command.replace(/'/g, `'"'"'`)}'`,
  ts: 0,
});

describe('feedbackSends', () => {
  it.each([
    'npx -y supabase@latest feedback add -m hi',
    'supabase --profile supabase-staging feedback add -m hi',
    "npx supabase feedback add <<'EOF'\nPage: x\nEOF",
  ])('counts a cli send: %s', (command) => {
    expect(feedbackSends([shell(command)])).toHaveLength(1);
  });

  it.each([
    'supabase feedback add --help',
    'supabase feedback',
    'grep -rn "supabase feedback add" node_modules/supabase',
    "cat > report.txt <<'EOF'\nsupabase feedback add -m hi\nEOF",
  ])('ignores a command that sends nothing: %s', (command) => {
    expect(feedbackSends([shell(command)])).toHaveLength(0);
  });

  it('counts an mcp submit_feedback call', () => {
    const call: ToolCallRecord = {
      tool: { kind: 'mcp', server: 'supabase', toolName: 'submit_feedback' },
      body: {},
      ts: 0,
    };
    expect(feedbackSends([call])).toHaveLength(1);
  });
});
