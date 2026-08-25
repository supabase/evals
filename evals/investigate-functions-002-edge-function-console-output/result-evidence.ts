const CONSOLE_FINDINGS = [
  ['SPRING24', 'cart_8f21ac'],
  ['pricing-gateway', 'timed out after 3 retries'],
] as const;

type JsonObject = Record<string, unknown>;

export type ConsoleRowEvidence = {
  foundFinding: boolean;
  markers: string[];
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Recover the JSON the pinned server embedded in its untrusted-data boundary.
 *
 * `query_logs` does not hand back the rows as JSON. It returns
 * `{ result: wrapWithUntrustedDataBoundary(body) }`, and that helper returns a
 * STRING: `JSON.stringify(body)` sits between `<untrusted-data-{uuid}>` tags,
 * with prose either side
 * (`packages/mcp-server-supabase/src/tools/util.ts:89-101` and
 * `debugging-tools.ts:254`, at tag `mcp-server-supabase-v0.11.0`).
 *
 * An extractor that only accepts an array `result` therefore reads zero rows
 * off a run that did read them, and the check reports "markers returned: none"
 * — a false negative.
 *
 * Scanning backwards matters: that prose names `<untrusted-data-{uuid}>` both
 * before and after the block, so the first open tag in the string is not the
 * one that opens the data. Only the bytes between the real tags are returned,
 * so a marker quoted in the surrounding prose is not evidence.
 */
function untrustedDataPayload(value: string): string | undefined {
  const close = value.lastIndexOf('</untrusted-data-');
  if (close === -1) return undefined;

  const open = value.lastIndexOf('<untrusted-data-', close);
  if (open === -1) return undefined;

  const openEnd = value.indexOf('>', open);
  if (openEnd === -1 || openEnd > close) return undefined;

  return value.slice(openEnd + 1, close).trim();
}

/**
 * Parse a string that should carry JSON, seeing through that wrapper.
 *
 * Plain JSON first, so every already-working shape keeps its exact behaviour;
 * the wrapper and the brace fallback only run once that fails. Bounded on
 * purpose — this unwraps a string that contains JSON, it does not deep-search.
 */
function parseEmbeddedJson(value: string): unknown {
  const direct = parseJson(value);
  if (direct !== undefined) return direct;

  const embedded = untrustedDataPayload(value);
  if (embedded !== undefined) return parseJson(embedded);

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  return parseJson(value.slice(start, end + 1));
}

/**
 * The rows one payload came back with.
 *
 * A `result` array is used as-is. A `result` string is unwrapped once (see
 * `untrustedDataPayload`) and then read with the same `{ result: [rows] }`
 * rule, because the JSON the pinned server embeds is the management API body,
 * which is itself `{ result: [rows] }`.
 */
function payloadRows(payload: unknown): unknown[] {
  if (!isJsonObject(payload)) return [];

  const { result } = payload;
  if (Array.isArray(result)) return result;
  if (typeof result !== 'string') return [];

  const unwrapped = parseEmbeddedJson(result);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (isJsonObject(unwrapped) && Array.isArray(unwrapped.result)) {
    return unwrapped.result;
  }

  return [];
}

/** Extract platform-lite rows from a raw Claude Code MCP result. */
function queryResultRows(result: unknown): unknown[] {
  const payloads = (() => {
    if (typeof result === 'string') return [parseEmbeddedJson(result)];
    if (!Array.isArray(result)) return [result];

    return result.map((block) =>
      isJsonObject(block) && typeof block.text === 'string'
        ? parseEmbeddedJson(block.text)
        : block
    );
  })();

  return payloads.flatMap(payloadRows);
}

function appendStringValues(value: unknown, values: string[]): void {
  if (typeof value === 'string') {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendStringValues(item, values);
    return;
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) appendStringValues(item, values);
  }
}

/** Find complete console findings in row values, never column names. */
export function consoleRowEvidence(result: unknown): ConsoleRowEvidence {
  const markers = new Set<string>();
  let foundFinding = false;

  for (const row of queryResultRows(result)) {
    const values: string[] = [];
    appendStringValues(row, values);
    const text = values.join('\n').toLowerCase();

    for (const finding of CONSOLE_FINDINGS) {
      for (const marker of finding) {
        if (text.includes(marker.toLowerCase())) markers.add(marker);
      }
      if (finding.every((marker) => text.includes(marker.toLowerCase()))) {
        foundFinding = true;
      }
    }
  }

  return { foundFinding, markers: [...markers] };
}
