/**
 * Off-thread geometry baking worker for mirror operations.
 *
 * Receives typed-array views of position / normal / index data together with
 * the list of world axes to flip (0=X, 1=Y, 2=Z). Each axis is applied in
 * order, matching the sequential behaviour of bakeMirrorIntoGeometry:
 *   • Negate the relevant component in every position vector.
 *   • Swap the winding order of every triangle (to preserve front-face).
 *   • Negate the relevant component in every normal vector.
 *
 * All incoming arrays were transferred (zero-copy) from the main thread.
 * The modified arrays are transferred back the same way.
 */

import { swapTriangleCorners } from '../logic/swapTriangleCorners';

type BakeRequest = {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  posItemSize: number;
  normItemSize: number;
  /** Axis indices to bake in order, e.g. [0] for X, [0,1] for X then Y. */
  axes: number[];
};

type BakeResponse = {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
};

self.onmessage = (e: MessageEvent<BakeRequest>) => {
  const { positions, normals, indices, posItemSize, normItemSize, axes } = e.data;

  for (const axisIndex of axes) {
    // 1. Negate positions along this axis.
    for (let i = axisIndex; i < positions.length; i += posItemSize) {
      positions[i] = -positions[i];
    }

    // 2. Swap triangle winding order to preserve front-face orientation.
    if (indices) {
      const len = indices.length;
      for (let i = 0; i + 2 < len; i += 3) {
        const tmp = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = tmp;
      }
    } else {
      // Non-indexed geometry: swap corners 1 and 2 of each triangle inline, in the
      // normals too, or every normal lands on a corner it was not computed for.
      swapTriangleCorners(positions, posItemSize);
      if (normals) swapTriangleCorners(normals, normItemSize);
    }

    // 3. Negate normals along this axis.
    if (normals) {
      for (let i = axisIndex; i < normals.length; i += normItemSize) {
        normals[i] = -normals[i];
      }
    }
  }

  const response: BakeResponse = { positions, normals, indices };
  const transferables: Transferable[] = [positions.buffer];
  if (normals) transferables.push(normals.buffer);
  if (indices) transferables.push(indices.buffer);

  (self as unknown as Worker).postMessage(response, transferables);
};
