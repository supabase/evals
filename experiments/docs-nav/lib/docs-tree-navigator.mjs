const SITE = 'https://supabase.com';
const VARIANT_PARAM = 'docs-ia-mvp-v1';

export const ROOT = 'root';
export const OPEN_TOOL = 'open_section';
export const CHOOSE_TOOL = 'choose_page';
const OPENED_PREFIX = 'Opened:';
const CHOSEN_PREFIX = 'Chosen:';
const REFUSED_PREFIX = 'Not allowed:';

const INSTRUCTIONS = `This is a tree test of the Supabase docs navigation. You can't read docs pages, only the labels in the navigation. Use \`${OPEN_TOOL}\` with \`${ROOT}\` to start at the top, then open the sections you think lead to the answer. You can go back to any section you've opened. When you find the page where you'd expect the answer, choose it with \`${CHOOSE_TOOL}\`. You get one choice. Then reply with the page you chose.`;

export function treeUrl(env) {
  const origin = env.DOCS_ORIGIN?.replace(/\/+$/, '') ?? SITE;
  const url = new URL('/docs/nav-tree.json', origin);
  if (env.DOCS_IA_VARIANT) {
    url.searchParams.set(VARIANT_PARAM, env.DOCS_IA_VARIANT);
  }
  return url.toString();
}

function nodeAt(tree, id) {
  if (id === ROOT) return { node: tree.root, trail: [] };
  let node = tree.root;
  const trail = [];
  for (const part of id.split('.')) {
    const index = Number(part) - 1;
    node = Number.isInteger(index) ? node?.children?.[index] : undefined;
    if (!node) return null;
    trail.push(node.label);
  }
  return { node, trail };
}

const childId = (id, index) =>
  id === ROOT ? `${index + 1}` : `${id}.${index + 1}`;

function kind(node) {
  if (node.children?.length && node.route) return ' (a page, and a section)';
  if (node.children?.length) return ' (a section)';
  return '';
}

export function createTreeSession(tree, url, { topLevels = 1 } = {}) {
  const visible = new Set([ROOT]);
  let chosen = null;

  const refuse = (text) => ({
    isError: true,
    text: `${REFUSED_PREFIX} ${text}`,
  });

  function open(rawId) {
    const id = String(rawId ?? '').trim();
    const found = nodeAt(tree, id);
    if (!found || !visible.has(id)) {
      return refuse(
        `${id} isn't listed in a section you've opened. Start with ${ROOT}.`
      );
    }
    const { node, trail } = found;
    if (!node.children?.length) {
      return refuse(
        `${node.label} is a page, not a section. Choose it with ${CHOOSE_TOOL} if it's where you'd find the answer.`
      );
    }
    const peek = id === ROOT && topLevels >= 2;
    const line = (child, childKey, indent) =>
      `${indent}- [${childKey}] ${child.label}${kind(child)}${child.description ? `\n${indent}  ${child.description}` : ''}`;
    const items = node.children
      .flatMap((child, index) => {
        const key = childId(id, index);
        visible.add(key);
        const below = peek
          ? (child.children ?? []).map((grandchild, inner) => {
              const innerKey = childId(key, inner);
              visible.add(innerKey);
              return line(grandchild, innerKey, '  ');
            })
          : [];
        return [line(child, key, ''), ...below];
      })
      .join('\n');
    return {
      text: [
        `${OPENED_PREFIX} [${id}] ${trail.join(' › ') || tree.root.label}`,
        ...(id === ROOT ? [`Tree: ${url}`] : []),
        '',
        `In this section:\n${items}`,
      ].join('\n'),
    };
  }

  function choose(rawId) {
    const id = String(rawId ?? '').trim();
    if (chosen) return refuse(`you already chose [${chosen}].`);
    const found = nodeAt(tree, id);
    if (!found || !visible.has(id)) {
      return refuse(`${id} isn't listed in a section you've opened.`);
    }
    const { node, trail } = found;
    if (!node.route) {
      return refuse(
        `${node.label} is a section heading, not a page. Open it to see its pages.`
      );
    }
    chosen = id;
    return {
      text: `${CHOSEN_PREFIX} [${id}] ${trail.join(' › ')}\nTree: ${url}\nThe tree test is over. Reply with the page you chose.`,
    };
  }

  return { open, choose };
}

const TOOLS = [
  {
    name: OPEN_TOOL,
    description: `Open a section of the Supabase docs navigation to see what's in it. Pass \`${ROOT}\` for the top, or the id of a section listed in a section you've opened. Reopen a section to go back.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `A section id, or \`${ROOT}\`.` },
      },
      required: ['id'],
    },
  },
  {
    name: CHOOSE_TOOL,
    description:
      "Choose the page where you'd expect to find the answer. Pass the id of a page listed in a section you've opened. You choose once.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The page id.' },
      },
      required: ['id'],
    },
  },
];

function serve() {
  const url = treeUrl(process.env);
  const session = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Couldn't load ${url}: HTTP ${res.status}`);
      return res.json();
    })
    .then((tree) =>
      createTreeSession(tree, url, {
        topLevels: Number(process.env.DOCS_TREE_TOP_LEVELS ?? 1),
      })
    );
  const send = (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = ({ isError, text }) => ({
    ...(isError ? { isError } : {}),
    content: [{ type: 'text', text }],
  });

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
            serverInfo: { name: 'docs-tree-navigator', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        });
      }
      if (method === 'tools/list') {
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      }
      if (method === 'tools/call') {
        const target = params?.arguments?.id;
        const tree = await session;
        if (params?.name === OPEN_TOOL) {
          return send({ jsonrpc: '2.0', id, result: reply(tree.open(target)) });
        }
        if (params?.name === CHOOSE_TOOL) {
          return send({
            jsonrpc: '2.0',
            id,
            result: reply(tree.choose(target)),
          });
        }
        throw new Error(`Unknown tool: ${params?.name}`);
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

if (process.env.DOCS_TREE_NAVIGATOR_SERVE === '1') serve();
