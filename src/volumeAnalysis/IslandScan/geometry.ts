export interface Pt2 { x: number; y: number }

export function boundsOfLoops(loops: Pt2[][]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  return { minX, maxX, minY, maxY };
}
