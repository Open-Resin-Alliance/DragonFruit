import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { splitClassifiedSupportGeometry } from '@/features/scene/splitClassifiedSupports';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import {
  serializeVoxlDocumentV2,
  parseVoxlBinaryV2,
} from '../codec-v2';
import {
  buildVoxlDocumentV1,
  parseVoxlDocument,
  serializeVoxlDocument,
} from '../codec';
import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
  trunks: [],
  branches: [],
  leaves: [],
  braces: [],
  knots: [],
} as unknown as DragonfruitImportFormat;

function createDummyGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  // 2 triangles: 6 vertices x 3 floats = 18 floats
  const positions = new Float32Array([
    0, 0, 0,  10, 0, 0,  0, 10, 0, // Triangle 1 (Model)
    0, 0, 0,  20, 0, 0,  0, 20, 0, // Triangle 2 (Support)
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeBoundingBox();
  return geom;
}

test('splitSupports assigns isSupportGeometry: false to model and isSupportGeometry: true to support geometry', () => {
  const geom = createDummyGeometry();
  const source: LoadedModel = {
    id: 'orig-model-1',
    name: 'TestPart.stl',
    fileUrl: '',
    geometry: {
      geometry: geom,
      bbox: geom.boundingBox?.clone() ?? new THREE.Box3(),
      center: new THREE.Vector3(5, 5, 0),
      size: new THREE.Vector3(20, 20, 0),
      flatteningPlanes: [],
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: 6,
        nativeRepairReport: {
          version: 1,
          source_path: null,
          pre: { triangle_count: 2 } as any,
          post: { triangle_count: 2 } as any,
          steps: [],
          likely_support_geometry: false,
          residual_issues: [],
          fully_repaired: true,
          total_ms: 0,
          model_triangle_count: 1,
        },
      },
    },
    transform: {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
    visible: true,
    color: '#a3a3a3',
    polygonCount: 2,
  };

  const split = splitClassifiedSupportGeometry(source, { interactive: false });
  assert.ok(split);

  const modelModel: LoadedModel = {
    id: 'model-body-id',
    name: 'TestPart (Model)',
    fileUrl: source.fileUrl,
    sourcePath: null,
    geometry: split.modelGeometry,
    transform: {
      position: split.modelPosition,
      rotation: source.transform.rotation.clone(),
      scale: source.transform.scale.clone(),
    },
    visible: source.visible,
    color: source.color,
    polygonCount: split.modelTriangleCount,
    isSupportGeometry: false,
  };

  const supportModel: LoadedModel = {
    id: 'support-mesh-id',
    name: 'TestPart (Supports)',
    fileUrl: source.fileUrl,
    sourcePath: null,
    geometry: split.supportGeometry,
    transform: {
      position: split.supportPosition,
      rotation: source.transform.rotation.clone(),
      scale: source.transform.scale.clone(),
    },
    visible: source.visible,
    color: source.color,
    polygonCount: split.supportTriangleCount,
    isSupportGeometry: true,
  };

  assert.equal(modelModel.isSupportGeometry, false);
  assert.equal(supportModel.isSupportGeometry, true);
});

test('VOXL V1 round-trip persistence for split support model', () => {
  const modelPart: VoxlModelRuntimeLike = {
    id: 'model-part',
    name: 'TestPart (Model)',
    visible: true,
    color: '#a3a3a3',
    polygonCount: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'external-file', fileName: 'model-part.stl' },
    isSupportGeometry: false,
  };

  const supportPart: VoxlModelRuntimeLike = {
    id: 'support-part',
    name: 'TestPart (Supports)',
    visible: true,
    color: '#a3a3a3',
    polygonCount: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'external-file', fileName: 'support-part.stl' },
    isSupportGeometry: true,
    linkGroupId: 'link-group-split',
  };

  const input: BuildVoxlDocumentInput = {
    models: [modelPart, supportPart],
    activeModelId: 'model-part',
    selectedModelIds: ['model-part', 'support-part'],
    supports: EMPTY_SUPPORTS,
  };

  const doc = buildVoxlDocumentV1(input);
  const serializedJson = serializeVoxlDocument(doc, false, { compression: 'none' });
  const parsed = parseVoxlDocument(serializedJson);

  assert.equal(parsed.models.length, 2);
  const parsedModel = parsed.models.find((m) => m.id === 'model-part');
  const parsedSupport = parsed.models.find((m) => m.id === 'support-part');

  assert.ok(parsedModel);
  assert.equal(parsedModel.isSupportGeometry, false);

  assert.ok(parsedSupport);
  assert.equal(parsedSupport.isSupportGeometry, true);
  assert.equal(parsedSupport.linkGroupId, 'link-group-split');
});

test('VOXL V2 binary round-trip persistence for split support model', async () => {
  const modelPart: VoxlModelRuntimeLike = {
    id: 'model-part-v2',
    name: 'Bracket (Model)',
    visible: true,
    color: '#a3a3a3',
    polygonCount: 1,
    transform: {
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'external-file', fileName: 'model-part-v2.stl' },
    isSupportGeometry: false,
  };

  const supportPart: VoxlModelRuntimeLike = {
    id: 'support-part-v2',
    name: 'Bracket (Supports)',
    visible: true,
    color: '#a3a3a3',
    polygonCount: 1,
    transform: {
      position: { x: 10, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'external-file', fileName: 'support-part-v2.stl' },
    isSupportGeometry: true,
    linkGroupId: 'link-group-v2',
  };

  const input: BuildVoxlDocumentInput = {
    models: [modelPart, supportPart],
    activeModelId: 'model-part-v2',
    selectedModelIds: ['model-part-v2', 'support-part-v2'],
    supports: EMPTY_SUPPORTS,
  };

  const dummyBytes1 = new Uint8Array([1, 2, 3, 4]);
  const dummyBytes2 = new Uint8Array([5, 6, 7, 8]);
  const meshBytes = new Map<number, Uint8Array>([
    [0, dummyBytes1],
    [1, dummyBytes2],
  ]);

  const binary = await serializeVoxlDocumentV2(input, meshBytes);
  const parsedResult = parseVoxlBinaryV2(binary);

  assert.equal(parsedResult.document.models.length, 2);
  const parsedModel = parsedResult.document.models.find((m) => m.id === 'model-part-v2');
  const parsedSupport = parsedResult.document.models.find((m) => m.id === 'support-part-v2');

  assert.ok(parsedModel);
  assert.equal(parsedModel.isSupportGeometry, false);

  assert.ok(parsedSupport);
  assert.equal(parsedSupport.isSupportGeometry, true);
  assert.equal(parsedSupport.linkGroupId, 'link-group-v2');
});
