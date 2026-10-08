// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { formatTargetingJudgeInput } from './targeting.js';

const named = (dbUrl: string): StackProbe => ({
  ok: true,
  backend: 'managed-named',
  dbUrl,
  runtime: 'native',
});

const STACKS = {
  dev: named('postgresql://postgres:hunter2@127.0.0.1:29001/postgres'),
  test: named('postgresql://postgres:hunter2@127.0.0.1:29002/postgres'),
};

describe('formatTargetingJudgeInput', () => {
  it('names each stack by masked url and port, then numbers every command', () => {
    expect(
      formatTargetingJudgeInput('/ws', STACKS, ['supabase init', 'ls'])
    ).toBe(
      [
        'Harness facts:',
        '- project directory: /ws',
        '- dev stack: database postgresql://127.0.0.1:29001/postgres (port 29001)',
        '  found under the default CLI home',
        '- test stack: database postgresql://127.0.0.1:29002/postgres (port 29002)',
        '  found under the default CLI home',
        '',
        'Executed commands, in order:',
        '1. supabase init',
        '2. ls',
      ].join('\n')
    );
  });

  it("names each stack's CLI home, relocated or default", () => {
    const input = formatTargetingJudgeInput(
      '/ws',
      {
        dev: { ...STACKS.dev, cliHome: '/home/node/.supabase' },
        test: {
          ...named('postgresql://postgres:hunter2@127.0.0.1:29002/postgres'),
          relocatedHome: '/tmp/sb/.supabase-home',
          cliHome: '/tmp/sb/.supabase-home',
        },
      },
      []
    );
    expect(input).toContain(
      '(port 29001)\n  found under the default CLI home /home/node/.supabase'
    );
    expect(input).toContain(
      '(port 29002)\n  found under relocated CLI home /tmp/sb/.supabase-home'
    );
  });

  it('never carries the stack credentials', () => {
    expect(formatTargetingJudgeInput('/ws', STACKS, [])).not.toContain(
      'hunter2'
    );
  });

  it('says so when a stack did not resolve', () => {
    const input = formatTargetingJudgeInput(
      '/ws',
      { ...STACKS, dev: { ok: false, notes: "no stack named 'dev'" } },
      []
    );
    expect(input).toContain("- dev stack: not resolved (no stack named 'dev')");
  });

  it('keeps a destructive command past a long heredoc untruncated', () => {
    const long = `cat > seed.sql <<'EOF'\n${"insert into orders values ('x');\n".repeat(120)}EOF\npsql postgresql://127.0.0.1:29001/postgres -f scripts/reset-test-data.sql`;
    expect(long.length).toBeGreaterThan(2000);
    const input = formatTargetingJudgeInput('/ws', STACKS, ['ls', long]);
    expect(input).toContain(`2. ${long}`);
  });
});
