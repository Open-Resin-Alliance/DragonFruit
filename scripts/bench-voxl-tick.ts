/**
 * Ph0.1 sub-phase C + E perf gate: the steady-state autosave tick.
 *
 * Reproduces the COW design's §1.4 corpus so the numbers stay comparable:
 * synthetic binary STL at `84 + 50 x tri` with realistic float entropy
 * (displaced-sphere tessellation — a zero-filled buffer compresses absurdly well
 * and would understate the result), through the app's own fflate at zlib level 6
 * plus SHA-256.
 *
 * Reports, for a 3 x 4M-tri plate:
 *   - the one-time bake cost (paid on the operation the user is waiting for);
 *   - the steady-state tick with BUFFERED assembly (post-C, pre-E);
 *   - the steady-state tick with STREAMING assembly (post-E), plus the largest
 *     contiguous allocation each path makes.
 *
 * Run: `npm run bench:voxl-tick`
 */
import { performance } from 'node:perf_hooks';
import {
  serializeVoxlDocumentV2,
  serializeVoxlDocumentV2Streaming,
  resetVoxlCodecStats,
  voxlCodecStats,
} from '@/features/scene/voxl/codec-v2';
import { MeshChunkStore } from '@/features/scene/voxl/meshChunkStore';
import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '@/features/scene/voxl/types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS = { version: 1, meta: { source: 'bench', objectCenter: { x: 0, y: 0, z: 0 } }, roots: [] } as unknown as DragonfruitImportFormat;

function stl(triangles: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * triangles);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0xffffffff; };
  let off = 84;
  for (let t = 0; t < triangles; t += 1) {
    const theta = (t / triangles) * Math.PI * 2 * 137.5;
    const phi = Math.acos(1 - (2 * (t % 4096)) / 4096);
    const r = 30 + Math.sin(theta * 7) * 2 + rnd() * 0.35;
    for (let v = 0; v < 4; v += 1) {
      const dt = v * 0.0021 + rnd() * 0.0009;
      view.setFloat32(off, r * Math.sin(phi + dt) * Math.cos(theta + dt), true);
      view.setFloat32(off + 4, r * Math.sin(phi + dt) * Math.sin(theta + dt), true);
      view.setFloat32(off + 8, r * Math.cos(phi + dt), true);
      off += 12;
    }
    off += 2;
  }
  return bytes;
}

function model(id: string): VoxlModelRuntimeLike {
  return { id, name: id, visible: true, color: '#fff', polygonCount: 4000000,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    mesh: { mode: 'embedded-file', fileName: id + '.stl', mimeType: 'model/stl' } };
}

async function main() {
  const TRI = Number(process.env.TRI ?? 4000000);
  const ids = ['m0', 'm1', 'm2'];
  const meshes = ids.map((_, i) => stl(TRI, i + 1));

  const store = new MeshChunkStore();
  const sha = new Map<number, string>();
  const precompressed = new Map<number, { data: Uint8Array; compression: number; uncompressedSize: number }>();

  const bakeStart = performance.now();
  for (let i = 0; i < meshes.length; i += 1) {
    const baked = await store.bake({ modelId: ids[i], signature: 'geo-' + i, encode: () => meshes[i] });
    sha.set(i, baked.sha256);
    precompressed.set(i, { data: baked.data, compression: baked.compression, uncompressedSize: baked.uncompressedSize });
  }
  console.log('bake total (paid ONCE, at finalization): ' + (performance.now() - bakeStart).toFixed(0) + ' ms');

  const input: BuildVoxlDocumentInput = { models: ids.map(model), activeModelId: 'm0', selectedModelIds: [], supports: EMPTY_SUPPORTS };

  resetVoxlCodecStats();
  let t0 = performance.now();
  const buffered = await serializeVoxlDocumentV2(input, new Map(), sha, { precompressed });
  console.log('\nsteady-state tick, BUFFERED assembly: ' + (performance.now() - t0).toFixed(1) + ' ms');
  console.log('  mesh compressions ' + voxlCodecStats.meshChunkCompressions + ', json ' + voxlCodecStats.jsonChunkCompressions);
  console.log('  largest contiguous allocation: ' + (voxlCodecStats.largestContiguousAllocation / 2 ** 20).toFixed(0) + ' MiB');

  resetVoxlCodecStats();
  let emitted = 0; let largest = 0;
  t0 = performance.now();
  const streamed = await serializeVoxlDocumentV2Streaming(input, new Map(), sha, (b) => { emitted += b.length; largest = Math.max(largest, b.length); }, { precompressed });
  console.log('\nsteady-state tick, STREAMING assembly: ' + (performance.now() - t0).toFixed(1) + ' ms');
  console.log('  mesh compressions ' + voxlCodecStats.meshChunkCompressions + ', json ' + voxlCodecStats.jsonChunkCompressions);
  console.log('  largest contiguous allocation: ' + (voxlCodecStats.largestContiguousAllocation / 2 ** 20).toFixed(0) + ' MiB');
  console.log('  document ' + (streamed.totalSize / 2 ** 20).toFixed(0) + ' MiB, largest single emission ' + (largest / 2 ** 20).toFixed(0) + ' MiB');
  console.log('  byte count matches buffered: ' + (emitted === buffered.length));
}

void main();
