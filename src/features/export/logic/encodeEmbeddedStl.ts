import * as THREE from 'three';
import { yieldToEventLoop } from '@/utils/yieldToEventLoop';

/** Binary STL in model-local space, yielding between bounded batches of faces. */
export async function encodeEmbeddedStl(
  geometry: THREE.BufferGeometry,
  center: THREE.Vector3,
): Promise<Uint8Array> {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = position ? (index?.count ?? position.count) : 0;
  const bytes = new Uint8Array(84 + count / 3 * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count / 3, true);
  if (!position) return bytes;

  const version = () => position instanceof THREE.BufferAttribute ? position.version : position.data.version;
  const originalVersion = version();
  const originalArray = position.array;
  const originalIndexVersion = index?.version;
  const originalIndexArray = index?.array;
  const assertUnchanged = () => {
    if (geometry.getAttribute('position') !== position || version() !== originalVersion
      || position.array !== originalArray || geometry.getIndex() !== index
      || index?.version !== originalIndexVersion || index?.array !== originalIndexArray) {
      throw new Error('Geometry changed while encoding its embedded STL; retry with the current geometry.');
    }
  };
  const matrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cb = new THREE.Vector3(), ab = new THREE.Vector3(), normal = new THREE.Vector3();
  let offset = 84;
  const write = (v: THREE.Vector3) => {
    view.setFloat32(offset, v.x, true);
    view.setFloat32(offset + 4, v.y, true);
    view.setFloat32(offset + 8, v.z, true);
    offset += 12;
  };
  let batchStarted = performance.now();
  for (let face = 0; face < count; face += 3) {
    a.fromBufferAttribute(position, index ? index.getX(face) : face).applyMatrix4(matrix);
    b.fromBufferAttribute(position, index ? index.getX(face + 1) : face + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(position, index ? index.getX(face + 2) : face + 2).applyMatrix4(matrix);
    cb.subVectors(c, b);
    ab.subVectors(a, b);
    // Match STLExporter's two normalizations and byte ordering exactly.
    normal.copy(cb.cross(ab).normalize()).normalize();
    write(normal); write(a); write(b); write(c);
    offset += 2; // Zero attribute-byte count, as in STLExporter.
    if ((face / 3 + 1) % 256 === 0 && performance.now() - batchStarted >= 4 && face + 3 < count) {
      await yieldToEventLoop();
      assertUnchanged();
      batchStarted = performance.now();
    }
  }
  assertUnchanged();
  return bytes;
}
