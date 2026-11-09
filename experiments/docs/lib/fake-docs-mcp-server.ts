import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type McpServerDefinition,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { source } from 'common-tags';

interface DocsPage {
  title: string;
  href: string;
  content: string;
}

// the subset of the content api schema that search_docs needs
const DOCS_SCHEMA = source`
  schema {
    query: RootQueryType
  }

  type RootQueryType {
    searchDocs(query: String!, limit: Int): SearchResultCollection
  }

  interface SearchResult {
    title: String
    href: String
    content: String
  }

  type SearchResultCollection {
    nodes: [SearchResult!]!
  }
`;

export const fakeDocsMcpServer = (options: {
  features: string[];
  pages: DocsPage[];
}): McpServerDefinition => {
  const base = supabaseMcpServer({ features: options.features });

  return {
    name: base.name,
    async createConfig(context) {
      const docsServer = createServer((request, response) => {
        const query =
          new URL(request.url ?? '/', 'http://localhost').searchParams.get(
            'query'
          ) ?? '';
        // like the real api, send content only when the query selects it
        const selectsContent = /\bcontent\b/.test(
          query.replace(/"(?:[^"\\]|\\.)*"/g, '')
        );
        const nodes = selectsContent
          ? options.pages
          : options.pages.map(({ title, href }) => ({ title, href }));
        const data = query.includes('searchDocs')
          ? { searchDocs: { nodes } }
          : { schema: DOCS_SCHEMA };
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data }));
      });
      // 0.0.0.0 so a sandboxed mcp server reaches it, and rewriteLoopback maps 127.0.0.1 to host.docker.internal
      await new Promise<void>((resolve) =>
        docsServer.listen(0, '0.0.0.0', resolve)
      );
      const { port } = docsServer.address() as AddressInfo;
      const closeDocsServer = () =>
        new Promise<void>((resolve) => docsServer.close(() => resolve()));

      try {
        const resolved = await base.createConfig(context);
        return {
          config: {
            ...resolved.config,
            args: [
              ...(resolved.config.args ?? []),
              '--content-api-url',
              `http://127.0.0.1:${port}/graphql`,
            ],
          },
          cleanup: async () => {
            await closeDocsServer();
            await resolved.cleanup?.();
          },
        };
      } catch (err) {
        await closeDocsServer();
        throw err;
      }
    },
  };
};
