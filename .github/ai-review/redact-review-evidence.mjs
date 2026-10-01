const REPLACEMENT = '<<redacted>>';
const SECRET_FIELD =
  /(?:^|_)(?:secret|password|token|api_key|private_key|service_role)(?:_|$)|^authorization$|^cookie$/i;

export function redactSecrets(value, env = process.env) {
  let text = String(value ?? '');
  for (const [name, raw] of Object.entries(env)) {
    if (
      raw &&
      raw.length >= 8 &&
      /(TOKEN|KEY|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)
    ) {
      text = text.split(raw).join(REPLACEMENT);
    }
  }
  return text
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sb_secret_[A-Za-z0-9_-]{16,})\b/g,
      REPLACEMENT
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REPLACEMENT
    )
    .replace(
      /\b([A-Za-z0-9_]*(?:secret|password|(?:api|private|service_role)[_-]?key|access[_-]?token)[A-Za-z0-9_]*|token|authorization)(["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
      (_, name, separator) => `${name}${separator}${REPLACEMENT}`
    )
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, `$1${REPLACEMENT}@`);
}

export function redactDeep(value, env = process.env) {
  if (typeof value === 'string') return redactSecrets(value, env);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_FIELD.test(key) ? REPLACEMENT : redactDeep(entry, env),
      ])
    );
  }
  return value;
}
