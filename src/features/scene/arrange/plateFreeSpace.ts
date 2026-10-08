/**
 * The room a bed still has, given what is already standing on it.
 *
 * A bed that is carrying models can still take more — that is the whole point of an
 * arrange that fills the beds the scene already has before it makes new ones. The row
 * packer places into a rectangle and knows nothing about what is on the bed, and the
 * high-precision packer is handed a rectangle too, so the free space is worked out here
 * and offered to them one rectangle at a time.
 *
 * The split is guillotine-style: every occupied rectangle cuts the free rectangles it
 * overlaps into the strips beside it, above it and below it. That keeps the result a
 * small, non-overlapping set that covers exactly what the models do not, and it is
 * cheap enough to run per bed on every arrange.
 */

export type PlateRect = { minX: number; maxX: number; minY: number; maxY: number };

/** A rectangle's area, zero when it is inverted or empty. */
function rectArea(rect: PlateRect): number {
  return Math.max(0, rect.maxX - rect.minX) * Math.max(0, rect.maxY - rect.minY);
}

function rectsOverlap(a: PlateRect, b: PlateRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function isUsable(rect: PlateRect, minSideMm: number): boolean {
  return (rect.maxX - rect.minX) >= minSideMm && (rect.maxY - rect.minY) >= minSideMm;
}

/**
 * The free rectangles of `plate` once `occupied` is taken out of it, largest first.
 *
 * `gapMm` widens every occupied rectangle by half on each side, so the packer's own
 * spacing still separates a new model from one already on the bed instead of letting
 * them touch. A negative gap (models are allowed to nest) does not narrow them.
 *
 * `minSideMm` drops slivers too small to hold anything, and `maxRects` caps how many are
 * handed back — a crowded bed would otherwise split into hundreds of thin strips, and the
 * packer is better off trying the biggest few and moving to the next bed.
 */
export function freeRectsForPlate(
  plate: PlateRect,
  occupied: readonly PlateRect[],
  options?: { gapMm?: number; minSideMm?: number; maxRects?: number },
): PlateRect[] {
  const halfGap = Math.max(0, options?.gapMm ?? 0) * 0.5;
  const minSideMm = Math.max(0, options?.minSideMm ?? 1);
  const maxRects = Math.max(1, Math.round(options?.maxRects ?? 24));

  let free: PlateRect[] = [plate];

  for (const blocker of occupied) {
    const inflated: PlateRect = {
      minX: blocker.minX - halfGap,
      maxX: blocker.maxX + halfGap,
      minY: blocker.minY - halfGap,
      maxY: blocker.maxY + halfGap,
    };

    const next: PlateRect[] = [];
    for (const rect of free) {
      if (!rectsOverlap(rect, inflated)) {
        next.push(rect);
        continue;
      }

      // The strips around the blocker, clipped to this free rectangle. They do not
      // overlap each other, and the blocker itself is the hole between them.
      const clipMinX = Math.max(rect.minX, inflated.minX);
      const clipMaxX = Math.min(rect.maxX, inflated.maxX);

      if (inflated.minX > rect.minX) {
        next.push({ minX: rect.minX, maxX: Math.min(rect.maxX, inflated.minX), minY: rect.minY, maxY: rect.maxY });
      }
      if (inflated.maxX < rect.maxX) {
        next.push({ minX: Math.max(rect.minX, inflated.maxX), maxX: rect.maxX, minY: rect.minY, maxY: rect.maxY });
      }
      if (inflated.minY > rect.minY) {
        next.push({ minX: clipMinX, maxX: clipMaxX, minY: rect.minY, maxY: Math.min(rect.maxY, inflated.minY) });
      }
      if (inflated.maxY < rect.maxY) {
        next.push({ minX: clipMinX, maxX: clipMaxX, minY: Math.max(rect.minY, inflated.maxY), maxY: rect.maxY });
      }
    }
    free = next;
  }

  return free
    .filter((rect) => isUsable(rect, minSideMm))
    .sort((a, b) => rectArea(b) - rectArea(a))
    .slice(0, maxRects);
}
