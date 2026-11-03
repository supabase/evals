const SITE = 'https://supabase.com';
const BLOCKED_PREFIX = 'Not opened:';
const VARIANT_PARAM = 'docs-ia-mvp-v1';

const MAX_CONTENT_CHARS = 40_000;
const MAX_LINKS = 250;
const TIMEOUT_MS = 20_000;
const ASSET_PATTERN =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|xml|json|txt|pdf)$/i;

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function navRegions(html) {
  const regions = [];
  for (const open of html.matchAll(
    /<([a-z][a-z0-9]*)\b[^>]*\bdata-docs-nav="[^"]*"[^>]*>/gi
  )) {
    const start = open.index + open[0].length;
    const tags = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'gi');
    let depth = 1;
    let end = html.length;
    for (const match of html.slice(start).matchAll(tags)) {
      depth += match[1] ? -1 : 1;
      if (depth === 0) {
        end = start + match.index;
        break;
      }
    }
    regions.push(html.slice(start, end));
  }
  return regions.join('\n');
}

export function createNavigator({ env, fetch }) {
  const variant = env.DOCS_IA_VARIANT;
  const navOnly = env.DOCS_NAV_ONLY === '1';
  const root = `${SITE}/docs`;
  const allowed = new Set([root]);

  function canonicalUrl(url, base) {
    let parsed;
    try {
      parsed = new URL(url, base);
    } catch {
      return null;
    }
    if (parsed.origin !== SITE) return null;
    const path = parsed.pathname.replace(/\.md$/, '').replace(/\/+$/, '');
    if (ASSET_PATTERN.test(path)) return null;
    return `${SITE}${path}`;
  }

  function requestUrl(url) {
    if (!variant) return url;
    const parsed = new URL(url);
    parsed.searchParams.set(VARIANT_PARAM, variant);
    return parsed.toString();
  }

  async function get(url) {
    return fetch(requestUrl(url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  function linksOn(html, pageUrl) {
    const seen = new Map();
    for (const match of html.matchAll(
      /<a\b[^>]*?href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
    )) {
      const target = canonicalUrl(decodeEntities(match[1]), pageUrl);
      if (!target || target === pageUrl) continue;
      const label = stripTags(match[2]).slice(0, 120);
      if (!seen.has(target) || (!seen.get(target) && label)) {
        seen.set(target, label);
      }
    }
    return [...seen].map(([href, label]) => ({ href, label }));
  }

  async function textOf(pageUrl, html) {
    try {
      const res = await get(`${pageUrl}.md`);
      const text = res.ok ? await res.text() : '';
      if (text && !/^\s*</.test(text)) return text;
    } catch {}
    const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
    return stripTags(main);
  }

  function refuse(url) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${BLOCKED_PREFIX} ${url} isn't linked from any page you've opened. Start at ${root} and open links listed on the pages you read.`,
        },
      ],
    };
  }

  async function render(url) {
    const res = await get(url);
    const pageUrl = canonicalUrl(res.url) ?? url;
    if (!res.ok) return `Could not open ${url}: HTTP ${res.status}`;
    const html = await res.text();
    const links = linksOn(navOnly ? navRegions(html) : html, pageUrl);
    allowed.add(pageUrl);
    for (const { href } of links) allowed.add(href);
    const content = await textOf(pageUrl, html);
    const body =
      content.length > MAX_CONTENT_CHARS
        ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Page truncated.]`
        : content;
    const list = links
      .slice(0, MAX_LINKS)
      .map(({ href, label }) => `- ${label || '(no label)'}: ${href}`)
      .join('\n');
    return `Opened: ${requestUrl(pageUrl)}\n\n${body}\n\n${navOnly ? "Links in this page's navigation" : 'Links on this page'}, which you can open next:\n${list}`;
  }

  async function openPage(url) {
    const target = canonicalUrl(String(url ?? ''));
    if (!target || !allowed.has(target)) return refuse(url);
    try {
      return { content: [{ type: 'text', text: await render(target) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Could not open ${url}: ${error?.message ?? error}`,
          },
        ],
      };
    }
  }

  const tool = {
    name: 'open_page',
    description: `Open a Supabase docs page and read it. You can open ${root}, or any link listed on a page you have already opened. Each page lists its links at the end.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL to open.' },
      },
      required: ['url'],
    },
  };

  return { root, tool, openPage };
}

function serve() {
  const navigator = createNavigator({
    env: process.env,
    fetch: globalThis.fetch,
  });
  const send = (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);

  async function handle({ id, method, params }) {
    if (id === undefined) return;
    try {
      if (method === 'initialize') {
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'docs-navigator', version: '1.0.0' },
          },
        });
      }
      if (method === 'tools/list') {
        return send({
          jsonrpc: '2.0',
          id,
          result: { tools: [navigator.tool] },
        });
      }
      if (method === 'tools/call') {
        if (params?.name !== navigator.tool.name) {
          throw new Error(`Unknown tool: ${params?.name}`);
        }
        return send({
          jsonrpc: '2.0',
          id,
          result: await navigator.openPage(params.arguments?.url),
        });
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: String(error?.message ?? error) },
      });
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  });
}

if (process.env.DOCS_NAVIGATOR_SERVE === '1') serve();
