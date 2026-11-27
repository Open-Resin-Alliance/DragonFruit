import * as THREE from 'three';
import { base64ToBytes, bytesToBase64 } from '@/utils/base64';

/** Capture a geometry's position buffer as a base64 snapshot (for history/undo). */
export function snapshotGeometryPositions(geometry: THREE.BufferGeometry): {
  sourcePositionsBase64: string;
  sourcePositionCount: number;
} {
  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) {
    throw new Error('Geometry has no position attribute.');
  }

  const floatArray = position.array instanceof Float32Array
    ? position.array
    : new Float32Array(position.array);
  const bytes = new Uint8Array(
    floatArray.buffer,
    floatArray.byteOffset,
    floatArray.byteLength,
  );

  return {
    sourcePositionsBase64: bytesToBase64(bytes),
    sourcePositionCount: position.count,
  };
}

/** Rebuild a BufferGeometry from a base64 position snapshot. Returns null if invalid. */
export function geometryFromSnapshot(snapshot: {
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
}): THREE.BufferGeometry | null {
  const base64 = snapshot.sourcePositionsBase64;
  const count = snapshot.sourcePositionCount;
  if (!base64 || !Number.isFinite(count) || (count as number) <= 0) {
    return null;
  }

  const bytes = base64ToBytes(base64);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }

  const view = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const positions = new Float32Array(view.length);
  positions.set(view);

  if (positions.length !== (count as number) * 3) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
