import assert from 'node:assert/strict';
import test from 'node:test';

import { getUnappliedModifiers } from '../unappliedModifiers';
import type { ModelMeshModifiers } from '../types';

const punch = {
  id: 'p1',
  modelId: 'm',
  centerNorm: [0, 0, 0],
  radiusMm: 1,
  depthMm: 1,
  direction: [0, 0, -1],
} as NonNullable<ModelMeshModifiers['holePunches']>[number];

test('unapplied modifier detection', () => {
  // Nothing declared.
  assert.deepEqual(getUnappliedModifiers(undefined), { holePunches: false, hollowing: false });
  assert.deepEqual(getUnappliedModifiers({} as ModelMeshModifiers), { holePunches: false, hollowing: false });

  // Draft punches count; flags-only hollowing has no source-backed work.
  assert.deepEqual(
    getUnappliedModifiers({ holePunches: [punch] } as ModelMeshModifiers),
    { holePunches: true, hollowing: false },
  );
  assert.deepEqual(
    getUnappliedModifiers({ holePunches: [punch], holePunchesBakedIntoGeometry: true } as ModelMeshModifiers),
    { holePunches: false, hollowing: false },
  );
  assert.deepEqual(
    getUnappliedModifiers({ hollowing: { enabled: true } } as ModelMeshModifiers),
    { holePunches: false, hollowing: false },
  );
  assert.deepEqual(
    getUnappliedModifiers({ hollowing: {
      enabled: true, bakedIntoGeometry: false, mode: 'cavity', voxelSizeMm: 0.5,
      shellThicknessMm: 2, openFace: 'z_max',
      sourcePositionsBase64: Buffer.from(new Float32Array(9).buffer).toString('base64'),
      sourcePositionCount: 3,
    } }),
    { holePunches: false, hollowing: true },
  );
  assert.deepEqual(
    getUnappliedModifiers({ hollowing: { enabled: true, bakedIntoGeometry: true } } as ModelMeshModifiers),
    { holePunches: false, hollowing: false },
  );
  // A remembered-but-disabled hollowing is not pending work.
  assert.deepEqual(
    getUnappliedModifiers({ hollowing: { enabled: false } } as ModelMeshModifiers),
    { holePunches: false, hollowing: false },
  );
});
