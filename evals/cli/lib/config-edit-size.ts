const BINARY_MAP: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

const SIZE_NUMBER_RE =
  /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)([eE][+-]?\d(?:_?\d)*)?$/;

/** Bytes for a `file_size_limit` string, parsed as the CLI does (1024-based, case-insensitive, optional `b`/`ib`); undefined when the CLI would reject it. */
export function ramInBytes(sizeStr: string): number | undefined {
  let sep = -1;
  for (let i = 0; i < sizeStr.length; i++) {
    if ('0123456789. '.includes(sizeStr[i])) sep = i;
  }
  if (sep === -1) return undefined;
  const spaced = sizeStr[sep] === ' ';
  const num = sizeStr.slice(0, spaced ? sep : sep + 1);
  const suffix = sizeStr.slice(sep + 1).toLowerCase();
  if (!SIZE_NUMBER_RE.test(num)) return undefined;
  const size = Number.parseFloat(num.replace(/_/g, ''));
  if (!Number.isFinite(size) || size < 0) return undefined;
  if (suffix === '') return Math.trunc(size);
  if (suffix.length > 3) return undefined;
  if (suffix[0] === 'b')
    return suffix.length > 1 ? undefined : Math.trunc(size);
  const multiplier = BINARY_MAP[suffix[0]];
  if (multiplier === undefined) return undefined;
  if (suffix.length === 2 && suffix[1] !== 'b') return undefined;
  if (suffix.length === 3 && suffix.slice(1) !== 'ib') return undefined;
  return Math.trunc(size * multiplier);
}
