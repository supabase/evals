import { describe, expect, it } from 'vitest';
import { execSql, psqlError } from './exec-sql.js';

describe('psqlError', () => {
  it('puts the database error first and drops CLI chatter', () => {
    const output = [
      'A new version of Supabase CLI is available',
      'psql:<stdin>:1: NOTICE: something',
      'ERROR:  update or delete on table "teams" violates foreign key constraint',
      'DETAIL:  Key (id)=(1) is still referenced from table "members".',
    ].join('\n');
    expect(psqlError(output)).toBe(
      'ERROR:  update or delete on table "teams" violates foreign key constraint DETAIL:  Key (id)=(1) is still referenced from table "members".'
    );
  });

  it('falls back to the first line, then to "no output"', () => {
    expect(psqlError('\nconnection refused\nmore')).toBe('connection refused');
    expect(psqlError('  \n')).toBe('no output');
  });
});

describe('execSql', () => {
  it('returns a failure instead of throwing', async () => {
    const ctx = {
      exec: async () => {
        throw new Error('container gone');
      },
    };
    expect(await execSql(ctx, 'select 1')).toEqual({
      ok: false,
      stdout: '',
      message: 'container gone',
    });
  });
});
