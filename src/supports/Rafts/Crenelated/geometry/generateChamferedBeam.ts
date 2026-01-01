import * as THREE from 'three';

export function generateChamferedBeam(
  start: THREE.Vector3,
  end: THREE.Vector3,
  settings: {
    widthMm: number;
    heightMm: number;
    chamferAngleDeg: number;
  }
): THREE.Mesh {
  const width = Math.max(0.01, settings.widthMm);
  const height = Math.max(0.01, settings.heightMm);
  const angleDeg = Math.min(90, Math.max(45, settings.chamferAngleDeg));

  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  if (!Number.isFinite(length) || length < 0.001) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Match solid raft chamfer semantics:
  // - Top is the full width
  // - Bottom is inset so top > bottom
  // inset = height * tan(90 - angle)
  const inset = height * Math.tan((Math.PI / 180) * (90 - angleDeg));
  const topHalfW = width / 2;
  const bottomHalfW = Math.max(0.001, topHalfW - inset);

  // Local prism coordinates:
  // X: along beam length, Y: beam width, Z: up.
  const x0 = 0;
  const x1 = length;

  // 8 vertices: bottom (z=0) and top (z=height)
  const v = [
    // Bottom ring
    new THREE.Vector3(x0, -bottomHalfW, 0),
    new THREE.Vector3(x0, bottomHalfW, 0),
    new THREE.Vector3(x1, bottomHalfW, 0),
    new THREE.Vector3(x1, -bottomHalfW, 0),
    // Top ring
    new THREE.Vector3(x0, -topHalfW, height),
    new THREE.Vector3(x0, topHalfW, height),
    new THREE.Vector3(x1, topHalfW, height),
    new THREE.Vector3(x1, -topHalfW, height),
  ];

  const positions: number[] = [];
  for (const p of v) positions.push(p.x, p.y, p.z);

  // Faces (12 triangles)
  const indices: number[] = [
    // Bottom (0,1,2,3)
    0, 2, 1,
    0, 3, 2,

    // Top (4,5,6,7)
    4, 5, 6,
    4, 6, 7,

    // Side - left (0,4,7,3)
    0, 4, 7,
    0, 7, 3,

    // Side - right (1,2,6,5)
    1, 6, 2,
    1, 5, 6,

    // Side - start (0,1,5,4)
    0, 1, 5,
    0, 5, 4,

    // Side - end (3,7,6,2)
    3, 6, 7,
    3, 2, 6,
  ];

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const allFinite = positions.every((n) => Number.isFinite(n));
  if (!allFinite) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Transform prism from local to world:
  // - local +X aligns to (end-start)
  // - translate to start
  const axisX = new THREE.Vector3(1, 0, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(axisX, dir.normalize());

  const m = new THREE.Matrix4();
  m.makeRotationFromQuaternion(q);
  m.setPosition(start);
  geom.applyMatrix4(m);

  return new THREE.Mesh(geom);
}
