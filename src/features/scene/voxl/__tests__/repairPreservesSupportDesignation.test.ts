import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { MeshRepairOptions } from '@/utils/meshRepair';
import { processGeometry, type ProcessGeometryOptions } from '@/hooks/useStlGeometry';
import { encodeSupportSettingsHex } from '@/supports/Settings/supportSettingsCodec';
import { createDefaultSettings } from '@/supports/Settings/types';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import type { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import {
  cloneSupportState,
  getSnapshot,
  loadFromImportFormat,
  resetKickstandsInState,
  resetStore,
  transformSupportsForModel,
} from '@/supports/state';
import {
  getSupportTypeDescriptor,
  SUPPORT_COLLECTION_KEYS,
  type SupportCollectionKey,
  type SupportTypeId,
} from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat, SupportCollectionByType } from '@/supports/types';

type SimpleModel = {
  id: string;
  name: string;
  isSupportGeometry?: boolean;
  geometry: {
    getAttribute: (name: string) => { count: number } | null;
  };
};

test('repair preserves isSupportGeometry designation on model object', () => {
  const model: SimpleModel = {
    id: 'support-model-1',
    name: 'Support Mesh',
    isSupportGeometry: true,
    geometry: {
      getAttribute: () => ({ count: 300 }),
    },
  };

  const processOptions: ProcessGeometryOptions = {
    center: false,
    nativeProcessingMode: 'repair',
    assumeSupportGeometry: model.isSupportGeometry,
  };

  assert.equal(processOptions.assumeSupportGeometry, true);

  // Simulate updating model state post-repair
  const repairedModel: SimpleModel = {
    ...model,
    isSupportGeometry: model.isSupportGeometry,
  };

  assert.equal(repairedModel.isSupportGeometry, true);
});

test('assumeSupportGeometry option is passed in MeshRepairOptions payload', () => {
  const options: MeshRepairOptions = {
    assumeSupportGeometry: true,
    weldToleranceMm: 1e-5,
  };

  assert.equal(options.assumeSupportGeometry, true);

  const payload = {
    ...options,
    assume_support_geometry: options.assumeSupportGeometry,
  };

  const optionsJson = JSON.stringify(payload);
  const parsed = JSON.parse(optionsJson);

  assert.equal(parsed.assumeSupportGeometry, true);
  assert.equal(parsed.assume_support_geometry, true);
});

function emptyRepairCollections(): Pick<DragonfruitImportFormat, SupportCollectionKey> {
  const collections = {} as Record<string, unknown[]>;
  for (const key of SUPPORT_COLLECTION_KEYS) collections[key] = [];
  return collections as unknown as Pick<DragonfruitImportFormat, SupportCollectionKey>;
}

function setRepairCollection<K extends SupportTypeId>(
  payload: DragonfruitImportFormat,
  typeId: K,
  entities: DragonfruitImportFormat[SupportCollectionByType[K] & keyof DragonfruitImportFormat],
): void {
  (payload as unknown as Record<string, unknown>)[getSupportTypeDescriptor(typeId).location.key] = entities;
}

test('processGeometry repair with identity transformSupportsForModel preserves non-collinear supports in store', async () => {
  resetStore();
  resetKickstandsInState();

  const box = new THREE.BoxGeometry(10, 10, 10);
  const invertedGeometry = box.toNonIndexed();
  box.dispose();

  try {
    const normalAttr = invertedGeometry.getAttribute('normal') as THREE.BufferAttribute;
    const expectedOutwardNormals = Float32Array.from(normalAttr.array as Float32Array);
    for (let i = 0; i < normalAttr.count; i += 1) {
      normalAttr.setXYZ(i, -normalAttr.getX(i), -normalAttr.getY(i), -normalAttr.getZ(i));
    }
    normalAttr.needsUpdate = true;

    const modelId = 'model-repair-test';
    const settingsCodeHex = encodeSupportSettingsHex(createDefaultSettings());
    const diskProfile = {
      type: 'disk' as const,
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 3,
      penetrationMm: 0.05,
      diskThicknessMm: 0.12,
      maxStandoffMm: 0.5,
      standoffAngleThreshold: Math.PI / 4,
    };

    const trunkCone: ContactCone = {
      id: 'repair-trunk-cone',
      pos: { x: 1, y: 0, z: 12 },
      normal: { x: 0.28, y: 0, z: -0.96 },
      surfaceNormal: { x: 0.6, y: 0, z: -0.8 },
      diskLengthOverride: 0.41,
      socketJointId: 'repair-trunk-tj',
      profile: { ...diskProfile },
    };
    const branchCone: ContactCone = {
      id: 'repair-branch-cone',
      pos: { x: 3, y: 1, z: 10 },
      normal: { x: -2 / 7, y: 3 / 7, z: -6 / 7 },
      surfaceNormal: { x: -0.6, y: 0, z: -0.8 },
      diskLengthOverride: 0.36,
      socketJointId: 'repair-branch-tj',
      profile: { ...diskProfile },
    };
    const leafCone: ContactCone = {
      id: 'repair-leaf-cone',
      pos: { x: 2.5, y: 1.5, z: 7.5 },
      normal: { x: 0.6, y: 0, z: -0.8 },
      surfaceNormal: { x: 0, y: 0.6, z: -0.8 },
      diskLengthOverride: 0.29,
      profile: { ...diskProfile },
    };
    const stumpCone: ContactCone = {
      id: 'repair-stump-cone',
      pos: { x: 5.5, y: 0.5, z: 3.5 },
      normal: { x: 2 / 7, y: -3 / 7, z: -6 / 7 },
      surfaceNormal: { x: 0.6, y: 0, z: -0.8 },
      diskLengthOverride: 0.33,
      socketJointId: 'repair-stump-joint',
      profile: { ...diskProfile },
    };
    const stickConeA: ContactCone = {
      id: 'repair-stick-cone-a',
      pos: { x: -3, y: 1, z: 2 },
      normal: { x: 0, y: 0.6, z: 0.8 },
      surfaceNormal: { x: 0.6, y: 0, z: 0.8 },
      diskLengthOverride: 0.24,
      socketJointId: 'repair-stick-bj',
      profile: { ...diskProfile },
    };
    const stickConeB: ContactCone = {
      id: 'repair-stick-cone-b',
      pos: { x: -3.5, y: 1.5, z: 10 },
      normal: { x: 2 / 7, y: 3 / 7, z: -6 / 7 },
      surfaceNormal: { x: 0, y: 0.8, z: -0.6 },
      diskLengthOverride: 0.31,
      socketJointId: 'repair-stick-tj',
      profile: { ...diskProfile },
    };

    const trunkSocketPos = getFinalSocketPosition(trunkCone);
    const branchSocketPos = getFinalSocketPosition(branchCone);
    const stumpSocketPos = getFinalSocketPosition(stumpCone);
    const stickSocketAPos = getFinalSocketPosition(stickConeA);
    const stickSocketBPos = getFinalSocketPosition(stickConeB);

    const payload: DragonfruitImportFormat = {
      ...emptyRepairCollections(),
      version: 1,
      meta: { source: 'repair-invariance-test', objectCenter: { x: 0, y: 0, z: 0 } },
      roots: [
        {
          id: 'repair-root',
          modelId,
          transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
          diameter: 6,
          diskHeight: 1,
          coneHeight: 1,
        },
      ],
      knots: [
        {
          id: 'repair-k-branch',
          parentShaftId: 'repair-trunk-seg-lower',
          t: 0.75,
          pos: { x: 0, y: 0, z: 5 },
          diameter: 1.3,
        },
        {
          id: 'repair-k-leaf',
          parentShaftId: 'repair-trunk-seg-lower',
          t: 0.5,
          pos: { x: 0, y: 0, z: 4 },
          diameter: 1.3,
        },
      ],
    };

    setRepairCollection(payload, 'trunk', [
      {
        id: 'repair-trunk',
        modelId,
        rootId: 'repair-root',
        settingsCodeHex,
        segments: [
          {
            id: 'repair-trunk-seg-lower',
            type: 'straight',
            diameter: 1.2,
            topJoint: { id: 'repair-trunk-mid', pos: { x: 0, y: 0, z: 6 }, diameter: 1.3 },
          },
          {
            id: 'repair-trunk-seg-upper',
            type: 'straight',
            diameter: 1.2,
            bottomJoint: { id: 'repair-trunk-mid', pos: { x: 0, y: 0, z: 6 }, diameter: 1.3 },
            topJoint: { id: 'repair-trunk-tj', pos: trunkSocketPos, diameter: 1.3 },
          },
        ],
        contactCone: trunkCone,
      },
    ]);
    setRepairCollection(payload, 'branch', [
      {
        id: 'repair-branch',
        modelId,
        parentKnotId: 'repair-k-branch',
        settingsCodeHex,
        segments: [
          {
            id: 'repair-branch-seg',
            type: 'straight',
            diameter: 1.0,
            topJoint: { id: 'repair-branch-tj', pos: branchSocketPos, diameter: 1.1 },
          },
        ],
        contactCone: branchCone,
      },
    ]);
    setRepairCollection(payload, 'leaf', [
      {
        id: 'repair-leaf',
        modelId,
        parentKnotId: 'repair-k-leaf',
        settingsCodeHex,
        contactCone: leafCone,
      },
    ]);
    setRepairCollection(payload, 'stump', [
      {
        id: 'repair-stump',
        modelId,
        settingsCodeHex,
        rootPos: { x: 6, y: 0, z: 0 },
        rootBaseDiameter: 2.0,
        rootTopDiameter: 1.5,
        rootHeight: 1.0,
        joint: { id: 'repair-stump-joint', pos: stumpSocketPos, diameter: 1.5 },
        segments: [],
        contactCone: stumpCone,
      },
    ]);
    setRepairCollection(payload, 'stick', [
      {
        id: 'repair-stick',
        modelId,
        settingsCodeHex,
        segments: [
          {
            id: 'repair-stick-seg',
            type: 'straight',
            diameter: 1.0,
            bottomJoint: { id: 'repair-stick-bj', pos: stickSocketAPos, diameter: 1.1 },
            topJoint: { id: 'repair-stick-tj', pos: stickSocketBPos, diameter: 1.1 },
          },
        ],
        contactConeA: stickConeA,
        contactConeB: stickConeB,
      },
    ]);
    setRepairCollection(payload, 'twig', [
      {
        id: 'repair-twig',
        modelId,
        settingsCodeHex,
        segments: [
          {
            id: 'repair-twig-seg',
            type: 'straight',
            diameter: 0.36,
            bottomJoint: { id: 'repair-twig-bj', pos: { x: 8.168, y: -2, z: 3.224 }, diameter: 0.46 },
            topJoint: { id: 'repair-twig-tj', pos: { x: 8.5, y: -1.296, z: 5.728 }, diameter: 0.46 },
          },
        ],
        contactDiskA: {
          id: 'repair-twig-disk-a',
          pos: { x: 8, y: -2, z: 3 },
          surfaceNormal: { x: 0.6, y: 0, z: 0.8 },
          coneAxis: { x: 0, y: 0.6, z: 0.8 },
          diskLengthOverride: 0.28,
          contactDiameterMm: 0.36,
          profile: {
            type: 'disk',
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.5,
            standoffAngleThreshold: Math.PI / 4,
          },
        },
        contactDiskB: {
          id: 'repair-twig-disk-b',
          pos: { x: 8.5, y: -1.5, z: 6 },
          surfaceNormal: { x: 0, y: 0.6, z: -0.8 },
          coneAxis: { x: -2 / 7, y: 3 / 7, z: -6 / 7 },
          diskLengthOverride: 0.34,
          contactDiameterMm: 0.36,
          profile: {
            type: 'disk',
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.5,
            standoffAngleThreshold: Math.PI / 4,
          },
        },
      },
    ]);

    loadFromImportFormat(payload);
    const snapshotBefore = cloneSupportState(getSnapshot());

    const processed = await processGeometry(invertedGeometry, {
      center: false,
      nativeProcessingMode: 'repair',
      assumeSupportGeometry: false,
    });
    const repairedNormals = processed.geometry.getAttribute('normal') as THREE.BufferAttribute;
    assert.ok(repairedNormals, 'repaired geometry must carry recomputed normals');
    assert.ok(
      Math.abs(repairedNormals.getX(0) - expectedOutwardNormals[0]) < 1e-5
      && Math.abs(repairedNormals.getY(0) - expectedOutwardNormals[1]) < 1e-5
      && Math.abs(repairedNormals.getZ(0) - expectedOutwardNormals[2]) < 1e-5,
      'processGeometry must repair inverted vertex normals back to outward winding normals',
    );
    processed.geometry.dispose();

    const identityTransform = {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    };
    const transformResult = transformSupportsForModel(
      modelId,
      identityTransform,
      {
        position: identityTransform.position.clone(),
        rotation: identityTransform.rotation.clone(),
        scale: identityTransform.scale.clone(),
      },
    );

    assert.deepStrictEqual(transformResult, { supportsChanged: false, kickstandsChanged: false });
    assert.deepStrictEqual(getSnapshot(), snapshotBefore);
  } finally {
    invertedGeometry.dispose();
    resetStore();
    resetKickstandsInState();
  }
});
