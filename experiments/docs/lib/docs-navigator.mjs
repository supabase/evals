/**
 * A docs browser that only follows links. Its one MCP tool, `open_page`,
 * opens the docs root, or any link listed on a page the agent has already
 * opened, and refuses anything else. An agent with no other tools can reach
 * a page only by navigating to it, never from a URL it remembers.
 *
 * Self-contained, with no dependencies, so the harness runs it inside the
 * sandbox with `node --input-type=module -e`. It serves MCP over stdio when
 * DOCS_NAVIGATOR_SERVE=1, so its functions can also be imported and tested.
 */

// Serves the docs from another host, such as a deploy preview, when set.
const ORIGIN = process.env.DOCS_NAVIGATOR_ORIGIN ?? 'https://supabase.com';
const DOCS_HOSTS = new Set(['supabase.com', new URL(ORIGIN).hostname]);

export const DOCS_ROOT = `${ORIGIN}/docs`;
export const BLOCKED_PREFIX = 'Not opened:';

const MAX_CONTENT_CHARS = 40_000;
const MAX_LINKS = 250;
const ASSET_PATTERN =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|xml|json|txt|pdf)$/i;

/**
 * A supabase.com url without query, anchor, `.md`, or trailing slash; null for
 * other hosts. Docs urls point at the docs origin.
 */
export function normalizeUrl(url, base) {
  let parsed;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }
  if (!DOCS_HOSTS.has(parsed.hostname)) return null;
  const path = parsed.pathname.replace(/\.md$/, '').replace(/\/+$/, '');
  if (ASSET_PATTERN.test(path)) return null;
  const isDocs = path === '/docs' || path.startsWith('/docs/');
  return `${isDocs ? ORIGIN : 'https://supabase.com'}${path}`;
}

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

/**
 * Fetches a page's HTML, following redirects, and lists every supabase.com
 * link it serves, with its label. These are the links a crawler or an agent
 * fetching the page can see: anything a browser adds later with JavaScript,
 * such as a collapsed sidebar section, isn't here.
 */
export async function pageLinks(url, overlay = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const finalUrl = normalizeUrl(res.url) ?? url;
  if (!res.ok)
    return { ok: false, status: res.status, finalUrl, html: '', links: [] };
  const html = await res.text();
  const seen = new Map();
  for (const match of html.matchAll(
    /<a\b[^>]*?href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const target = normalizeUrl(decodeEntities(match[1]), finalUrl);
    if (!target || target === finalUrl) continue;
    const label = stripTags(match[2]).slice(0, 120);
    if (!seen.has(target) || (!seen.get(target) && label))
      seen.set(target, label);
  }
  return {
    ok: true,
    status: res.status,
    finalUrl,
    html,
    links: [
      // Links a proposed IA fix would add to this page, listed first.
      ...(overlay[finalUrl] ?? []).filter(({ href }) => !seen.has(href)),
      ...[...seen].map(([href, label]) => ({ href, label })),
    ],
  };
}

/** The page's readable text: its published markdown when there is one, else the HTML's text. */
async function pageText(finalUrl, html) {
  try {
    const res = await fetch(`${finalUrl}.md`, {
      signal: AbortSignal.timeout(20_000),
    });
    const text = res.ok ? await res.text() : '';
    if (text && !/^\s*</.test(text)) return text;
  } catch {}
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  return stripTags(main);
}

/** One page as the agent sees it: text, then the links it may open next. */
export async function renderPage(url, overlay = {}) {
  const page = await pageLinks(url, overlay);
  if (!page.ok)
    return { text: `Could not open ${url}: HTTP ${page.status}`, page };
  const content = await pageText(page.finalUrl, page.html);
  const body =
    content.length > MAX_CONTENT_CHARS
      ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Page truncated.]`
      : content;
  const links = page.links
    .slice(0, MAX_LINKS)
    .map(({ href, label }) => `- ${label || '(no label)'}: ${href}`)
    .join('\n');
  return {
    text: `Opened: ${page.finalUrl}\n\n${body}\n\nLinks on this page, which you can open next:\n${links}`,
    page,
  };
}

const TOOL = {
  name: 'open_page',
  description: `Open a Supabase docs page and read it. You can open ${DOCS_ROOT}, or any link listed on a page you have already opened. Each page lists its links at the end.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The page URL to open.' },
    },
    required: ['url'],
  },
};

/**
 * Proposed links to add, by page url, as JSON in DOCS_NAVIGATOR_OVERLAY. Lets
 * an experiment test an IA fix before anyone changes the docs.
 */
function overlayFromEnv() {
  try {
    return JSON.parse(process.env.DOCS_NAVIGATOR_OVERLAY ?? '{}');
  } catch {
    return {};
  }
}

async function serve() {
  const overlay = overlayFromEnv();
  const allowed = new Set([DOCS_ROOT]);
  const send = (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);

  async function openPage(url) {
    const target = normalizeUrl(String(url ?? ''));
    if (!target || !allowed.has(target)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${BLOCKED_PREFIX} ${url} isn't linked from any page you've opened. Start at ${DOCS_ROOT} and open links listed on the pages you read.`,
          },
        ],
      };
    }
    const { text, page } = await renderPage(target, overlay);
    allowed.add(page.finalUrl);
    for (const { href } of page.links) allowed.add(href);
    return { content: [{ type: 'text', text }] };
  }

  async function handle(message) {
    const { id, method, params } = message;
    if (id === undefined) return; // A notification needs no reply.
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
      if (method === 'tools/list')
        return send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
      if (method === 'tools/call') {
        if (params?.name !== TOOL.name)
          throw new Error(`Unknown tool: ${params?.name}`);
        return send({
          jsonrpc: '2.0',
          id,
          result: await openPage(params.arguments?.url),
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
