import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { runSliceExportOrchestrator } from '../sliceExportOrchestrator';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';

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
  model.meshModifiers = {
    hollowing: { enabled: true, bakedIntoGeometry: false, mode: 'cavity', voxelSizeMm: 0.5, shellThicknessMm: 1, openFace: 'z_max' },
  };
  const supportModel = modelFromPositions('support', support);
  supportModel.isSupportGeometry = true;

  let staged = new Uint8Array(0);
  let streamedChunks = 0;
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
  try {
    await assert.rejects(runSliceExportOrchestrator({
      models: [model, supportModel],
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

    assert.ok(streamedChunks > 0, 'exercise the streamed transport, not single-shot replacement');
    assert.ok(captured);
    assert.equal(captured.modelCount, hollowed.length / 9);
    assert.equal(captured.bytes.length / 18, (hollowed.length + support.length) / 9,
      'native input must contain only the prepared scene, not a raw-f32 prefix');
    const expected = Uint16Array.from([...hollowed, ...support], (value, i) =>
      Math.round((value - (i % 3 === 2 ? 0 : -10)) / 20 * 65535));
    const received = new Uint16Array(captured.bytes.buffer, captured.bytes.byteOffset, captured.bytes.byteLength / 2);
    const split = captured.modelCount * 9;
    assert.deepEqual(received.subarray(0, split), expected.subarray(0, split), 'model coordinates remain in the model partition');
    assert.deepEqual(received.subarray(split), expected.subarray(split), 'only support coordinates enter the support partition');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    model.geometry.geometry.dispose();
    supportModel.geometry.geometry.dispose();
  }
});

test('native staged 3DAA contact geometry shrinks only generated contact faces', async () => {
  const model = modelFromPositions('tip-model', new Float32Array([-3, -3, 0, -2, -3, 0, -3, -2, 0]));
  const printerProfile = {
    id: 'tip-printer', name: 'Tip printer', bitDepth: { bits: 2 },
    buildVolumeMm: { width: 20, depth: 20, height: 20 },
    display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
  } as PrinterProfile;
  const materialProfile = { id: 'tip-material', name: 'Tip material', layerHeightMm: 0.05 } as MaterialProfile;
  const anchor = {
    id: 'tip-anchor', modelId: model.id,
    rootPos: { x: 0, y: 0, z: 0 }, rootBaseDiameter: 2, rootTopDiameter: 1.5, rootHeight: 1,
    joint: { id: 'tip-joint', pos: { x: 0, y: 0, z: 1.1 }, diameter: 1.5 },
    segments: [{
      id: 'tip-shaft', diameter: 0.8,
      bottomJoint: { id: 'tip-joint', pos: { x: 0, y: 0, z: 1.1 }, diameter: 1.5 },
      topJoint: { id: 'tip-shaft-end', pos: { x: 0, y: 0, z: 2.5 }, diameter: 0.8 },
    }],
    contactCone: {
      id: 'tip-cone', pos: { x: 0, y: 0, z: 5 },
      normal: { x: 0, y: 0, z: -1 }, surfaceNormal: { x: 0, y: 0, z: -1 },
      profile: {
        type: 'disk' as const, contactDiameterMm: 0.4, bodyDiameterMm: 1.4,
        lengthMm: 2, penetrationMm: 0.05, diskThicknessMm: 0.1,
        maxStandoffMm: 0.2, standoffAngleThreshold: Math.PI / 4,
      },
    },
  };
  const previousSupportState = getSnapshot();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let staged = new Uint8Array(0);
  let captured: { bytes: Uint8Array; modelCount: number } | undefined;
  const getCaptured = () => captured;
  const reachedSlicer = new Error('captured staged tip geometry');
  const invoke = async (command: string, args?: unknown): Promise<unknown> => {
    switch (command) {
      case 'stage_mesh_binary_set':
        assert.ok(args instanceof Uint8Array);
        staged = args.slice();
        return {};
      case 'plugin:event|listen':
        return 1;
      case 'plugin:event|unlisten':
        return;
      case 'slice_solid_native_to_temp_path': {
        assert.ok(args && typeof args === 'object' && 'jobJson' in args && typeof args.jobJson === 'string');
        const job = JSON.parse(args.jobJson);
        assert.equal(job.mesh_encoding, 'quantized_u16');
        assert.equal(Object.hasOwn(job, 'support_tip_shrink_percent'), false, 'tip shrink is geometry, not native metadata');
        assert.equal(Object.hasOwn(job, 'supportTipShrinkPercent'), false);
        captured = { bytes: staged.slice(), modelCount: job.model_triangle_count };
        throw reachedSlicer;
      }
      default:
        throw new Error(`Unexpected native command: ${command}`);
    }
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    },
  });
  try {
    setSnapshot({
      ...createEmptySupportCollections(), stumps: { [anchor.id]: anchor },
      selectedId: null, hoveredId: null, selectedCategory: null,
      hoveredCategory: 'none', interactionWarning: null,
    });
    const authoredAnchor = structuredClone(getSnapshot().stumps[anchor.id]);
    const step = printerProfile.buildVolumeMm.width / 65535;
    const dequantize = (value: number, axis: number) => value * step - (axis === 2 ? 0 : 10);
    const cases = [
      { mode: 'Vertical2', level: '8x', percent: undefined, diameter: 0.36 },
      { mode: 'Vertical2', level: '8x', percent: 25, diameter: 0.3 },
      { mode: '3DAA', level: '8x', percent: 25, diameter: 0.3 },
      { mode: 'Vertical2', level: '8x', percent: 0, diameter: 0.4 },
      { mode: 'Blur', level: '8x', percent: 25, diameter: 0.4 },
      { mode: 'Coverage', level: 'Off', percent: 25, diameter: 0.4 },
      { mode: 'Vertical2', level: 'Off', percent: 25, diameter: 0.4 },
    ] as const;
    let baselineModel: number[] | undefined;
    let baselineOtherSupport: number[] | undefined;
    let baselineContactZ: number | undefined;
    for (const { mode, level, percent, diameter } of cases) {
      staged = new Uint8Array(0);
      captured = undefined;
      await assert.rejects(runSliceExportOrchestrator({
        models: [model], printerProfile, materialProfile,
        filenameBase: 'staged-tip-regression', outputMode: 'return',
        antiAliasingMode: mode, antiAliasingLevel: level,
        supportTipShrinkPercent: percent, aaOnSupports: false,
      }), reachedSlicer);
      const received = getCaptured();
      assert.ok(received, `${mode}/${level}/${percent} reached the native slice boundary`);
      assert.equal(received.modelCount, 1);
      assert.ok(received.bytes.length > 18, 'staged mesh includes generated support triangles');
      const coordinates = new Uint16Array(received.bytes.buffer, received.bytes.byteOffset, received.bytes.byteLength / 2);
      const modelCoordinates = Array.from(coordinates.subarray(0, received.modelCount * 9));
      const supportCoordinates = coordinates.subarray(received.modelCount * 9);
      const contactZ = Math.max(...Array.from(supportCoordinates).filter((_, i) => i % 3 === 2));
      const contactX: number[] = [];
      const otherSupport: number[] = [];
      for (let i = 0; i < supportCoordinates.length; i += 3) {
        if (supportCoordinates[i + 2] === contactZ) contactX.push(dequantize(supportCoordinates[i], 0));
        else otherSupport.push(supportCoordinates[i], supportCoordinates[i + 1], supportCoordinates[i + 2]);
      }
      assert.ok(contactX.length > 0, 'contact-plane vertices are staged');
      assert.ok(Math.abs(dequantize(contactZ, 2) - 5) <= step, 'measured plane belongs to the contact face');
      assert.ok(Math.abs(Math.max(...contactX) - Math.min(...contactX) - diameter) <= 2 * step,
        `${mode}/${level}/${percent}: contact diameter ${diameter} mm within a step per coordinate`);
      if (baselineModel) {
        assert.deepEqual(modelCoordinates, baselineModel, 'model triangles stay unchanged');
        assert.deepEqual(otherSupport, baselineOtherSupport, 'root, shaft and socket-ring geometry stays unchanged');
        assert.equal(contactZ, baselineContactZ, 'contact position and penetration stay unchanged');
      } else {
        baselineModel = modelCoordinates;
        baselineOtherSupport = otherSupport;
        baselineContactZ = contactZ;
        for (const z of [0, 1, 1.1, 2.5, 2.8]) {
          assert.ok(otherSupport.some((_, i) => i % 3 === 2 && Math.abs(dequantize(otherSupport[i], 2) - z) <= step),
            `root, shaft and socket ring include z=${z} mm`);
        }
      }
      assert.deepEqual(getSnapshot().stumps[anchor.id], authoredAnchor, 'staging does not modify authored support');
    }
  } finally {
    setSnapshot(previousSupportState);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    model.geometry.geometry.dispose();
  }
});
