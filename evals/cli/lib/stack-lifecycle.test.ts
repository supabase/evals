import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import { readStackLifecycle, type StackLifecycle } from './stack-lifecycle.js';

const NO_LIFECYCLE: StackLifecycle = {
  lastCommand: null,
  stoppedByAgent: false,
};

const lifecycle = (commands: string[]) =>
  readStackLifecycle(findSupabaseInvocations(commands));

describe('readStackLifecycle', () => {
  it.each([
    ['no supabase command ran', [] as string[]],
    [
      'only non-lifecycle commands ran',
      ['supabase gen types typescript --local', 'supabase migration up'],
    ],
    ['a db command other than start ran', ['supabase db reset']],
  ])('reports no lifecycle command when %s', (_name, commands) => {
    expect(lifecycle(commands)).toEqual(NO_LIFECYCLE);
  });

  it.each([
    'supabase start',
    'supabase stack start',
    'supabase stack restart',
    'supabase db start',
  ])('treats %s as a start', (command) => {
    expect(lifecycle([command])).toEqual({
      lastCommand: command,
      stoppedByAgent: false,
    });
  });

  it.each(['supabase stop', 'supabase stack stop', 'supabase stack destroy'])(
    'treats %s as a stop',
    (command) => {
      expect(lifecycle(['supabase start', command])).toEqual({
        lastCommand: command,
        stoppedByAgent: true,
      });
    }
  );

  it('keeps the flags in lastCommand', () => {
    expect(
      lifecycle(['supabase start', 'supabase stop --no-backup --project-id x'])
    ).toEqual({
      lastCommand: 'supabase stop --no-backup --project-id x',
      stoppedByAgent: true,
    });
    expect(lifecycle(['supabase start --exclude gotrue,imgproxy'])).toEqual({
      lastCommand: 'supabase start --exclude gotrue,imgproxy',
      stoppedByAgent: false,
    });
  });

  it('uses the last lifecycle command when the agent stopped and then started again', () => {
    expect(
      lifecycle(['supabase start', 'supabase stop', 'supabase db start'])
    ).toEqual({ lastCommand: 'supabase db start', stoppedByAgent: false });
  });

  it('ignores commands that follow the last lifecycle command', () => {
    expect(
      lifecycle([
        'supabase start',
        'supabase stop',
        'supabase gen types typescript --local',
      ])
    ).toEqual({ lastCommand: 'supabase stop', stoppedByAgent: true });
  });

  it('does not count a stop that was only echoed', () => {
    expect(lifecycle(['supabase start', 'echo "supabase stop"'])).toEqual({
      lastCommand: 'supabase start',
      stoppedByAgent: false,
    });
  });
});
