import { type Labels, type ComponentInfo } from './types';

export function labelComponents(maskData: Uint8Array, width: number, height: number, connectivity: 4 | 8 = 4): { labels: Labels; components: ComponentInfo[] } {
  const labelsArr = new Int32Array(width * height);
  let nextId = 1;
  const components: ComponentInfo[] = [];
  const qx = new Int32Array(width * height);
  const qy = new Int32Array(width * height);
  const dirs4 = [ [1,0], [-1,0], [0,1], [0,-1] ] as const;
  const dirs8 = [ [1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1] ] as const;
  const dirs = connectivity === 8 ? dirs8 : dirs4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!maskData[idx] || labelsArr[idx] !== 0) continue;
      let head = 0, tail = 0, area = 0;
      qx[tail] = x; qy[tail] = y; tail++;
      labelsArr[idx] = nextId;
      while (head < tail) {
        const cx = qx[head]; const cy = qy[head]; head++;
        area++;
        for (const d of dirs) {
          const nx = cx + d[0]; const ny = cy + d[1];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nidx = ny * width + nx;
          if (!maskData[nidx] || labelsArr[nidx] !== 0) continue;
          labelsArr[nidx] = nextId;
          qx[tail] = nx; qy[tail] = ny; tail++;
        }
      }
      components.push({ id: nextId, label: nextId, area_px: area, size: area });
      nextId++;
    }
  }
  return { labels: { data: labelsArr, width, height }, components };
}
