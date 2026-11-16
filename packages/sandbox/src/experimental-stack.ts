import { applyEdits, modify } from 'jsonc-parser';

const EXPERIMENTAL_HEADER = /^\s*\[experimental\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const STACK_KEY = /^\s*stack\s*=/;

/** Returns the config text with `[experimental] stack = true` set, leaving comments and other keys untouched. */
export function enableExperimentalStack(
  text: string,
  format: 'toml' | 'jsonc'
): string {
  return format === 'toml' ? enableInToml(text) : enableInJsonc(text);
}

function enableInToml(text: string): string {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => EXPERIMENTAL_HEADER.test(line));
  if (header === -1) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}\n[experimental]\nstack = true\n`;
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (ANY_HEADER.test(lines[i])) {
      end = i;
      break;
    }
  }
  const existing = lines.findIndex(
    (line, i) => i > header && i < end && STACK_KEY.test(line)
  );
  if (existing !== -1) {
    lines[existing] = 'stack = true';
  } else {
    lines.splice(header + 1, 0, 'stack = true');
  }
  return lines.join('\n');
}

function enableInJsonc(text: string): string {
  const edits = modify(text, ['experimental', 'stack'], true, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(text, edits);
}
