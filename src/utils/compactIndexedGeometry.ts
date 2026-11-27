import * as THREE from 'three';

type TypedArrayConstructor =
  | typeof Float32Array
  | typeof Float64Array
  | typeof Uint32Array
  | typeof Uint16Array
  | typeof Uint8Array
  | typeof Uint8ClampedArray
  | typeof Int32Array
  | typeof Int16Array
  | typeof Int8Array;

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Bitwise-exact vertex deduplication for a non-indexed triangle soup.
 *
 * Replaces duplicate `(x, y, z)` vertices that share identical IEEE-754 bit
 * patterns with a shared vertex plus a `Uint16Array`/`Uint32Array` index buffer.
 * Leaves the geometry untouched when it is already indexed, carries extra
 * per-corner attributes (such as `uv` or `color`), or has no shared vertices.
 */
export function compactGeometryToIndexed(
  geometry: THREE.BufferGeometry,
  options: { dropNormals?: boolean } = {},
): THREE.BufferGeometry {
  if (geometry.getIndex()) return geometry;

  const posAttr = geometry.getAttribute('position');
  if (!(posAttr instanceof THREE.BufferAttribute) || posAttr.itemSize !== 3) return geometry;
  if (!(posAttr.array instanceof Float32Array)) return geometry;

  const dropNormals = options.dropNormals ?? true;
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'position') continue;
    if (dropNormals && name === 'normal') continue;
    return geometry;
  }

  const vertexCount = posAttr.count;
  if (vertexCount < 3) return geometry;

  const srcF32 = posAttr.array;
  const srcU32 = new Uint32Array(srcF32.buffer, srcF32.byteOffset, vertexCount * 3);

  // Manifold triangle meshes have roughly V ≈ corners / 6; start at corners / 2
  // slots (load factor ~0.33) and rehash if a pathological mesh is denser.
  let tableSize = nextPowerOfTwo(Math.max(16, Math.ceil(vertexCount / 2)));
  let mask = tableSize - 1;
  let table = new Int32Array(tableSize).fill(-1);

  let uniqueCap = Math.max(16, Math.min(vertexCount, Math.ceil(vertexCount / 3)));
  let uniqueF32 = new Float32Array(uniqueCap * 3);
  let uniqueU32 = new Uint32Array(uniqueF32.buffer);
  let uniqueCount = 0;

  const indicesU32 = new Uint32Array(vertexCount);

  const growTable = () => {
    tableSize <<= 1;
    mask = tableSize - 1;
    table = new Int32Array(tableSize).fill(-1);
    for (let id = 0; id < uniqueCount; id += 1) {
      const o = id * 3;
      const hash = Math.imul(
        uniqueU32[o] ^ Math.imul(uniqueU32[o + 1], 0x9e3779b1) ^ Math.imul(uniqueU32[o + 2], 0x85ebca6b),
        0x27d4eb2d,
      );
      let slot = (hash ^ (hash >>> 15)) & mask;
      while (table[slot] !== -1) {
        slot = (slot + 1) & mask;
      }
      table[slot] = id;
    }
  };

  for (let i = 0; i < vertexCount; i += 1) {
    const s = i * 3;
    const bx = srcU32[s];
    const by = srcU32[s + 1];
    const bz = srcU32[s + 2];

    const hash = Math.imul(
      bx ^ Math.imul(by, 0x9e3779b1) ^ Math.imul(bz, 0x85ebca6b),
      0x27d4eb2d,
    );
    let slot = (hash ^ (hash >>> 15)) & mask;
    let found = -1;
    while (true) {
      const candidate = table[slot];
      if (candidate === -1) break;
      const co = candidate * 3;
      if (uniqueU32[co] === bx && uniqueU32[co + 1] === by && uniqueU32[co + 2] === bz) {
        found = candidate;
        break;
      }
      slot = (slot + 1) & mask;
    }

    if (found !== -1) {
      indicesU32[i] = found;
      continue;
    }

    if (uniqueCount === uniqueCap) {
      uniqueCap = Math.min(vertexCount, uniqueCap * 2);
      const grown = new Float32Array(uniqueCap * 3);
      grown.set(uniqueF32);
      uniqueF32 = grown;
      uniqueU32 = new Uint32Array(uniqueF32.buffer);
    }

    const id = uniqueCount;
    uniqueCount += 1;
    const uo = id * 3;
    uniqueU32[uo] = bx;
    uniqueU32[uo + 1] = by;
    uniqueU32[uo + 2] = bz;
    indicesU32[i] = id;

    if (uniqueCount * 2 >= tableSize) {
      growTable();
    } else {
      table[slot] = id;
    }
  }

  // No duplicates found: adding an index buffer would only increase memory.
  if (uniqueCount >= vertexCount) {
    if (dropNormals && geometry.getAttribute('normal')) {
      geometry.deleteAttribute('normal');
    }
    return geometry;
  }

  const packedPositions = uniqueF32.slice(0, uniqueCount * 3);
  const packedIndex = uniqueCount <= 0xffff ? Uint16Array.from(indicesU32) : indicesU32;

  geometry.setAttribute('position', new THREE.BufferAttribute(packedPositions, 3));
  geometry.setIndex(new THREE.BufferAttribute(packedIndex, 1));
  if (dropNormals && geometry.getAttribute('normal')) {
    geometry.deleteAttribute('normal');
  }
  return geometry;
}

/**
 * Extract world-space triangle-soup positions and bounding box from a geometry
 * transformed by `matrix * translate(-bboxCenter)`, without cloning the
 * geometry or calling `.toNonIndexed()`.
 */
export function buildWorldTriangleSoup(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): { positions: Float32Array; bbox: THREE.Box3 } {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr || posAttr.count === 0) {
    return { positions: new Float32Array(0), bbox: new THREE.Box3() };
  }

  const bb = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(posAttr);
  const center = bb.getCenter(new THREE.Vector3());
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  const e = matrix.elements;
  const e0 = e[0], e1 = e[1], e2 = e[2];
  const e4 = e[4], e5 = e[5], e6 = e[6];
  const e8 = e[8], e9 = e[9], e10 = e[10];
  const e12 = e[12], e13 = e[13], e14 = e[14];

  const vertexCount = posAttr.count;
  const srcArray = posAttr.array;
  const isPackedF32 = posAttr instanceof THREE.BufferAttribute && posAttr.itemSize === 3 && srcArray instanceof Float32Array;
  const index = geometry.getIndex();

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  if (!index) {
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i += 1) {
      const o = i * 3;
      const sx = isPackedF32 ? srcArray[o] : posAttr.getX(i);
      const sy = isPackedF32 ? srcArray[o + 1] : posAttr.getY(i);
      const sz = isPackedF32 ? srcArray[o + 2] : posAttr.getZ(i);
      const lx = Math.fround(sx - cx);
      const ly = Math.fround(sy - cy);
      const lz = Math.fround(sz - cz);
      const wx = Math.fround(e0 * lx + e4 * ly + e8 * lz + e12);
      const wy = Math.fround(e1 * lx + e5 * ly + e9 * lz + e13);
      const wz = Math.fround(e2 * lx + e6 * ly + e10 * lz + e14);
      positions[o] = wx;
      positions[o + 1] = wy;
      positions[o + 2] = wz;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
    const bbox = new THREE.Box3(
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(maxX, maxY, maxZ),
    );
    return { positions, bbox };
  }

  // Transform each unique vertex once, then gather into triangle soup order.
  const transformed = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    const o = i * 3;
    const sx = isPackedF32 ? srcArray[o] : posAttr.getX(i);
    const sy = isPackedF32 ? srcArray[o + 1] : posAttr.getY(i);
    const sz = isPackedF32 ? srcArray[o + 2] : posAttr.getZ(i);
    const lx = Math.fround(sx - cx);
    const ly = Math.fround(sy - cy);
    const lz = Math.fround(sz - cz);
    transformed[o] = e0 * lx + e4 * ly + e8 * lz + e12;
    transformed[o + 1] = e1 * lx + e5 * ly + e9 * lz + e13;
    transformed[o + 2] = e2 * lx + e6 * ly + e10 * lz + e14;
  }

  const idxArray = index.array;
  const cornerCount = idxArray.length;
  const positions = new Float32Array(cornerCount * 3);
  for (let i = 0; i < cornerCount; i += 1) {
    const src = Number(idxArray[i]) * 3;
    const dst = i * 3;
    const wx = transformed[src];
    const wy = transformed[src + 1];
    const wz = transformed[src + 2];
    positions[dst] = wx;
    positions[dst + 1] = wy;
    positions[dst + 2] = wz;
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wz < minZ) minZ = wz;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
    if (wz > maxZ) maxZ = wz;
  }

  const bbox = cornerCount > 0
    ? new THREE.Box3(
        new THREE.Vector3(minX, minY, minZ),
        new THREE.Vector3(maxX, maxY, maxZ),
      )
    : new THREE.Box3();
  return { positions, bbox };
}

/**
 * Expand an indexed geometry that has no `normal` attribute into flat-shaded
 * per-corner attributes so `computeVertexNormals()` yields the same geometric
 * face normals as the legacy `toNonIndexed() -> computeVertexNormals()` path.
 */
function expandNormalsForUnshadedIndexedPart(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = source.getIndex();
  const posAttr = source.getAttribute('position');
  if (!index || !posAttr) return source.clone();

  const idxArr = index.array;
  const cornerCount = idxArr.length;
  const expanded = new THREE.BufferGeometry();

  for (const [name, attr] of Object.entries(source.attributes)) {
    if (!(attr instanceof THREE.BufferAttribute)) continue;
    const itemSize = attr.itemSize;
    const Ctor = attr.array.constructor as TypedArrayConstructor;
    const dst = new Ctor(cornerCount * itemSize);
    const src = attr.array;
    for (let i = 0; i < cornerCount; i += 1) {
      const s = Number(idxArr[i]) * itemSize;
      const d = i * itemSize;
      for (let k = 0; k < itemSize; k += 1) {
        dst[d + k] = src[s + k];
      }
    }
    expanded.setAttribute(name, new THREE.BufferAttribute(dst, itemSize, attr.normalized));
  }

  expanded.computeVertexNormals();
  return expanded;
}

/**
 * Merge geometries into a single BufferGeometry while preserving indexing.
 *
 * Unlike `three/examples/jsm/utils/BufferGeometryUtils.mergeGeometries`, this
 * accepts mixed indexed and non-indexed inputs without expanding indexed parts
 * into non-indexed triangle soups: non-indexed parts receive sequential offset
 * indices when merged alongside indexed parts.
 */
export function mergeGeometriesPreservingIndex(
  parts: readonly THREE.BufferGeometry[],
  options: {
    ensureNormals?: boolean;
    keepAttributes?: readonly string[];
  } = {},
): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;

  const ensureNormals = options.ensureNormals ?? false;
  const prepared: THREE.BufferGeometry[] = [];
  const owned: THREE.BufferGeometry[] = [];

  try {
    for (const part of parts) {
      if (!part.getAttribute('position')) continue;
      if (ensureNormals && !part.getAttribute('normal')) {
        if (part.getIndex()) {
          const expanded = expandNormalsForUnshadedIndexedPart(part);
          prepared.push(expanded);
          owned.push(expanded);
        } else {
          const clone = part.clone();
          clone.computeVertexNormals();
          prepared.push(clone);
          owned.push(clone);
        }
      } else {
        prepared.push(part);
      }
    }

    if (prepared.length === 0) return null;

    // Intersect attribute names across all parts (and optional allowlist).
    const firstNames = Object.keys(prepared[0].attributes);
    let sharedNames = options.keepAttributes
      ? firstNames.filter((name) => options.keepAttributes!.includes(name))
      : firstNames.slice();

    for (let i = 1; i < prepared.length; i += 1) {
      const attrs = prepared[i].attributes;
      sharedNames = sharedNames.filter((name) => name in attrs);
    }

    if (!sharedNames.includes('position')) return null;

    // Validate compatible attribute metadata (itemSize, normalized, BufferAttribute).
    // Incompatible non-position attributes are dropped rather than failing the merge.
    const meta = new Map<string, { itemSize: number; normalized: boolean; Ctor: TypedArrayConstructor }>();
    const compatibleNames: string[] = [];
    for (const name of sharedNames) {
      const firstAttr = prepared[0].getAttribute(name);
      if (!(firstAttr instanceof THREE.BufferAttribute)) {
        if (name === 'position') return null;
        continue;
      }
      const itemSize = firstAttr.itemSize;
      const normalized = firstAttr.normalized;
      const Ctor = firstAttr.array.constructor as TypedArrayConstructor;
      let compatible = true;
      for (let i = 1; i < prepared.length; i += 1) {
        const attr = prepared[i].getAttribute(name);
        if (
          !(attr instanceof THREE.BufferAttribute)
          || attr.itemSize !== itemSize
          || attr.normalized !== normalized
          || attr.array.constructor !== Ctor
        ) {
          compatible = false;
          break;
        }
      }
      if (!compatible) {
        if (name === 'position') return null;
        continue;
      }
      meta.set(name, { itemSize, normalized, Ctor });
      compatibleNames.push(name);
    }
    sharedNames = compatibleNames;

    let anyIndexed = false;
    let totalVertices = 0;
    let totalIndices = 0;
    for (const part of prepared) {
      const vCount = part.getAttribute('position').count;
      const idx = part.getIndex();
      if (idx) {
        anyIndexed = true;
        totalIndices += idx.count;
      } else {
        totalIndices += vCount;
      }
      totalVertices += vCount;
    }

    const merged = new THREE.BufferGeometry();
    for (const name of sharedNames) {
      const { itemSize, normalized, Ctor } = meta.get(name)!;
      const out = new Ctor(totalVertices * itemSize);
      let offset = 0;
      for (const part of prepared) {
        const attr = part.getAttribute(name) as THREE.BufferAttribute;
        out.set(attr.array as ArrayLike<number>, offset);
        offset += attr.count * itemSize;
      }
      merged.setAttribute(name, new THREE.BufferAttribute(out, itemSize, normalized));
    }

    if (anyIndexed) {
      const outIndex = totalVertices <= 0xffff
        ? new Uint16Array(totalIndices)
        : new Uint32Array(totalIndices);
      let vOffset = 0;
      let iOffset = 0;
      for (const part of prepared) {
        const vCount = part.getAttribute('position').count;
        const idx = part.getIndex();
        if (idx) {
          const srcIdx = idx.array;
          for (let i = 0; i < srcIdx.length; i += 1) {
            outIndex[iOffset + i] = Number(srcIdx[i]) + vOffset;
          }
          iOffset += srcIdx.length;
        } else {
          for (let i = 0; i < vCount; i += 1) {
            outIndex[iOffset + i] = vOffset + i;
          }
          iOffset += vCount;
        }
        vOffset += vCount;
      }
      merged.setIndex(new THREE.BufferAttribute(outIndex, 1));
    }

    return merged;
  } finally {
    for (const temp of owned) temp.dispose();
  }
}
