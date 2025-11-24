import { type Mask } from './types';
import { type Pt2, boundsOfLoops } from './geometry';

function pointInPolygon(x: number, y: number, loop: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i].x, yi = loop[i].y;
    const xj = loop[j].x, yj = loop[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function rasterizeLoopsToExistingGrid(loops: Pt2[][], ref: Mask): Mask {
  const { width, height, originX, originZ, px_mm } = ref;
  const data = new Uint8Array(width * height);
  const startX = originX - px_mm * 0.5;
  const startY = originZ - px_mm * 0.5; // note: our Mask.originZ corresponds to Vector2.y
  for (let row = 0; row < height; row++) {
    const y = startY + row * px_mm + px_mm * 0.5;
    for (let col = 0; col < width; col++) {
      const x = startX + col * px_mm + px_mm * 0.5;
      let inside = false;
      for (const loop of loops) {
        if (pointInPolygon(x, y, loop)) { inside = true; break; }
      }
      data[row * width + col] = inside ? 1 : 0;
    }
  }
  return { data, width, height, originX, originZ, px_mm };
}

export function rasterizeLoopsToMask(loops: Pt2[][], px_mm: number, paddingMm = 0): Mask {
  const b = boundsOfLoops(loops);
  const minX = b.minX - paddingMm;
  const maxX = b.maxX + paddingMm;
  const minY = b.minY - paddingMm;
  const maxY = b.maxY + paddingMm;
  const width = Math.max(1, Math.ceil((maxX - minX) / px_mm));
  const height = Math.max(1, Math.ceil((maxY - minY) / px_mm));
  const data = new Uint8Array(width * height);
  const originX = minX + px_mm * 0.5;
  const originY = minY + px_mm * 0.5;
  for (let row = 0; row < height; row++) {
    const y = originY + row * px_mm;
    for (let col = 0; col < width; col++) {
      const x = originX + col * px_mm;
      let inside = false;
      for (const loop of loops) {
        if (pointInPolygon(x, y, loop)) { inside = true; break; }
      }
      data[row * width + col] = inside ? 1 : 0;
    }
  }
  return { data, width, height, originX, originZ: originY, px_mm };
}
