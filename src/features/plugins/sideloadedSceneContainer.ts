import * as THREE from 'three';

/**
 * Reads the v1 scene container a sideloaded importer writes.
 *
 * The format exists because the compiled-in import handlers return live three.js
 * geometry (they run in the webview), while a plugin is a separate process and
 * can only send bytes. Layout, little-endian throughout:
 *
 * ```text
 * "DFIMPORT1"           9 bytes
 * u32  modelCount
 * per model:
 *   u32  metaLen
 *   utf8 meta            { modelId, name?, transform: 16 floats (column major),
 *                          positionCount, indexCount, hasNormals }
 *   f32  positions       positionCount * 3
 *   f32  normals         positionCount * 3, only when hasNormals
 *   u32  indices         indexCount, only when indexCount > 0
 * ```
 *
 * No supports yet: support data needs the host's internal format serialized, and
 * that is the one part of this payload still to pin.
 */
export const SCENE_CONTAINER_MAGIC = 'DFIMPORT1';

export type SideloadedSceneModel = {
  modelId?: string;
  objName?: string;
  geometry: THREE.BufferGeometry;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
};

type ContainerMeta = {
  modelId?: unknown;
  name?: unknown;
  transform?: unknown;
  positionCount?: unknown;
  indexCount?: unknown;
  hasNormals?: unknown;
};

export function parseSideloadedSceneContainer(buffer: ArrayBuffer): SideloadedSceneModel[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();

  if (bytes.byteLength < 13) {
    throw new Error('Scene container is truncated.');
  }
  if (decoder.decode(bytes.subarray(0, 9)) !== SCENE_CONTAINER_MAGIC) {
    throw new Error('Scene container has an unknown header.');
  }

  let offset = 9;
  const modelCount = view.getUint32(offset, true);
  offset += 4;
  if (modelCount === 0 || modelCount > 4096) {
    throw new Error(`Scene container declares ${modelCount} models.`);
  }

  const models: SideloadedSceneModel[] = [];
  for (let index = 0; index < modelCount; index += 1) {
    const metaLength = view.getUint32(offset, true);
    offset += 4;
    if (offset + metaLength > bytes.byteLength) {
      throw new Error('Scene container model metadata runs past the end.');
    }
    const meta = JSON.parse(decoder.decode(bytes.subarray(offset, offset + metaLength))) as ContainerMeta;
    offset += metaLength;

    const positionCount = countOrNull(meta.positionCount);
    const indexCount = countOrNull(meta.indexCount);
    const hasNormals = meta.hasNormals === true;
    if (positionCount == null || indexCount == null) {
      throw new Error('Scene container model has no vertex counts.');
    }

    const positions = readFloats(buffer, offset, positionCount * 3);
    offset += positionCount * 3 * 4;
    const normals = hasNormals ? readFloats(buffer, offset, positionCount * 3) : null;
    if (hasNormals) offset += positionCount * 3 * 4;
    const indices = indexCount > 0 ? readUint32s(buffer, offset, indexCount) : null;
    if (indexCount > 0) offset += indexCount * 4;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (indices) {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    models.push({
      modelId: typeof meta.modelId === 'string' ? meta.modelId : undefined,
      objName: typeof meta.name === 'string' ? meta.name : undefined,
      geometry,
      transform: readTransform(meta.transform),
    });
  }

  return models;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** Copies rather than views, so a writer that misaligns its buffers still parses. */
function readFloats(buffer: ArrayBuffer, offset: number, length: number): Float32Array {
  const out = new Float32Array(length);
  const view = new DataView(buffer);
  for (let index = 0; index < length; index += 1) {
    out[index] = view.getFloat32(offset + index * 4, true);
  }
  return out;
}

function readUint32s(buffer: ArrayBuffer, offset: number, length: number): Uint32Array {
  const out = new Uint32Array(length);
  const view = new DataView(buffer);
  for (let index = 0; index < length; index += 1) {
    out[index] = view.getUint32(offset + index * 4, true);
  }
  return out;
}

function readTransform(value: unknown): SideloadedSceneModel['transform'] {
  const matrix = new THREE.Matrix4();
  if (Array.isArray(value) && value.length === 16 && value.every((entry) => typeof entry === 'number')) {
    matrix.fromArray(value as number[]);
  }

  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);

  return {
    position,
    rotation: new THREE.Euler().setFromQuaternion(quaternion),
    scale,
  };
}
