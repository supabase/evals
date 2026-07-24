export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    const lastRowSet = [...result].reverse().find(hasFields);
    return hasRows(lastRowSet) ? lastRowSet.rows : [];
  }
  return hasRows(result) ? result.rows : [];
}

export function hasFields(v: unknown): v is { fields: unknown[] } {
  if (typeof v !== 'object' || v === null || !('fields' in v)) return false;
  const fields = (v as Record<string, unknown>)['fields'];
  return Array.isArray(fields) && fields.length > 0;
}

export function hasRows(v: unknown): v is { rows: unknown[] } {
  if (typeof v !== 'object' || v === null || !('rows' in v)) return false;
  return Array.isArray((v as Record<string, unknown>)['rows']);
}
