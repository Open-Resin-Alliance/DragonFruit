import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { storeModelMeshModifiers, deleteStoredMeshModifiers } from '@/features/mesh-modifiers/meshModifierStore';
import { clearPreparedGeometryCacheForModel } from '@/features/mesh-modifiers/prepareModelGeometry';
import { runSliceExportOrchestrator } from '../sliceExportOrchestrator';

function modelFromPositions(id: string, positions: Float32Array): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const center = bbox.getCenter(new THREE.Vector3());
  return {
    id,
    name: id,
    fileUrl: '',
    color: '#a3a3a3',
    visible: true,
    polygonCount: positions.length / 9,
    geometry: { geometry, bbox, center, size: bbox.getSize(new THREE.Vector3()), flatteningPlanes: [] },
    transform: { position: center.clone(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
  };
}

test('streamed slice input excludes raw hollowing output and preserves the model/support partition', async () => {
  const original = new Float32Array([-2, -2, 0, 2, -2, 0, 0, 2, 0]);
  const hollowed = new Float32Array([...original, -1, -1, 0, 1, -1, 0, 0, 1, 0]);
  const support = new Float32Array([3, 3, 0, 4, 3, 0, 3, 4, 0]);
  const model = modelFromPositions('pending-hollow', original);
  // The transport planner uses this estimate. Force streaming without allocating
  // a multi-million-triangle fixture; the collector reads the actual geometry.
  model.polygonCount = 16_000_000;
  const hollowing = { enabled: true, bakedIntoGeometry: false, mode: 'cavity', voxelSizeMm: 0.5, shellThicknessMm: 1, openFace: 'z_max' } as const;
  storeModelMeshModifiers(model.id, { hollowing });
  const redoneModel = modelFromPositions(model.id, hollowed);
  redoneModel.polygonCount = model.polygonCount;
  const supportModel = modelFromPositions('support', support);
  supportModel.isSupportGeometry = true;

  let staged = new Uint8Array(0);
  let streamedChunks = 0;
  let hollowCalls = 0;
  let captured: { bytes: Uint8Array; modelCount: number } | undefined;
  const reachedSlicer = new Error('captured native slice input');
  const invoke = async (command: string, args?: unknown): Promise<unknown> => {
    switch (command) {
      case 'stage_mesh_binary_start':
        staged = new Uint8Array(0);
        return;
      case 'stage_mesh_binary_set':
        staged = new Uint8Array(args as Uint8Array);
        return {};
      case 'mesh_hollow_staged':
        hollowCalls += 1;
        // Native hollowing replaces the shared stage with raw f32 output.
        staged = new Uint8Array(hollowed.buffer.slice(0));
        return JSON.stringify({ removedVoxels: 1 });
      case 'mesh_repair_read_positions':
        // Reading positions copies, rather than consumes, that shared buffer.
        return staged.slice();
      case 'mesh_hollow_staged_read_cavity_positions':
        return new Uint8Array(0);
      case 'stage_mesh_binary_chunk': {
        const chunk = args as Uint8Array;
        const next = new Uint8Array(staged.length + chunk.length);
        next.set(staged);
        next.set(chunk, staged.length);
        staged = next;
        streamedChunks += 1;
        return {};
      }
      case 'plugin:event|listen':
        return 1;
      case 'plugin:event|unlisten':
        return;
      case 'slice_solid_native_to_temp_path': {
        const metadata = JSON.parse((args as { jobJson: string }).jobJson);
        assert.equal(metadata.mesh_encoding, 'quantized_u16');
        captured = { bytes: staged.slice(), modelCount: metadata.model_triangle_count };
        throw reachedSlicer;
      }
      default:
        throw new Error(`Unexpected native command: ${command}`);
    }
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    },
  });
  const stage = async (currentModel: LoadedModel) => {
    await assert.rejects(runSliceExportOrchestrator({
      models: [currentModel, supportModel],
      printerProfile: {
        id: 'staging-printer', name: 'Staging printer',
        buildVolumeMm: { width: 20, depth: 20, height: 20 },
        display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
      } as PrinterProfile,
      materialProfile: { id: 'staging-material', name: 'Staging material', layerHeightMm: 0.05 } as MaterialProfile,
      filenameBase: 'staging-regression',
      outputMode: 'return',
      antiAliasingMode: 'Vertical2',
      antiAliasingLevel: '8x',
      aaOnSupports: false,
    }), reachedSlicer);
    assert.ok(captured);
    return captured;
  };
  try {
    const first = await stage(model);

    assert.ok(streamedChunks > 0, 'exercise the streamed transport, not single-shot replacement');
    assert.equal(hollowCalls, 1);
    assert.equal(first.modelCount, hollowed.length / 9);
    assert.equal(first.bytes.length / 18, (hollowed.length + support.length) / 9,
      'native input must contain only the prepared scene, not a raw-f32 prefix');
    const expected = Uint16Array.from([...hollowed, ...support], (value, i) =>
      Math.round((value - (i % 3 === 2 ? 0 : -10)) / 20 * 65535));
    const received = new Uint16Array(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength / 2);
    const split = first.modelCount * 9;
    assert.deepEqual(received.subarray(0, split), expected.subarray(0, split), 'model coordinates remain in the model partition');
    assert.deepEqual(received.subarray(split), expected.subarray(split), 'only support coordinates enter the support partition');

    storeModelMeshModifiers(model.id, { hollowing: { ...hollowing, enabled: false, bakedIntoGeometry: false } });
    clearPreparedGeometryCacheForModel(model.id);
    const restored = await stage(model);
    const originalEncoded = Uint16Array.from([...original, ...support], (value, i) =>
      Math.round((value - (i % 3 === 2 ? 0 : -10)) / 20 * 65535));
    assert.equal(restored.modelCount, original.length / 9);
    assert.deepEqual(new Uint16Array(restored.bytes.buffer, restored.bytes.byteOffset, restored.bytes.byteLength / 2), originalEncoded);
    assert.equal(hollowCalls, 1, 'undo must not rebake the removed shell');

    storeModelMeshModifiers(model.id, { hollowing: { ...hollowing, bakedIntoGeometry: true } });
    const redone = await stage(redoneModel);
    assert.equal(redone.modelCount, hollowed.length / 9);
    assert.deepEqual(new Uint16Array(redone.bytes.buffer, redone.bytes.byteOffset, redone.bytes.byteLength / 2), expected);
    assert.equal(hollowCalls, 1, 'redo uses the previously baked model geometry');

    storeModelMeshModifiers(model.id, { hollowing: { ...hollowing, enabled: false } });
    const removed = await stage(model);
    assert.deepEqual(new Uint16Array(removed.bytes.buffer, removed.bytes.byteOffset, removed.bytes.byteLength / 2), originalEncoded);
    assert.equal(hollowCalls, 1, 'Remove Hollowing must not rebake the shell');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    model.geometry.geometry.dispose();
    supportModel.geometry.geometry.dispose();
    redoneModel.geometry.geometry.dispose();
    clearPreparedGeometryCacheForModel(model.id);
    deleteStoredMeshModifiers(model.id);
  }
});
