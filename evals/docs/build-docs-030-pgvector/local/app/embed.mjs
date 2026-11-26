// Turns a piece of text into the list of numbers the search works with. This
// is a small stand-in for the real model so the project runs offline; it
// always gives back DIMENSIONS numbers, and similar texts give similar lists.
export const DIMENSIONS = 8;

export function embed(text) {
  const out = new Array(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    out[hash % DIMENSIONS] += 1;
  }
  const length = Math.hypot(...out) || 1;
  return out.map((value) => value / length);
}
