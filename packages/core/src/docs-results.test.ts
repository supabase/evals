import { describe, expect, it } from "vitest";
import { buildDocsResult } from "./docs-results.js";
import type { ToolCallRecord } from "./index.js";

/** Builds the minimal tool call record needed by docs-result tests. */
function toolCall(
  endpoint: string,
  body: Record<string, unknown>,
  options: Partial<Pick<ToolCallRecord, "url" | "result" | "name">> = {},
): ToolCallRecord {
  return { endpoint, body, ...options, ts: 0 };
}

describe("buildDocsResult", () => {
  it("builds one call from a search_docs invocation, flagging no content when the query didn't select it", () => {
    const result = buildDocsResult([
      toolCall(
        "mcp__supabase-mcp__search_docs",
        { graphql_query: '{ searchDocs(query: "rls") { nodes { title href } } }' },
        {
          result: {
            searchDocs: {
              nodes: [
                {
                  title: "Row Level Security",
                  href: "https://supabase.com/docs/guides/database/postgres/row-level-security",
                },
              ],
            },
          },
        },
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: "search_docs",
        query: '{ searchDocs(query: "rls") { nodes { title href } } }',
        hasContent: false,
        pages: [
          {
            url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
            title: "Row Level Security",
          },
        ],
      },
    ]);
  });

  it("flags hasContent true from the query's own field selection, not the result, so it survives truncation", () => {
    const result = buildDocsResult([
      toolCall(
        "search_docs",
        { graphql_query: '{ searchDocs(query: "rls") { nodes { title href content } } }' },
        { result: "Error: result exceeds maximum allowed tokens. Output has been saved to a file." },
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: "search_docs",
        query: '{ searchDocs(query: "rls") { nodes { title href content } } }',
        hasContent: true,
        pages: [],
      },
    ]);
  });

  it("doesn't mistake the word content inside a quoted search term for a field selection", () => {
    const result = buildDocsResult([
      toolCall(
        "search_docs",
        { graphql_query: '{ searchDocs(query: "content management") { nodes { title href } } }' },
        { result: { searchDocs: { nodes: [] } } },
      ),
    ]);

    expect(result.calls[0].hasContent).toBe(false);
  });

  it("finds the query nested under body.arguments (real Codex mcp_tool_call shape)", () => {
    const result = buildDocsResult([
      toolCall(
        // Codex's parser sets originalName to the MCP tool's own name
        // (item.tool), not the "mcp_tool_call" item type, and reports the
        // whole raw item as `body`, args nested under `body.arguments`.
        "search_docs",
        {
          id: "item_9",
          type: "mcp_tool_call",
          server: "supabase-mcp",
          tool: "search_docs",
          arguments: { graphql_query: '{ searchDocs(query: "rls") { nodes { title href } } }' },
        },
        {
          result: {
            searchDocs: {
              nodes: [
                {
                  title: "Row Level Security",
                  href: "https://supabase.com/docs/guides/database/postgres/row-level-security",
                },
              ],
            },
          },
        },
      ),
    ]);

    expect(result.calls[0].query).toBe('{ searchDocs(query: "rls") { nodes { title href } } }');
    expect(result.calls[0].pages.map((p) => p.url)).toEqual([
      "https://supabase.com/docs/guides/database/postgres/row-level-security",
    ]);
  });

  it("unwraps a content-array result whose text field is a JSON-encoded string (real Claude Code shape)", () => {
    const result = buildDocsResult([
      toolCall(
        "mcp__supabase-mcp__search_docs",
        { graphql_query: '{ searchDocs(query: "rls") { nodes { title href } } }' },
        {
          result: [
            {
              type: "text",
              text: JSON.stringify({
                result: {
                  searchDocs: {
                    nodes: [
                      {
                        title: "Row Level Security",
                        href: "https://supabase.com/docs/guides/database/postgres/row-level-security",
                      },
                    ],
                  },
                },
              }),
            },
          ],
        },
      ),
    ]);

    expect(result.calls[0].pages).toEqual([
      {
        url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
        title: "Row Level Security",
      },
    ]);
  });

  it("still records the call, with no pages, when the result is truncated and the query didn't select href either", () => {
    const result = buildDocsResult([
      toolCall(
        "search_docs",
        { graphql_query: '{ searchDocs(query: "rls") { nodes { content } } }' },
        { result: "Error: result exceeds maximum allowed tokens. Output has been saved to a file." },
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: "search_docs",
        query: '{ searchDocs(query: "rls") { nodes { content } } }',
        hasContent: true,
        pages: [],
      },
    ]);
  });

  it("takes a WebFetch call from its url arg, matched by canonical name not raw tool name, always counted as having content", () => {
    const result = buildDocsResult([
      toolCall(
        "WebFetch",
        { url: "https://supabase.com/docs/guides/auth", prompt: "summarize" },
        { url: "https://supabase.com/docs/guides/auth", name: "web_fetch" },
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: "web_fetch",
        query: "https://supabase.com/docs/guides/auth",
        hasContent: true,
        pages: [{ url: "https://supabase.com/docs/guides/auth" }],
      },
    ]);
  });

  it("ignores a fetch call on a non-Supabase domain", () => {
    const result = buildDocsResult([
      toolCall("WebFetch", { url: "https://example.com/foo" }, { url: "https://example.com/foo", name: "web_fetch" }),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("parses title+url pairs out of Claude Code's WebSearch Links blob, flagged as hits not reads", () => {
    const resultText =
      'Web search results for query: "Supabase RLS"\n\n' +
      'Links: [{"title":"Row Level Security | Supabase Docs","url":"https://supabase.com/docs/guides/database/postgres/row-level-security"},' +
      '{"title":"Unrelated","url":"https://example.com/rls"}]\n\nSummary text.';

    const result = buildDocsResult([
      toolCall("WebSearch", { query: "Supabase RLS documentation" }, { result: resultText, name: "web_search" }),
    ]);

    expect(result.calls).toEqual([
      {
        source: "web_search",
        query: "Supabase RLS documentation",
        hasContent: false,
        pages: [
          {
            url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
            title: "Row Level Security | Supabase Docs",
          },
        ],
      },
    ]);
  });

  it("drops a web search call that isn't Supabase-related", () => {
    const result = buildDocsResult([
      toolCall("WebSearch", { query: "how to configure nginx" }, { result: "no matches", name: "web_search" }),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("treats a URL-shaped Codex web_search query as a fetch call of unknown content, same as Claude's WebSearch fetch pattern would", () => {
    const result = buildDocsResult([
      toolCall(
        "web_search",
        { query: "https://supabase.com/docs/guides/database/extensions/pg_net" },
        { name: "web_search" },
      ),
    ]);

    expect(result.calls).toEqual([
      {
        source: "web_search",
        query: "https://supabase.com/docs/guides/database/extensions/pg_net",
        pages: [{ url: "https://supabase.com/docs/guides/database/extensions/pg_net" }],
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it("treats a search-term Codex web_search call as unknown content with no pages", () => {
    const result = buildDocsResult([
      toolCall("web_search", { query: "site:supabase.com/docs pg_cron schedule" }, { name: "web_search" }),
    ]);

    expect(result.calls).toEqual([
      {
        source: "web_search",
        query: "site:supabase.com/docs pg_cron schedule",
        pages: [],
      },
    ]);
    expect(result.calls[0].hasContent).toBeUndefined();
  });

  it("ignores WebFetch/WebSearch-shaped calls when the parser never normalized a canonical name", () => {
    const result = buildDocsResult([
      toolCall("WebFetch", { url: "https://supabase.com/docs/guides/auth" }, { url: "https://supabase.com/docs/guides/auth" }),
    ]);

    expect(result.calls).toEqual([]);
  });

  it("orders calls by when they actually happened, not grouped by channel", () => {
    const result = buildDocsResult([
      toolCall("web_search", { query: "https://supabase.com/changelog.md" }, { name: "web_search" }),
      toolCall(
        "search_docs",
        { graphql_query: '{ searchDocs(query: "auth") { nodes { href } } }' },
        { result: { searchDocs: { nodes: [{ href: "https://supabase.com/docs/guides/auth" }] } } },
      ),
    ]);

    expect(result.calls.map((c) => c.source)).toEqual(["web_search", "search_docs"]);
  });

  it("keeps a page seen from two different calls in each call's own results, no cross-call dedup", () => {
    const result = buildDocsResult([
      toolCall("WebFetch", { url: "https://supabase.com/docs/guides/auth" }, { url: "https://supabase.com/docs/guides/auth", name: "web_fetch" }),
      toolCall(
        "search_docs",
        { graphql_query: '{ searchDocs(query: "auth") { nodes { title href } } }' },
        { result: { searchDocs: { nodes: [{ title: "Auth", href: "https://supabase.com/docs/guides/auth" }] } } },
      ),
    ]);

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].pages[0].url).toBe("https://supabase.com/docs/guides/auth");
    expect(result.calls[1].pages[0].url).toBe("https://supabase.com/docs/guides/auth");
  });
});
