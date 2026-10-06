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
    expect(result.otherPages).toEqual(['guides/database/overview']);
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
      {
        query: 'row level security',
        targetHit: true,
        truncated: false,
        opened: false,
      },
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
    expect(result.otherPages).toEqual([]);
    expect(result.hopsToTarget).toBeNull();
  });
});

describe('scoreWayfinding with truncated search results', () => {
  const saved = '/home/node/.claude/projects/x/tool-results/toolu_1.json';
  const stub = `<persisted-output>\nOutput too large (59.6KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n{"title":"Local workflow","href":"${DOCS}/guides/local-development/cli-workflows"`;
  const truncatedSearch: ToolCallRecord = {
    tool: parseClaudeCodeToolCall('mcp__supabase-mcp__search_docs'),
    body: {
      graphql_query:
        '{ searchDocs(query: "seed data") { nodes { title href content } } }',
    },
    result: stub,
    ts: 0,
  };
  const SEED = 'guides/local-development/seeding-your-database';

  it('counts only the preview when the agent never opens the saved file', async () => {
    const result = await scoreWayfinding({
      toolCalls: [truncatedSearch],
      targets: [SEED],
      fetchLinks: noLinks,
    });
    expect(result.hopsToTarget).toBeNull();
    expect(result.searches).toEqual([
      { query: 'seed data', targetHit: false, truncated: true, opened: false },
    ]);
  });

  it('credits the search once the agent reads the saved file', async () => {
    const read: ToolCallRecord = {
      tool: parseClaudeCodeToolCall('Read'),
      body: { file_path: saved },
      name: 'file_read',
      path: saved,
      result: `{"title":"Seeding","href":"${DOCS}/${SEED}","content":"seed.sql"}`,
      ts: 0,
    };
    const result = await scoreWayfinding({
      toolCalls: [truncatedSearch, read, webFetch(`${DOCS}/${SEED}`)],
      targets: [SEED],
      fetchLinks: noLinks,
    });
    expect(result.hopsToTarget).toBe(0);
    expect(result.docsCalls).toBe(2);
    expect(result.searches[0]).toMatchObject({ targetHit: true, opened: true });
    expect(result.fetches[0].provenance).toBe('search');
  });
});

describe('scoreWayfinding with alternates', () => {
  it('reaches a duplicate page and says so', async () => {
    const result = await scoreWayfinding({
      toolCalls: [webFetch(`${DOCS}/guides/auth/quickstarts/nextjs`)],
      targets: ['guides/getting-started/quickstarts/nextjs'],
      alternates: ['guides/auth/quickstarts/nextjs'],
      fetchLinks: noLinks,
    });
    expect(result).toMatchObject({
      hopsToTarget: 0,
      reachedTarget: 'guides/auth/quickstarts/nextjs',
      viaAlternate: true,
      otherPages: [],
    });
  });
});
