/**
 * A tree test of the docs navigation. The agent sees only labels: a section's
 * label and the labels of what's in it, never a page's content or url. Its
 * MCP tools open a section and choose a page, the same moves as a person
 * taking a tree test.
 *
 * Self-contained, with no dependencies, so the harness runs it inside the
 * sandbox with `node --input-type=module -e`. It serves MCP over stdio when
 * TREE_NAVIGATOR_SERVE=1, reading the tree from TREE_NAVIGATOR_TREE, as made
 * by `encodeTree`, so its functions can also be imported and tested.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

export const ROOT = 'root';
export const OPENED_PREFIX = 'Opened:';
export const CHOSEN_PREFIX = 'Chosen:';
export const REFUSED_PREFIX = 'Not allowed:';
export const OPEN_TOOL = 'open_section';
export const CHOOSE_TOOL = 'choose_page';

export const INSTRUCTIONS = `This is a tree test of the Supabase docs navigation. You can't read docs pages, only the labels in the navigation. Use \`${OPEN_TOOL}\` with \`${ROOT}\` to start at the top, then open the sections you think lead to the answer. You can go back to any section you've opened. When you find the page where you'd expect the answer, choose it with \`${CHOOSE_TOOL}\`. You get one choice. Then reply with the page you chose.`;

/** The tree as compact, gzipped JSON, small enough for an environment variable. */
export function encodeTree(tree) {
  const compact = (node) => [
    node.label,
    node.route ?? 0,
    ...(node.children?.length ? [node.children.map(compact)] : []),
  ];
  return gzipSync(JSON.stringify([tree.name, compact(tree.root)])).toString(
    'base64'
  );
}

export function decodeTree(encoded) {
  const [name, root] = JSON.parse(
    gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')
  );
  const expand = ([label, route, children]) => ({
    label,
    ...(route ? { route } : {}),
    ...(children ? { children: children.map(expand) } : {}),
  });
  return { name, root: expand(root) };
}

/** A node by its dotted id, like `3.1.4`, with the labels on the way to it. */
export function nodeAt(tree, id) {
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

function describe(node) {
  if (node.children?.length && node.route) return ' (a page, and a section)';
  if (node.children?.length) return ' (a section)';
  return '';
}

/**
 * One tree test: what the agent has opened and can see. Each move returns the
 * text the agent reads, or an error when the move isn't allowed.
 */
export function createTreeSession(tree) {
  const visible = new Set([ROOT]);
  let chosen = null;

  const refuse = (text) => ({
    isError: true,
    text: `${REFUSED_PREFIX} ${text}`,
  });

  function open(rawId) {
    const id = String(rawId ?? '').trim();
    const found = nodeAt(tree, id);
    if (!found || !visible.has(id))
      return refuse(
        `${id} isn't listed in a section you've opened. Start with ${ROOT}.`
      );
    const { node, trail } = found;
    if (!node.children?.length)
      return refuse(
        `${node.label} is a page, not a section. Choose it with ${CHOOSE_TOOL} if it's where you'd find the answer.`
      );
    node.children.forEach((_, index) => visible.add(childId(id, index)));
    const items = node.children
      .map(
        (child, index) =>
          `- [${childId(id, index)}] ${child.label}${describe(child)}`
      )
      .join('\n');
    return {
      text: [
        `${OPENED_PREFIX} [${id}] ${trail.join(' › ') || tree.root.label}`,
        ...(id === ROOT ? [`Tree: ${tree.name}`] : []),
        '',
        `In this section:\n${items}`,
      ].join('\n'),
    };
  }

  function choose(rawId) {
    const id = String(rawId ?? '').trim();
    if (chosen) return refuse(`you already chose [${chosen}].`);
    const found = nodeAt(tree, id);
    if (!found || !visible.has(id))
      return refuse(`${id} isn't listed in a section you've opened.`);
    const { node, trail } = found;
    if (!node.route)
      return refuse(
        `${node.label} is a section heading, not a page. Open it to see its pages.`
      );
    chosen = id;
    return {
      text: `${CHOSEN_PREFIX} [${id}] ${trail.join(' › ')}\nTree: ${tree.name}\nRoute: ${node.route}\nThe tree test is over. Reply with the page you chose.`,
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
  const session = createTreeSession(
    decodeTree(process.env.TREE_NAVIGATOR_TREE ?? '')
  );
  const send = (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = ({ isError, text }) => ({
    ...(isError ? { isError } : {}),
    content: [{ type: 'text', text }],
  });

  function handle(message) {
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
            serverInfo: { name: 'tree-navigator', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        });
      }
      if (method === 'tools/list')
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const target = params?.arguments?.id;
        if (params?.name === OPEN_TOOL)
          return send({
            jsonrpc: '2.0',
            id,
            result: reply(session.open(target)),
          });
        if (params?.name === CHOOSE_TOOL)
          return send({
            jsonrpc: '2.0',
            id,
            result: reply(session.choose(target)),
          });
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

if (process.env.TREE_NAVIGATOR_SERVE === '1') serve();
