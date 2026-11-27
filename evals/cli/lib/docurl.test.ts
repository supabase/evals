import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  DOC_URL_READ_CHECK,
  DOC_URL_SEEN_CHECK,
  docUrlMetricChecks,
  findDocUrlRead,
  normalizeArticleUrl,
  runSql,
  sawDocUrl,
  scoreWithDocUrlMetrics,
} from './docurl.js';

const URL_A =
  'https://supabase.com/kb/troubleshooting/resolving-42p01-relation-does-not-exist-error-W4_9-V';

function shell(command: string, result = 'page text', error?: string) {
  return {
    tool: { kind: 'other', toolName: 'Bash' },
    name: 'shell',
    body: { command },
    command,
    result,
    ...(error === undefined ? {} : { error }),
    ts: 0,
  } as unknown as ToolCallRecord;
}

function webFetch(url: string) {
  return {
    tool: { kind: 'other', toolName: 'WebFetch' },
    name: 'web_fetch',
    body: { url, prompt: 'what is the fix' },
    url,
    result: 'page text',
    ts: 0,
  } as unknown as ToolCallRecord;
}

describe('normalizeArticleUrl', () => {
  it('drops the query, hash, trailing slash and .md suffix', () => {
    expect(normalizeArticleUrl(`${URL_A}.md?x=1#top`)).toBe(URL_A);
    expect(normalizeArticleUrl(`${URL_A}/`)).toBe(URL_A);
  });

  it('returns undefined for a non-URL', () => {
    expect(normalizeArticleUrl('not a url')).toBeUndefined();
  });
});

describe('findDocUrlRead', () => {
  it('finds a web_fetch of the article', () => {
    expect(findDocUrlRead([webFetch(URL_A)], URL_A)).toBe('web_fetch');
  });

  it('finds a curl of the article, also as the .md page', () => {
    expect(findDocUrlRead([shell(`curl -sL ${URL_A}.md`)], URL_A)).toBe(
      'shell_fetch'
    );
  });

  it('counts a curl whose output goes to a file', () => {
    expect(
      findDocUrlRead([shell(`curl -sL ${URL_A} -o /tmp/a.html`, 'ok')], URL_A)
    ).toBe('shell_command');
  });

  it('ignores a different article', () => {
    expect(
      findDocUrlRead(
        [webFetch('https://supabase.com/kb/troubleshooting/other')],
        URL_A
      )
    ).toBeUndefined();
  });

  it('ignores a failed fetch', () => {
    expect(
      findDocUrlRead([shell(`curl -o /tmp/a ${URL_A}`, '', 'exit 6')], URL_A)
    ).toBeUndefined();
  });

  it('ignores a command that only echoes the URL', () => {
    expect(findDocUrlRead([shell(`echo ${URL_A}`)], URL_A)).toBeUndefined();
  });
});

describe('sawDocUrl', () => {
  it('is true when a command output carries the URL', () => {
    const output = `{"error":{"code":"x","docUrl":"${URL_A}"}}`;
    expect(
      sawDocUrl([shell('supabase db query --local -f a.sql', output)], URL_A)
    ).toBe(true);
  });

  it('is false when no output carries it', () => {
    expect(sawDocUrl([shell('supabase db query', 'boom')], URL_A)).toBe(false);
  });
});

describe('docUrlMetricChecks', () => {
  it('always passes and reports the values in the notes', () => {
    const checks = docUrlMetricChecks([], URL_A);
    expect(checks.map((c) => c.name)).toEqual([
      DOC_URL_READ_CHECK,
      DOC_URL_SEEN_CHECK,
    ]);
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checks[0].notes).toContain('read_doc_url=false');
    expect(checks[1].notes).toContain('saw_doc_url=false');
  });
});

describe('scoreWithDocUrlMetrics', () => {
  it('leaves passed to the gating checks', () => {
    const failing = [{ name: 'a', passed: false }];
    const result = scoreWithDocUrlMetrics(failing, [webFetch(URL_A)], URL_A);
    expect(result.passed).toBe(false);
    expect(result.checks?.at(-2)?.notes).toContain('read_doc_url=true');
  });

  it('passes when the gating checks pass, even if the article was not read', () => {
    const result = scoreWithDocUrlMetrics(
      [{ name: 'a', passed: true }],
      [],
      URL_A
    );
    expect(result.passed).toBe(true);
  });
});

describe('runSql', () => {
  it('reports a missing stack without running psql', async () => {
    const exec = async () => {
      throw new Error('should not run');
    };
    expect(
      await runSql({ exec }, { ok: false, notes: 'no stack' }, 'select 1')
    ).toEqual({
      ok: false,
      stdout: '',
      notes: 'no stack',
    });
  });

  it('pipes base64 SQL into psql with ON_ERROR_STOP', async () => {
    let seen = '';
    const exec = async (command: string) => {
      seen = command;
      return { ok: true, exitCode: 0, stdout: '1\n', stderr: '' };
    };
    const stack = {
      ok: true as const,
      backend: 'legacy' as const,
      dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      runtime: 'docker' as const,
    };
    const run = await runSql({ exec }, stack, 'select 1', {
      fieldSeparator: '|',
    });
    expect(run).toEqual({ ok: true, stdout: '1\n', notes: 'ok' });
    expect(seen).toContain(Buffer.from('select 1').toString('base64'));
    expect(seen).toContain('ON_ERROR_STOP=1');
    expect(seen).toContain("-F '|'");
  });
});
