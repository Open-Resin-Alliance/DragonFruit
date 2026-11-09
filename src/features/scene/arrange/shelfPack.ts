/**
 * Shelf packing: items in rows, with whatever the bed cannot take handed back so
 * the caller can offer it the next one. Items are rectangles, so the cost does not
 * follow the mesh -- the Arrange tool is where a hull-accurate nesting is asked for.
 */

export type ShelfItem = {
  id: string;
  /** Footprint as it stands, in mm. */
  width: number;
  depth: number;
  /** Footprint turned a quarter, when the caller allows it. */
  turnedWidth?: number;
  turnedDepth?: number;
};

export type ShelfPlacement = {
  id: string;
  /** Centre of the item within the bed, in the bed's own millimetres. */
  x: number;
  y: number;
  /** Whether the item was laid out on its turned footprint. */
  turned: boolean;
};

export type ShelfPackResult = {
  placed: ShelfPlacement[];
  /** What the bed could not take, in the order it was offered. */
  spilled: string[];
};

export type ShelfPackOptions = {
  widthMm: number;
  depthMm: number;
  spacingMm: number;
  /** May an item be laid out on its turned footprint to fit. */
  allowTurn?: boolean;
};

type Row = { items: Array<{ item: ShelfItem; w: number; d: number; turned: boolean }>; widthUsed: number; maxDepth: number };

/** Largest first, so a big item is not locked out by small ones taking the middle. */
export function shelfPack(items: readonly ShelfItem[], options: ShelfPackOptions): ShelfPackResult {
  const { widthMm, depthMm, spacingMm } = options;
  const allowTurn = options.allowTurn ?? true;
  if (items.length === 0) return { placed: [], spilled: [] };

  const ordered = [...items].sort((a, b) => {
    const areaDelta = (b.width * b.depth) - (a.width * a.depth);
    if (Math.abs(areaDelta) > 1e-9) return areaDelta;
    return b.id < a.id ? 1 : -1;
  });

  const rows: Row[] = [];
  const spilled: string[] = [];
  let depthUsed = 0;

  for (const item of ordered) {
    const poses: Array<{ w: number; d: number; turned: boolean }> = [
      { w: item.width, d: item.depth, turned: false },
    ];
    if (allowTurn) {
      const tw = item.turnedWidth ?? item.depth;
      const td = item.turnedDepth ?? item.width;
      if (Math.abs(tw - item.width) > 1e-9 || Math.abs(td - item.depth) > 1e-9) {
        poses.push({ w: tw, d: td, turned: true });
      }
    }

    const fits = poses.filter((pose) => pose.w <= widthMm && pose.d <= depthMm);
    if (fits.length === 0) {
      spilled.push(item.id);
      continue;
    }

    let best: { row: Row | null; pose: { w: number; d: number; turned: boolean }; score: number } | null = null;

    for (const pose of fits) {
      // An existing row, where the item costs only the width it adds.
      for (const row of rows) {
        const nextWidth = row.widthUsed + (row.items.length > 0 ? spacingMm : 0) + pose.w;
        if (nextWidth > widthMm) continue;
        const grow = Math.max(0, pose.d - row.maxDepth);
        if (depthUsed + grow > depthMm) continue;
        // Growing a row costs more than filling one, so prefer the tighter fit.
        const score = (grow * 10) + pose.w;
        if (!best || score < best.score) best = { row, pose, score };
      }

      // Or a new row, which costs its full depth.
      const newRowDepth = depthUsed + (rows.length > 0 ? spacingMm : 0) + pose.d;
      if (newRowDepth <= depthMm) {
        const score = (pose.d * 10) + pose.w + 1;
        if (!best || score < best.score) best = { row: null, pose, score };
      }
    }

    if (!best) {
      spilled.push(item.id);
      continue;
    }

    if (best.row) {
      const row = best.row;
      const grow = Math.max(0, best.pose.d - row.maxDepth);
      row.widthUsed += (row.items.length > 0 ? spacingMm : 0) + best.pose.w;
      row.maxDepth += grow;
      depthUsed += grow;
      row.items.push({ item, w: best.pose.w, d: best.pose.d, turned: best.pose.turned });
    } else {
      depthUsed += (rows.length > 0 ? spacingMm : 0) + best.pose.d;
      rows.push({
        items: [{ item, w: best.pose.w, d: best.pose.d, turned: best.pose.turned }],
        widthUsed: best.pose.w,
        maxDepth: best.pose.d,
      });
    }
  }

  // The block the rows fill, centred on the bed.
  const blockWidth = rows.reduce((widest, row) => Math.max(widest, row.widthUsed), 0);
  const blockDepth = rows.reduce((total, row) => total + row.maxDepth, 0)
    + Math.max(0, rows.length - 1) * spacingMm;
  const originX = (widthMm - blockWidth) * 0.5;
  const originY = (depthMm - blockDepth) * 0.5;

  const placed: ShelfPlacement[] = [];
  let cursorY = originY;
  for (const row of rows) {
    let cursorX = originX;
    for (const entry of row.items) {
      placed.push({
        id: entry.item.id,
        x: cursorX + (entry.w * 0.5),
        y: cursorY + (row.maxDepth * 0.5),
        turned: entry.turned,
      });
      cursorX += entry.w + spacingMm;
    }
    cursorY += row.maxDepth + spacingMm;
  }

  return { placed, spilled };
}
