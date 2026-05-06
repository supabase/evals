export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    const last = result[result.length - 1]
    return hasRows(last) ? last.rows : []
  }
  return hasRows(result) ? result.rows : []
}

export function hasRows(v: unknown): v is { rows: unknown[] } {
  if (typeof v !== 'object' || v === null || !('rows' in v)) return false
  return Array.isArray((v as Record<string, unknown>)['rows'])
}
