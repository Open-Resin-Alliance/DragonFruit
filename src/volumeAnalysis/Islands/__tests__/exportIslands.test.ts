import assert from 'node:assert';
import * as THREE from 'three';
import type { DetectedIsland } from '../types';
import { islandsExportFileName, serializeIslandsForExport } from '../exportIslands';

const island: DetectedIsland = {
  id: 'o-1',
  source: 'overhang',
  contact: new THREE.Vector3(1, 2, 3),
  baseZ: 3,
  areaMm2: 12.5,
  overhangAngleDeg: 20,
  surfaceNormal: { x: 0, y: 0, z: -1 },
  contactVoxels: {
    xy: new Float32Array([1, 2, 3, 4]),
    z: new Float32Array([3, 3]),
    count: 2,
  },
};

const [serialized] = serializeIslandsForExport([island]) as Array<Record<string, unknown>>;
assert.deepEqual(serialized.contact, { x: 1, y: 2, z: 3 });
assert.deepEqual(serialized.contactVoxels, { xy: [1, 2, 3, 4], z: [3, 3], count: 2 });
assert.equal(serialized.areaMm2, 12.5);
assert.equal(serialized.surfaceNormal && (serialized.surfaceNormal as { z: number }).z, -1);
assert.equal(islandsExportFileName('models/My Part.stl'), 'My-Part.islands.json');
assert.equal(islandsExportFileName(undefined), 'islands.islands.json');
