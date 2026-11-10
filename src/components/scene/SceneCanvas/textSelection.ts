/** A selection in a line of text, as an input keeps one. */
export type TextRange = { start: number; end: number; backward?: boolean };

/**
 * The selection a run of clicks makes at `index`: the caret alone, the word around
 * it, or all of `text`.
 */
export function rangeForClicks(text: string, index: number, clicks: number): TextRange {
  const at = Math.max(0, Math.min(index, text.length));
  if (clicks >= 3) return { start: 0, end: text.length };
  if (clicks === 2) return wordRangeAt(text, at);
  return { start: at, end: at };
}

/**
 * The run of characters a double click at `index` takes: the word under it, or the
 * spaces when it lands between words. A click past the end takes the last word.
 */
export function wordRangeAt(text: string, index: number): TextRange {
  if (!text) return { start: 0, end: 0 };
  const probe = Math.min(index, text.length - 1);
  const isSpace = (char: string) => /\s/.test(char);
  const spaces = isSpace(text[probe]);
  let start = probe;
  let end = probe + 1;
  while (start > 0 && isSpace(text[start - 1]) === spaces) start -= 1;
  while (end < text.length && isSpace(text[end]) === spaces) end += 1;
  return { start, end };
}

/**
 * The selection a drag makes from `anchor` to the pointer: by character, or by
 * whole words after a double click. `index` is the caret position under the pointer
 * for the first, and the character under it for the second. Going back past the
 * anchor flips the selection to run from the pointer to the anchor's end.
 */
export function dragSelection(text: string, anchor: TextRange, index: number, byWord: boolean): TextRange {
  const reach = byWord ? wordRangeAt(text, index) : { start: index, end: index };
  if (reach.start < anchor.start) return { start: reach.start, end: anchor.end, backward: true };
  return { start: anchor.start, end: Math.max(anchor.end, reach.end) };
}
