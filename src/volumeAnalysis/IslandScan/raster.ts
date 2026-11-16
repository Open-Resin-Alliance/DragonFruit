import { type Mask } from './types';
import { type Pt2, boundsOfLoops } from './geometry';

function isLeft(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (px - ax) * (by - ay);
}

function loopWindingContribution(x: number, y: number, loop: Pt2[]): number {
  const len = loop.length;
  if (len < 3) return 0;
  let wn = 0;
  for (let i = 0; i < len; i++) {
    const p1 = loop[i];
    const p2 = loop[(i + 1) % len];
    if (p1.y <= y) {
      if (p2.y > y && isLeft(p1.x, p1.y, p2.x, p2.y, x, y) > 0) {
        wn += 1;
      }
    } else {
      if (p2.y <= y && isLeft(p1.x, p1.y, p2.x, p2.y, x, y) < 0) {
        wn -= 1;
      }
    }
  }
  return wn;
}

export function rasterizeLoopsToExistingGrid(loops: Pt2[][], ref: Mask): Mask {
  const { width, height, originX, originZ, px_mm } = ref;
  const data = new Uint8Array(width * height);
  if (width <= 0 || height <= 0 || px_mm <= 0 || loops.length === 0) {
    return { data, width, height, originX, originZ, px_mm };
  }
  for (let row = 0; row < height; row++) {
    const y = originZ + (row + 0.5) * px_mm;
    const rowOffset = row * width;
    for (let col = 0; col < width; col++) {
      const x = originX + (col + 0.5) * px_mm;
      let winding = 0;
      for (let li = 0; li < loops.length; li++) {
        winding += loopWindingContribution(x, y, loops[li]);
      }
      data[rowOffset + col] = winding !== 0 ? 1 : 0;
    }
  }
  return { data, width, height, originX, originZ, px_mm };
}

export function rasterizeLoopsToMask(loops: Pt2[][], px_mm: number, paddingMm = 0): Mask {
  if (loops.length === 0) {
    return { data: new Uint8Array(1), width: 1, height: 1, originX: 0, originZ: 0, px_mm };
  }
  const b = boundsOfLoops(loops);
  const minX = b.minX - paddingMm;
  const maxX = b.maxX + paddingMm;
  const minY = b.minY - paddingMm;
  const maxY = b.maxY + paddingMm;
  const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
  const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));
  return rasterizeLoopsToExistingGrid(loops, {
    data: new Uint8Array(width * height),
    width,
    height,
    originX: minX,
    originZ: minY,
    px_mm,
  });
}
