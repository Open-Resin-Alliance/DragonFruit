/**
 * Where a 500k-triangle import's post-processing time goes.
 *
 * Reproduces the phase split the app logs during import, isolated from the
 * native/IPC/STL-decode work so a "why is import slow" question is answered by
 * numbers instead of guesswork. Run: `npm run bench:import-postprocess`.
 *
 * Measured 2026-09-14 on a 500k-triangle non-indexed soup (~1.5M vertices):
 *
 *   computeVertexNormals             43 ms
 *   computeBoundingBox               13 ms
 *   flattening planes                98 ms
 *   EdgesGeometry(30) [overlay]    2139 ms   <- 93% of the total
 *
 * The overlay geometry was built for every imported model whether or not the
 * (default-off) Higher Contrast Model Edges setting was enabled; it is now
 * gated on that setting by `buildModelEdgeGeometry`. See `docs/dev/backlog.md`
 * for what remains on the import path.
 */
import * as THREE from 'three';

import { accelerateGeometry } from '../src/utils/bvh';
import { computeFlatteningPlanes } from '../src/features/placeOnFace/logic/computeFlatteningPlanes';

/** A non-indexed triangle soup, like the native classify/repair output. */
function buildTriangleSoup(targetTriangles: number): THREE.BufferGeometry {
  // Two triangles per grid quad.
  const gridSize = Math.max(2, Math.round(Math.sqrt(targetTriangles / 2)));
  const quads = gridSize * gridSize;
  const triangles = quads * 2;
  const positions = new Float32Array(triangles * 9);

  let cursor = 0;
  for (let i = 0; i < gridSize; i += 1) {
    for (let j = 0; j < gridSize; j += 1) {
      const x0 = i * 0.5;
      const y0 = j * 0.5;
      const x1 = x0 + 0.5;
      const y1 = y0 + 0.5;
      // A wavy surface, so the convex hull and bbox work are representative.
      const za = Math.sin(x0 * 0.05) * Math.cos(y0 * 0.05) * 5;
      const zb = Math.sin(x1 * 0.05) * Math.cos(y0 * 0.05) * 5;
      const zc = Math.sin(x1 * 0.05) * Math.cos(y1 * 0.05) * 5;
      const zd = Math.sin(x0 * 0.05) * Math.cos(y1 * 0.05) * 5;
      const a = [x0, y0, za];
      const b = [x1, y0, zb];
      const c = [x1, y1, zc];
      const d = [x0, y1, zd];
      // Coplanar split, wound consistently around +Z.
      positions.set([...a, ...b, ...c], cursor); cursor += 9;
      positions.set([...a, ...c, ...d], cursor); cursor += 9;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function timePhase(label: string, fn: () => void): number {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label.padEnd(28)} ${elapsed.toFixed(0).padStart(6)} ms`);
  return elapsed;
}

const targetTriangles = Number(process.argv[2] ?? 500_000);
const geometry = buildTriangleSoup(targetTriangles);
const triangleCount = geometry.getAttribute('position').count / 3;
console.log(`\n${triangleCount.toLocaleString()} triangles, non-indexed soup\n`);

let total = 0;
total += timePhase('computeVertexNormals', () => geometry.computeVertexNormals());
total += timePhase('computeBoundingBox', () => geometry.computeBoundingBox());
total += timePhase('BVH (accelerateGeometry)', () => accelerateGeometry(geometry));
total += timePhase('flattening planes', () => computeFlatteningPlanes(geometry));
const overlayMs = timePhase('EdgesGeometry(30) [overlay]', () => {
  new THREE.EdgesGeometry(geometry, 30).dispose();
});
total += overlayMs;

console.log(`  ${'TOTAL'.padEnd(28)} ${total.toFixed(0).padStart(6)} ms`);
console.log(
  `\nThe edge overlay is ${Math.round((overlayMs / total) * 100)}% of the total. It is off by\n` +
  'default and is built only when the Higher Contrast Model Edges setting is on\n' +
  '(buildModelEdgeGeometry), so this row is skipped entirely in the default\n' +
  'configuration.\n',
);
