const FONT_SIZE_PATTERN = /(\d*\.?\d+)px/;

/**
 * Returns `font` shrunk just enough for `text` to fit within `maxWidth`, or
 * `font` unchanged when it already fits.
 *
 * Labels baked into canvas textures (the view cube faces, the build plate's
 * FRONT marker) are sized for English. Translations are frequently much longer
 * — "Left" becomes "IZQUIERDA", "Front" becomes "VORDERSEITE" — and would bleed
 * past the texture edge at the original size. Scaling the font by the overflow
 * ratio keeps every locale inside the same texture, so callers do not have to
 * resize geometry per language.
 *
 * `font` must be a CSS font shorthand whose size is expressed in px; anything
 * else is returned untouched.
 */
export function fitFontToWidth(
  context: CanvasRenderingContext2D,
  font: string,
  text: string,
  maxWidth: number,
): string {
  context.font = font;
  const width = context.measureText(text).width;
  if (width <= maxWidth || width === 0) return font;

  const sizeMatch = font.match(FONT_SIZE_PATTERN);
  if (!sizeMatch) return font;

  const shrunk = Math.max(8, Math.floor(Number.parseFloat(sizeMatch[1]) * (maxWidth / width)));
  return font.replace(FONT_SIZE_PATTERN, `${shrunk}px`);
}
