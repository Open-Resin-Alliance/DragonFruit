/**
 * Where each build plate sits in the cascade.
 *
 * The first plate is the origin and the rest spiral out around it: one step
 * right, one down, two left, two up, three right, three down, and so on. In grid
 * cells that reads
 *
 * ```
 * col:  0 1 2
 * row0: 7 6 5
 * row1: 8 1 2
 * row2: 9 4 3
 * ```
 *
 * so a plate never lands on another plate's cell and the first few grow outwards
 * in the order a person adding plates would expect.
 */

/** Minimum distance between two plates' build volumes. */
export const PLATE_CASCADE_GAP_MM = 20;

/**
 * How much of a plate's width is left clear to its right for the widget column
 * that hangs off its edge. The widgets are sized in CSS pixels and scaled with
 * the plate, so their footprint is a fraction of the plate rather than a fixed
 * number of millimetres; a constant gap puts the next plate underneath them.
 */
export const PLATE_WIDGET_STRIP_FRACTION = 0.25;

export type PlateCascadeCell = { col: number; row: number };

/** Grid cell of the plate at `index`, where index 0 is the first plate. */
export function plateCascadeCell(index: number): PlateCascadeCell {
  if (index <= 0) return { col: 0, row: 0 };

  // Square spiral legs: right, down, left, up, with the length growing every
  // second leg (1, 1, 2, 2, 3, 3, ...).
  const legs = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 },
  ];

  let col = 0;
  let row = 0;
  let remaining = index;
  let leg = 0;
  let length = 1;

  while (remaining > 0) {
    const { dx, dy } = legs[leg % 4];
    const step = Math.min(length, remaining);
    col += dx * step;
    row += dy * step;
    remaining -= step;
    leg += 1;
    if (leg % 2 === 0) length += 1;
  }

  return { col, row };
}

/**
 * The offset in millimetres from the first plate's frame to the plate at
 * `index`. Add it to any plate-local coordinate to get the world coordinate, so
 * every computation that already works inside one plate keeps working unchanged
 * and only the drawing and picking need the offset.
 *
 * Plates are pitched apart by their own footprint plus a gap, so the build
 * volumes and their margins never touch.
 */
export function plateCascadeOffsetMm(
  index: number,
  footprint: { widthMm: number; depthMm: number },
): { dxMm: number; dyMm: number } {
  const { col, row } = plateCascadeCell(index);
  // Columns are pitched far enough apart that a plate's widget column lands in
  // the gap rather than on the next plate; rows only need the plain gap, since
  // nothing hangs off a plate's front or back edge.
  const columnPitch = footprint.widthMm + Math.max(
    PLATE_CASCADE_GAP_MM,
    footprint.widthMm * PLATE_WIDGET_STRIP_FRACTION,
  );
  return {
    dxMm: col * columnPitch,
    dyMm: row * (footprint.depthMm + PLATE_CASCADE_GAP_MM),
  };
}
