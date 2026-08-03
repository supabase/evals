import { describe, expect, it, vi } from 'vitest';
import {
  buildDocsResult,
  rehydrateTruncatedDocsResults,
} from './docs-results.js';
import type { ToolCallRecord } from './index.js';

/** Builds the minimal tool call record needed by docs-result tests. */
function toolCall(
  endpoint: string,
  body: Record<string, unknown>,
  options: Partial<
    Pick<ToolCallRecord, 'url' | 'result' | 'name' | 'command' | 'error'>
  > = {}
): ToolCallRecord {
  return { endpoint, body, ...options, ts: 0 };
}

describe('buildDocsResult', () => {
  it("builds one call from a search_docs invocation, flagging no content when the query didn't select it", () => {
    const result = buildDocsResult([
      toolCall(
        'mcp__supabase-mcp__search_docs',
        {
          graphql_query:
            '{ searchDocs(query: "rls") { nodes { title href } } }',
        },
        {
          result: {
            searchDocs: {
              nodes: [
                {
                  title: 'Row Level Security',
                  href: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
                },
              ],
            },
          },
        }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'search_docs',
        query: '{ searchDocs(query: "rls") { nodes { title href } } }',
        hasContent: false,
        pages: [
          {
            url: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
            title: 'Row Level Security',
          },
        ],
        resultChars: expect.any(Number),
      },
    ]);
  });

  it("flags hasContent true from the query's own field selection, not the result, so it survives truncation", () => {
    const result = buildDocsResult([
      toolCall(
        'search_docs',
        {
          graphql_query:
            '{ searchDocs(query: "rls") { nodes { title href content } } }',
        },
        {
          result:
            'Error: result exceeds maximum allowed tokens. Output has been saved to a file.',
        }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'search_docs',
        query: '{ searchDocs(query: "rls") { nodes { title href content } } }',
        hasContent: true,
        pages: [],
        resultChars: expect.any(Number),
      },
    ]);
  });

  it("doesn't mistake the word content inside a quoted search term for a field selection", () => {
    const result = buildDocsResult([
      toolCall(
        'search_docs',
        {
          graphql_query:
            '{ searchDocs(query: "content management") { nodes { title href } } }',
        },
        { result: { searchDocs: { nodes: [] } } }
      ),
    ]);

    expect(result.calls[0].hasContent).toBe(false);
  });

  it('finds the query nested under body.arguments (real Codex mcp_tool_call shape)', () => {
    const result = buildDocsResult([
      toolCall(
        // Codex's parser sets originalName to the MCP tool's own name
        // (item.tool), not the "mcp_tool_call" item type, and reports the
        // whole raw item as `body`, args nested under `body.arguments`.
        'search_docs',
        {
          id: 'item_9',
          type: 'mcp_tool_call',
          server: 'supabase-mcp',
          tool: 'search_docs',
          arguments: {
            graphql_query:
              '{ searchDocs(query: "rls") { nodes { title href } } }',
          },
        },
        {
          result: {
            searchDocs: {
              nodes: [
                {
                  title: 'Row Level Security',
                  href: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
                },
              ],
            },
          },
        }
      ),
    ]);

    expect(result.calls[0].query).toBe(
      '{ searchDocs(query: "rls") { nodes { title href } } }'
    );
    expect(result.calls[0].pages.map((p) => p.url)).toEqual([
      'https://supabase.com/docs/guides/database/postgres/row-level-security',
    ]);
  });

  it('unwraps a content-array result whose text field is a JSON-encoded string (real Claude Code shape)', () => {
    const result = buildDocsResult([
      toolCall(
        'mcp__supabase-mcp__search_docs',
        {
          graphql_query:
            '{ searchDocs(query: "rls") { nodes { title href } } }',
        },
        {
          result: [
            {
              type: 'text',
              text: JSON.stringify({
                result: {
                  searchDocs: {
                    nodes: [
                      {
                        title: 'Row Level Security',
                        href: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
                      },
                    ],
                  },
                },
              }),
            },
          ],
        }
      ),
    ]);

    expect(result.calls[0].pages).toEqual([
      {
        url: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
        title: 'Row Level Security',
      },
    ]);
  });

  it("still records the call, with no pages, when the result is truncated and the query didn't select href either", () => {
    const result = buildDocsResult([
      toolCall(
        'search_docs',
        { graphql_query: '{ searchDocs(query: "rls") { nodes { content } } }' },
        {
          result:
            'Error: result exceeds maximum allowed tokens. Output has been saved to a file.',
        }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'search_docs',
        query: '{ searchDocs(query: "rls") { nodes { content } } }',
        hasContent: true,
        pages: [],
        resultChars: expect.any(Number),
      },
    ]);
  });

  it("takes a WebFetch call's query from its prompt arg, not the url, since the prompt is what actually varies the result", () => {
    const result = buildDocsResult([
      toolCall(
        'WebFetch',
        {
          url: 'https://supabase.com/changelog.md',
          prompt: 'List breaking-change entries about self-hosting',
        },
        { url: 'https://supabase.com/changelog.md', name: 'web_fetch' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_fetch',
        query: 'List breaking-change entries about self-hosting',
        hasContent: true,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
      },
    ]);
  });

  it('falls back to the url as the query when a WebFetch call has no prompt arg', () => {
    const result = buildDocsResult([
      toolCall(
        'WebFetch',
        { url: 'https://supabase.com/docs/guides/auth' },
        { url: 'https://supabase.com/docs/guides/auth', name: 'web_fetch' }
      ),
    ]);

    expect(result.calls[0].query).toBe('https://supabase.com/docs/guides/auth');
  });

  it('ignores a fetch call on a non-Supabase domain', () => {
    const result = buildDocsResult([
      toolCall(
        'WebFetch',
        { url: 'https://example.com/foo' },
        { url: 'https://example.com/foo', name: 'web_fetch' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("parses title+url pairs out of Claude Code's WebSearch Links blob, flagged as hits not reads", () => {
    const resultText =
      'Web search results for query: "Supabase RLS"\n\n' +
      'Links: [{"title":"Row Level Security | Supabase Docs","url":"https://supabase.com/docs/guides/database/postgres/row-level-security"},' +
      '{"title":"Unrelated","url":"https://example.com/rls"}]\n\nSummary text.';

    const result = buildDocsResult([
      toolCall(
        'WebSearch',
        { query: 'Supabase RLS documentation' },
        { result: resultText, name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: 'Supabase RLS documentation',
        hasContent: false,
        pages: [
          {
            url: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
            title: 'Row Level Security | Supabase Docs',
          },
        ],
        resultChars: expect.any(Number),
      },
    ]);
  });

  it("drops a web search call that isn't Supabase-related", () => {
    const result = buildDocsResult([
      toolCall(
        'WebSearch',
        { query: 'how to configure nginx' },
        { result: 'no matches', name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("treats a URL-shaped Codex web_search query as a fetch call of unknown content, same as Claude's WebSearch fetch pattern would", () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: 'https://supabase.com/docs/guides/database/extensions/pg_net',
        },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: 'https://supabase.com/docs/guides/database/extensions/pg_net',
        pages: [
          {
            url: 'https://supabase.com/docs/guides/database/extensions/pg_net',
          },
        ],
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('treats a search-term Codex web_search call as unknown content with no pages', () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        { query: 'site:supabase.com/docs pg_cron schedule' },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: 'site:supabase.com/docs pg_cron schedule',
        pages: [],
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('trusts an open_page action over the query string, recording the page as read', () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: 'https://supabase.com/changelog.md',
          action: {
            type: 'open_page',
            url: 'https://supabase.com/changelog.md',
          },
        },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: 'https://supabase.com/changelog.md',
        hasContent: true,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
      },
    ]);
  });

  it('records a find_in_page action, whose query rendering the URL-shape fallback never matches', () => {
    const url = 'https://supabase.com/docs/guides/database/extensions/pgmq';
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: `'send(' in ${url}`,
          action: { type: 'find_in_page', url, pattern: 'send(' },
        },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: `'send(' in ${url}`,
        hasContent: true,
        pages: [{ url }],
      },
    ]);
  });

  it("leaves a search action's content unknown, and doesn't mistake its url-shaped query for a page read", () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: 'https://supabase.com/changelog.md',
          action: {
            type: 'search',
            query: 'https://supabase.com/changelog.md',
          },
        },
        { name: 'web_search' }
      ),
    ]);

    // No pages: the action says this was a query, not an open, even though the
    // query text is a bare url the fallback would have counted as a read.
    expect(result.calls).toEqual([
      {
        source: 'web_search',
        query: 'https://supabase.com/changelog.md',
        pages: [],
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('drops an open_page action pointing somewhere other than supabase.com', () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: 'https://github.com/pgmq/pgmq',
          action: { type: 'open_page', url: 'https://github.com/pgmq/pgmq' },
        },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops an open_page action on a supabase service subdomain', () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        {
          query: 'https://mcp.supabase.com/mcp',
          action: { type: 'open_page', url: 'https://mcp.supabase.com/mcp' },
        },
        { name: 'web_search' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('counts a docs url curled from the shell, sized by what the pipe actually returned', () => {
    const command =
      '/bin/bash -lc "curl -fsSL https://supabase.com/changelog.md | sed -n \'1,160p\'"';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          result: '# Changelog\n\n2026-06-12 breaking-change ...',
        }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        hasContent: true,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: '# Changelog\n\n2026-06-12 breaking-change ...'.length,
      },
    ]);
  });

  it('keeps a fetch from a mixed shell call without attributing the combined output to it', () => {
    const command =
      'curl -fsSL https://supabase.com/changelog.md | rg breaking || true; cat local-notes.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'unrelated local notes' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: 'unrelated local notes'.length,
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('finds a curl fetch on its own line in a multi-line script', () => {
    const command =
      'echo starting\ncurl -fsSL https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Changelog' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: '# Changelog'.length,
      },
    ]);
    // Result shared with other command(s) means we can't be certain about content attribution.
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('records each curl fetch in a multi-line script', () => {
    const command =
      'set -e\n' +
      "curl -fsSL https://supabase.com/docs/guides/functions/auth.md | sed -n '1,280p'\n" +
      "curl -fsSL https://supabase.com/docs/guides/functions/auth-headers.md | sed -n '1,260p'";
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Auth\n\n# Auth headers' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        pages: [
          { url: 'https://supabase.com/docs/guides/functions/auth.md' },
          { url: 'https://supabase.com/docs/guides/functions/auth-headers.md' },
        ],
        resultChars: '# Auth\n\n# Auth headers'.length,
      },
    ]);
    // Result shared with other command(s) means we can't be certain about content attribution.
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it('still attributes a fetch pipeline whose only command-list operator is a trailing fallback', () => {
    const command =
      'curl -fsSL https://supabase.com/changelog.md | rg breaking || true';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'breaking change' }
      ),
    ]);

    expect(result.calls[0].hasContent).toBe(true);
    expect(result.calls[0].resultChars).toBe('breaking change'.length);
  });

  it('records every supabase url a single shell fetch pulled down', () => {
    const command =
      'wget -qO- https://supabase.com/changelog.md https://supabase.com/docs/guides/auth.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'page 1\npage 2' }
      ),
    ]);

    expect(result.calls[0].pages).toEqual([
      { url: 'https://supabase.com/changelog.md' },
      { url: 'https://supabase.com/docs/guides/auth.md' },
    ]);
  });

  it('drops an ordinary wget whose page was saved to disk instead of shown to the model', () => {
    const command = 'wget https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'saved changelog.md' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('counts wget with the long-form stdout destination', () => {
    const command =
      'wget --quiet --output-document=- https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Changelog' }
      ),
    ]);

    expect(result.calls).toHaveLength(1);
  });

  it('drops curl output saved to a file instead of shown to the model', () => {
    const command =
      'curl -fsSL -ochangelog.md https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'download complete' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('counts a curl fetch with stderr redirected to /dev/null', () => {
    const command =
      'curl -fsSL https://supabase.com/changelog.md 2>/dev/null | head -50';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Changelog' }
      ),
    ]);

    expect(result.calls).toHaveLength(1);
  });

  it('counts a curl fetch with stderr merged into stdout via 2>&1', () => {
    const command =
      'curl -fsSL https://supabase.com/changelog.md 2>&1 | head -50';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Changelog' }
      ),
    ]);

    expect(result.calls).toHaveLength(1);
  });

  it.each(['>out.txt', '1>out.txt', '&>out.txt'])(
    'drops a curl fetch redirected with %s',
    (redirect) => {
      const command = `curl -fsSL https://supabase.com/changelog.md ${redirect}`;
      const result = buildDocsResult([
        toolCall(
          'command_execution',
          { command },
          { name: 'shell', command, result: 'download complete' }
        ),
      ]);

      expect(result.calls).toEqual([]);
    }
  );

  it('drops a curl fetch whose stdout is redirected past a silenced stderr', () => {
    const command =
      'curl -fsSL https://supabase.com/changelog.md 2>/dev/null >out.txt';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'download complete' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops a curl fetch with stdout swapped onto stderr via >&2', () => {
    const command = 'curl -fsSL https://supabase.com/changelog.md >&2';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'download complete' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('does not attribute an unrelated url elsewhere in a compound command to curl', () => {
    const command =
      'echo https://supabase.com/changelog.md; curl -fsSL https://example.com';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'example page' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops a shell fetch that failed, since a non-zero exit leaves no output to read', () => {
    const command = 'curl -fsSL https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          error: 'curl: (22) The requested URL returned error: 404',
        }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("marks a bare curl's content as unknown on a real body", () => {
    // No -f/--fail, so a 0 exit doesn't prove the body is a real page.
    const command = 'curl https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '# Changelog\n\nreal content' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: '# Changelog\n\nreal content'.length,
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it("marks a bare curl's content as unknown on an HTTP-error body", () => {
    const command = 'curl https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: '404: Not Found' }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: '404: Not Found'.length,
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it("trusts a -f curl's content regardless of body", () => {
    // A real failure would already be routed to `error` by --fail.
    const command = 'curl -fsSL https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          result: '500 organizations now use Supabase in production',
        }
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: 'shell_fetch',
        query: command,
        hasContent: true,
        pages: [{ url: 'https://supabase.com/changelog.md' }],
        resultChars: '500 organizations now use Supabase in production'.length,
      },
    ]);
  });

  it('drops a wget with 404 response', () => {
    const command =
      'wget --quiet --output-document=- https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          error: 'wget: server returned error: HTTP/1.1 404 Not Found',
        }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops a shell fetch of a supabase service endpoint, which is a probe not a read', () => {
    const command = 'curl -s https://mcp.supabase.com/mcp';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'Unauthorized' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops a shell fetch from a lookalike hostname', () => {
    const command = 'curl https://not-supabase.com/foo';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        { name: 'shell', command, result: 'not Supabase docs' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops a shell command that only mentions a docs url without fetching it', () => {
    const command =
      'echo "see https://supabase.com/docs/guides/auth for details"';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          result: 'see https://supabase.com/docs/guides/auth for details',
        }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('drops an echo that merely mentions curl rather than invoking it', () => {
    const command = 'echo curl https://supabase.com/changelog.md';
    const result = buildDocsResult([
      toolCall(
        'command_execution',
        { command },
        {
          name: 'shell',
          command,
          result: 'curl https://supabase.com/changelog.md',
        }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('ignores WebFetch/WebSearch-shaped calls when the parser never normalized a canonical name', () => {
    const result = buildDocsResult([
      toolCall(
        'WebFetch',
        { url: 'https://supabase.com/docs/guides/auth' },
        { url: 'https://supabase.com/docs/guides/auth' }
      ),
    ]);

    expect(result.calls).toEqual([]);
  });

  it('orders calls by when they actually happened, not grouped by channel', () => {
    const result = buildDocsResult([
      toolCall(
        'web_search',
        { query: 'https://supabase.com/changelog.md' },
        { name: 'web_search' }
      ),
      toolCall(
        'search_docs',
        { graphql_query: '{ searchDocs(query: "auth") { nodes { href } } }' },
        {
          result: {
            searchDocs: {
              nodes: [{ href: 'https://supabase.com/docs/guides/auth' }],
            },
          },
        }
      ),
    ]);

    expect(result.calls.map((c) => c.source)).toEqual([
      'web_search',
      'search_docs',
    ]);
  });

  it("keeps a page seen from two different calls in each call's own results, no cross-call dedup", () => {
    const result = buildDocsResult([
      toolCall(
        'WebFetch',
        { url: 'https://supabase.com/docs/guides/auth' },
        { url: 'https://supabase.com/docs/guides/auth', name: 'web_fetch' }
      ),
      toolCall(
        'search_docs',
        {
          graphql_query:
            '{ searchDocs(query: "auth") { nodes { title href } } }',
        },
        {
          result: {
            searchDocs: {
              nodes: [
                {
                  title: 'Auth',
                  href: 'https://supabase.com/docs/guides/auth',
                },
              ],
            },
          },
        }
      ),
    ]);

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].pages[0].url).toBe(
      'https://supabase.com/docs/guides/auth'
    );
    expect(result.calls[1].pages[0].url).toBe(
      'https://supabase.com/docs/guides/auth'
    );
  });

  it('recovers resultChars from an exact-count truncation stub', () => {
    const result = buildDocsResult([
      toolCall(
        'search_docs',
        { graphql_query: '{ searchDocs(query: "rls") { nodes { href } } }' },
        {
          result:
            'Error: result (65,754 characters across 1 line) exceeds maximum allowed tokens. ' +
            'Output has been saved to /home/node/.claude/projects/x/tool-results/y.txt.\nFormat: Plain text',
        }
      ),
    ]);

    expect(result.calls[0].resultChars).toBe(65754);
  });

  it('recovers resultChars from a KB-sized truncation stub', () => {
    const result = buildDocsResult([
      toolCall(
        'search_docs',
        { graphql_query: '{ searchDocs(query: "rls") { nodes { href } } }' },
        {
          result:
            '<persisted-output>\nOutput too large (50.8KB). Full output saved to: ' +
            '/home/node/.claude/projects/x/tool-results/y.json\n\nPreview (first 2KB):\n[...',
        }
      ),
    ]);

    expect(result.calls[0].resultChars).toBe(Math.round(50.8 * 1024));
  });
});

describe('rehydrateTruncatedDocsResults', () => {
  it("replaces a truncated search_docs result with the file's real content, read before the sandbox is disposed", async () => {
    const path = '/home/node/.claude/projects/x/tool-results/y.txt';
    const realContent = JSON.stringify({
      searchDocs: {
        nodes: [{ href: 'https://supabase.com/docs/guides/auth' }],
      },
    });
    const readFile = vi.fn().mockResolvedValue(realContent);

    const call = toolCall(
      'search_docs',
      { graphql_query: '{ searchDocs(query: "rls") { nodes { href } } }' },
      {
        result: `Error: result exceeds maximum allowed tokens. Output has been saved to ${path}.`,
      }
    );

    await rehydrateTruncatedDocsResults({ readFile }, [call]);

    expect(readFile).toHaveBeenCalledWith(path);
    expect(call.result).toBe(realContent);
  });

  it("leaves the stub in place when the file can't be read", async () => {
    const stub =
      'Error: result exceeds maximum allowed tokens. Output has been saved to /gone.txt.';
    const call = toolCall('search_docs', {}, { result: stub });
    const readFile = vi.fn().mockRejectedValue(new Error('no such file'));

    await rehydrateTruncatedDocsResults({ readFile }, [call]);

    expect(call.result).toBe(stub);
  });

  it('rehydrates a shell fetch whose output the CLI truncated to disk', async () => {
    const path = '/home/node/.claude/projects/x/tool-results/changelog.txt';
    const command = 'curl -fsSL https://supabase.com/changelog.md';
    const call = toolCall(
      'Bash',
      { command },
      {
        name: 'shell',
        command,
        result: `<persisted-output>\nOutput too large (50.8KB). Full output saved to: ${path}`,
      }
    );
    const readFile = vi.fn().mockResolvedValue('# Changelog');

    await rehydrateTruncatedDocsResults({ readFile }, [call]);

    expect(readFile).toHaveBeenCalledWith(path);
    expect(call.result).toBe('# Changelog');
  });

  it("ignores calls that aren't truncated, and calls outside the docs channels", async () => {
    const readFile = vi.fn();
    const calls = [
      toolCall('search_docs', {}, { result: { ok: true } }),
      toolCall(
        'Bash',
        {},
        { result: 'Output has been saved to /some/other/tool/output.txt.' }
      ),
    ];

    await rehydrateTruncatedDocsResults({ readFile }, calls);

    expect(readFile).not.toHaveBeenCalled();
  });
});
