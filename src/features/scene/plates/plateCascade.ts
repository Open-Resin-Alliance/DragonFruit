/**
 * Where each build plate sits in the cascade.
 *
 * Plates fill a grid that reads left to right, top to bottom: 1 2 3 / 4 5 6 / 7 8 9.
 * The grid grows a column, then a row, then a column — 1x1, 2x1, 2x2, 3x2, 3x3 — so
 * it stays as square as it can without ever leaving a hole:
 *
 * ```
 * col:  0 1 2 3
 * row0: 1 2 3 10
 * row1: 4 5 6 11
 * row2: 7 8 9 12
 * ```
 *
 * Because the grid is numbered by position, adding a plate can re-lay the ones
 * already placed — plate 3 sits below plate 1 while there are four plates, and moves
 * up beside plate 2 once there are five. `useSceneCollectionManager` moves the models
 * with their beds when that happens; nothing else needs to know.
 *
 * The first plate is always the origin, so a single-plate scene is exactly where it
 * always was.
 */

/** Distance between two plates' build volumes, on top of the plate footprint. */
export const PLATE_CASCADE_GAP_MM = 24;

export type PlateCascadeCell = { col: number; row: number };

/**
 * The block of cells that holds `count` plates, grown a column then a row at a time.
 * Its width is what decides where a plate sits, because the plates are numbered by
 * position rather than by the order the grid grew.
 */
function cascadeBlockFor(count: number): { width: number; height: number } {
  let width = 1;
  let height = 1;
  let placed = 1; // the first plate
  let openingColumn = true;

  while (placed < count) {
    placed += openingColumn ? height : width;
    if (openingColumn) width += 1;
    else height += 1;
    openingColumn = !openingColumn;
  }

  return { width, height };
}

/**
 * Grid cell of the plate at `index`, where index 0 is the first plate, in a scene of
 * `plateCount` plates. The count matters: it is the block the whole grid is numbered
 * against, which is why adding a plate can move the ones already there.
 */
export function plateCascadeCell(index: number, plateCount: number): PlateCascadeCell {
  if (index <= 0) return { col: 0, row: 0 };

  const { width } = cascadeBlockFor(Math.max(plateCount, index + 1));

  return { col: index % width, row: Math.floor(index / width) };
}

/**
 * The offset in millimetres from the first plate's frame to the plate at `index`.
 * Add it to any plate-local coordinate to get the world coordinate, so every
 * computation that already works inside one plate keeps working unchanged and only
 * the drawing and picking need the offset.
 *
 * Plates are pitched apart by their own footprint plus a gap, so the build volumes
 * and their margins never touch.
 */
export function plateCascadeOffsetMm(
  index: number,
  footprint: { widthMm: number; depthMm: number },
  plateCount: number,
): { dxMm: number; dyMm: number } {
  const { col, row } = plateCascadeCell(index, plateCount);
  return {
    dxMm: col * (footprint.widthMm + PLATE_CASCADE_GAP_MM),
    dyMm: row * (footprint.depthMm + PLATE_CASCADE_GAP_MM),
  };
}
