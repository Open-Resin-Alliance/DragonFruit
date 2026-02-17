import * as THREE from 'three';
import type { MeshSmoothingFalloff } from './settings';
import type { MeshTopology } from './topologyCache';

export type FalloffFn = (t: number) => number;

export function getFalloffFn(falloff: MeshSmoothingFalloff): FalloffFn {
  if (falloff === 'linear') {
    return (t) => Math.max(0, Math.min(1, t));
  }

  if (falloff === 'sharp') {
    return (t) => {
      const x = Math.max(0, Math.min(1, t));
      return x * x;
    };
  }

  // smooth
  return (t) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  };
}

export type SmoothingStepOptions = {
  center: THREE.Vector3;
  radius: number;
  strength: number; // 0..1
  iterations: number;
  falloff: MeshSmoothingFalloff;
  maxVertices?: number;
};

export type SmoothingScratch = {
  weights: Float32Array;
  tmp: Float32Array;
};

function limitVertices(input: Uint32Array, maxVertices: number): Uint32Array {
  if (input.length <= maxVertices) return input;
  const stride = Math.ceil(input.length / maxVertices);
  const out: number[] = [];
  for (let i = 0; i < input.length; i += stride) {
    out.push(input[i]);
  }
  return Uint32Array.from(out);
}

export function applySmoothingToTopology(
  topology: MeshTopology,
  affected: Uint32Array,
  opts: SmoothingStepOptions,
  scratch?: SmoothingScratch,
): Uint32Array {
  const maxVertices = opts.maxVertices ?? 8000;
  const ids = limitVertices(affected, maxVertices);
  if (ids.length === 0) return ids;

  const radius = Math.max(0.0001, opts.radius);
  const falloffFn = getFalloffFn(opts.falloff);

  const pos = topology.uniquePositions;
  const neighbors = topology.neighbors;

  const center = opts.center;

  // Precompute per-vertex falloff weights (stable across iterations)
  const weights = scratch && scratch.weights.length >= ids.length
    ? scratch.weights
    : new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const i3 = id * 3;
    const dx = pos[i3 + 0] - center.x;
    const dy = pos[i3 + 1] - center.y;
    const dz = pos[i3 + 2] - center.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const t = 1 - dist / radius;
    weights[i] = falloffFn(t);
  }

  // Laplacian smoothing (single pass per iteration)
  const lambda = Math.max(0, Math.min(1, opts.strength));

  const iters = Math.max(1, Math.floor(opts.iterations));

  const tmp = scratch && scratch.tmp.length >= ids.length * 3
    ? scratch.tmp
    : new Float32Array(ids.length * 3);

  const doPass = (coeff: number) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const w = weights[i];
      const k = coeff * w;
      const i3 = id * 3;

      const nbs = neighbors[id];
      if (!nbs || nbs.length === 0 || k === 0) {
        tmp[i * 3 + 0] = pos[i3 + 0];
        tmp[i * 3 + 1] = pos[i3 + 1];
        tmp[i * 3 + 2] = pos[i3 + 2];
        continue;
      }

      let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j];
        const nb3 = nb * 3;
        ax += pos[nb3 + 0];
        ay += pos[nb3 + 1];
        az += pos[nb3 + 2];
      }
      const inv = 1 / nbs.length;
      ax *= inv; ay *= inv; az *= inv;

      const px = pos[i3 + 0];
      const py = pos[i3 + 1];
      const pz = pos[i3 + 2];

      tmp[i * 3 + 0] = px + (ax - px) * k;
      tmp[i * 3 + 1] = py + (ay - py) * k;
      tmp[i * 3 + 2] = pz + (az - pz) * k;
    }

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const i3 = id * 3;
      pos[i3 + 0] = tmp[i * 3 + 0];
      pos[i3 + 1] = tmp[i * 3 + 1];
      pos[i3 + 2] = tmp[i * 3 + 2];
    }
  };

  for (let iter = 0; iter < iters; iter++) {
    doPass(lambda);
  }

  return ids;
}
