import { describe, expect, it } from 'vitest';

import { parseClaudeCodeToolCall } from './agents/claude-code/parser.js';
import type { ToolCallRecord } from './index.js';
import { docsPath, linkedPaths, scoreWayfinding } from './wayfinding.js';

const RLS = 'guides/database/postgres/row-level-security';
const DOCS = 'https://supabase.com/docs';

function webFetch(
  url: string,
  options: Partial<ToolCallRecord> = {}
): ToolCallRecord {
  return {
    tool: parseClaudeCodeToolCall('WebFetch'),
    body: { url, prompt: 'Find the steps' },
    name: 'web_fetch',
    url,
    result: 'Summary of the page',
    ts: 0,
    ...options,
  };
}

function searchDocs(
  query: string,
  hrefs: string[],
  content = false
): ToolCallRecord {
  return {
    tool: parseClaudeCodeToolCall('mcp__supabase-mcp__search_docs'),
    body: {
      graphql_query: `{ searchDocs(query: "${query}") { nodes { title href${content ? ' content' : ''} } } }`,
    },
    result: {
      searchDocs: { nodes: hrefs.map((href) => ({ title: 'Page', href })) },
    },
    ts: 0,
  };
}

const noLinks = async () => [];

describe('docsPath', () => {
  it('normalizes .md, trailing slashes, anchors, and the docs prefix', () => {
    expect(docsPath(`${DOCS}/${RLS}.md`)).toBe(RLS);
    expect(docsPath(`${DOCS}/${RLS}/#policies`)).toBe(RLS);
    expect(docsPath(`${DOCS}/`)).toBe('docs');
    expect(docsPath('https://supabase.com/llms.txt')).toBe('llms.txt');
    expect(docsPath('https://github.com/supabase/supabase')).toBeNull();
  });

  it('resolves relative links against the page they appear on', () => {
    expect(docsPath('/docs/guides/auth', `${DOCS}/guides/database`)).toBe(
      'guides/auth'
    );
  });
});

describe('linkedPaths', () => {
  it('finds markdown links, hrefs, and bare urls', () => {
    const text = [
      '[RLS](/docs/guides/database/postgres/row-level-security)',
      '<a href="https://supabase.com/docs/guides/auth">Auth</a>',
      'See https://supabase.com/docs/guides/storage for more.',
      '[External](https://example.com)',
    ].join('\n');
    expect(linkedPaths(text, `${DOCS}/guides/database`)).toEqual([
      RLS,
      'guides/auth',
      'guides/storage',
    ]);
  });
});

describe('scoreWayfinding', () => {
  it('reports no entry and no target when the agent never touched the docs', async () => {
    const result = await scoreWayfinding({
      toolCalls: [],
      targets: [RLS],
      fetchLinks: noLinks,
    });
    expect(result).toMatchObject({
      entrySurface: 'none',
      hopsToTarget: null,
      reachedTarget: null,
      docsCalls: 0,
    });
  });

  it('counts hops through llms.txt and a link to the target', async () => {
    const result = await scoreWayfinding({
      toolCalls: [
        webFetch('https://supabase.com/llms.txt'),
        webFetch(`${DOCS}/guides/database/overview`),
        webFetch(`${DOCS}/${RLS}`),
      ],
      targets: [RLS],
      fetchLinks: async (url) =>
        url.endsWith('overview') ? [RLS] : ['guides/database/overview'],
    });
    expect(result.entrySurface).toBe('llms_txt');
    expect(result.hopsToTarget).toBe(2);
    expect(result.reachedTarget).toBe(RLS);
    expect(result.fetches.map((f) => f.provenance)).toEqual([
      'convention',
      'link',
      'link',
    ]);
    expect(result.wrongPages).toEqual(['guides/database/overview']);
  });

  it('attributes a fetch to search when an earlier search returned it', async () => {
    const result = await scoreWayfinding({
      toolCalls: [
        searchDocs('row level security', [`${DOCS}/${RLS}`]),
        webFetch(`${DOCS}/${RLS}.md`),
      ],
      targets: [RLS],
      fetchLinks: noLinks,
    });
    expect(result.entrySurface).toBe('search_docs');
    expect(result.searches).toEqual([
      { query: 'row level security', targetHit: true },
    ]);
    expect(result.fetches[0]).toMatchObject({
      provenance: 'search',
      isTarget: true,
    });
    expect(result.hopsToTarget).toBe(1);
  });

  it('counts a search that returned target content as reaching it', async () => {
    const result = await scoreWayfinding({
      toolCalls: [searchDocs('rls', [`${DOCS}/${RLS}`], true)],
      targets: [RLS],
      fetchLinks: noLinks,
    });
    expect(result.hopsToTarget).toBe(0);
  });

  it('labels an unsourced deep url a guess and records a 404', async () => {
    const result = await scoreWayfinding({
      toolCalls: [
        webFetch(`${DOCS}/guides/database/rls`, {
          error: 'Request failed with status code 404',
        }),
        webFetch(`${DOCS}/`),
      ],
      targets: [RLS],
      fetchLinks: noLinks,
    });
    expect(result.entrySurface).toBe('html_page');
    expect(result.fetches.map((f) => f.provenance)).toEqual([
      'guess',
      'prompt',
    ]);
    expect(result.notFound).toEqual(['guides/database/rls']);
    expect(result.wrongPages).toEqual([]);
    expect(result.hopsToTarget).toBeNull();
  });
});
