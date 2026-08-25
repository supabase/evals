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

/** Extract platform-lite rows from a raw Claude Code MCP result. */
function queryResultRows(result: unknown): unknown[] {
  const payloads = (() => {
    if (typeof result === 'string') return [parseJson(result)];
    if (!Array.isArray(result)) return [result];

    return result.map((block) =>
      isJsonObject(block) && typeof block.text === 'string'
        ? parseJson(block.text)
        : block
    );
  })();

  return payloads.flatMap((payload) =>
    isJsonObject(payload) && Array.isArray(payload.result) ? payload.result : []
  );
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
