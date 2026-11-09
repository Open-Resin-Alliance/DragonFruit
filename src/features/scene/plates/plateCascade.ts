/**
 * Where each build plate sits in the cascade.
 *
 * Plates fill a grid that reads left to right, top to bottom: 1 2 3 / 4 5 6 / 7 8 9.
 * Two orderings share that grid and differ in how its width is decided.
 *
 * **Fixed** (the default, three to a row) holds the width at a column count the user
 * sets and never re-lays: plate n's cell follows from n alone, so adding a plate
 * leaves every other plate, and every model on it, exactly where it was.
 *
 * **Dynamic** grows the grid a column, then a row, then a column — 1x1, 2x1, 2x2,
 * 3x2, 3x3 — so it stays as square as it can without ever leaving a hole:
 *
 * ```
 * col:  0 1 2 3
 * row0: 1 2 3 10
 * row1: 4 5 6 11
 * row2: 7 8 9 12
 * ```
 *
 * Because that grid is numbered by position, adding a plate can re-lay the ones
 * already placed — plate 3 sits below plate 1 while there are four plates, and moves
 * up beside plate 2 once there are five. `useSceneCollectionManager` moves the models
 * with their beds when that happens; nothing else needs to know.
 *
 * The first plate is always the origin, so a single-plate scene is exactly where it
 * always was.
 */

/** Distance between two plates' build volumes, on top of the plate footprint. */
export const PLATE_CASCADE_GAP_MM = 24;

/** How many columns a fixed grid holds when nothing else is asked for. */
export const DEFAULT_FIXED_PLATE_COLUMNS = 3;

/** The widest fixed grid the setting will take, so a scene stays a scene. */
export const MAX_FIXED_PLATE_COLUMNS = 12;

/**
 * Which grid the plates are laid out on. `columns` is read by `fixed` alone; dynamic
 * decides its own width from the plate count.
 */
export type PlateOrdering = { mode: 'dynamic' | 'fixed'; columns: number };

/** The dynamic grid: as square as it can be, grown a column then a row at a time. */
export const DYNAMIC_PLATE_ORDERING: PlateOrdering = { mode: 'dynamic', columns: DEFAULT_FIXED_PLATE_COLUMNS };

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
export function plateCascadeCell(
  index: number,
  plateCount: number,
  ordering: PlateOrdering,
): PlateCascadeCell {
  if (index <= 0) return { col: 0, row: 0 };

  // Fixed: the cell follows from the plate's own number, so the count is not read
  // and one more plate cannot move the rest.
  if (ordering.mode === 'fixed') {
    const columns = fixedPlateColumns(ordering.columns);
    return { col: index % columns, row: Math.floor(index / columns) };
  }

  const { width } = cascadeBlockFor(Math.max(plateCount, index + 1));

  return { col: index % width, row: Math.floor(index / width) };
}

/** The column count a fixed grid uses, bounded and whole whatever it was given. */
export function fixedPlateColumns(columns: number): number {
  if (!Number.isFinite(columns)) return DEFAULT_FIXED_PLATE_COLUMNS;
  return Math.max(1, Math.min(MAX_FIXED_PLATE_COLUMNS, Math.round(columns)));
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
  ordering: PlateOrdering,
): { dxMm: number; dyMm: number } {
  const { col, row } = plateCascadeCell(index, plateCount, ordering);
  return {
    dxMm: col * (footprint.widthMm + PLATE_CASCADE_GAP_MM),
    dyMm: row * (footprint.depthMm + PLATE_CASCADE_GAP_MM),
  };
}

/**
 * Where a saved scene records the grid its beds were laid out on.
 *
 * The beds are laid out from the index and the build volume alone, so a file that does
 * not say which grid it was written with cannot be re-opened onto the beds its models
 * were placed on: switch the ordering and every bed but the first moves out from under
 * them. The printer bundle is recorded for the same reason, and the two are the same
 * kind of fact about the file.
 */
export const VOXL_PLATE_ORDERING_EXTENSION = 'plateOrdering';

/**
 * Read that extension back. Anything unrecognised reads as null, which is what a file
 * written before the ordering existed looks like: its beds were laid out dynamically,
 * because that was the only grid there was.
 */
export function readPlateOrdering(value: unknown): PlateOrdering | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { mode?: unknown; columns?: unknown };
  if (candidate.mode !== 'dynamic' && candidate.mode !== 'fixed') return null;
  return {
    mode: candidate.mode,
    columns: fixedPlateColumns(
      typeof candidate.columns === 'number' ? candidate.columns : DEFAULT_FIXED_PLATE_COLUMNS,
    ),
  };
}
