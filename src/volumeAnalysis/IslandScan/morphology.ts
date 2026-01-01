import { type Mask } from './types';

export function dilate(mask: Mask, radiusPx: number): Mask {
  const { width, height } = mask;
  const out = new Uint8Array(width * height);
  const r = Math.max(0, Math.round(radiusPx));
  const r2 = r * r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 0;
      for (let dy = -r; dy <= r && val === 0; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r && val === 0; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          if (dx*dx + dy*dy > r2) continue;
          if (mask.data[yy * width + xx]) { val = 1; break; }
        }
      }
      out[y * width + x] = val;
    }
  }
  return { ...mask, data: out };
}
