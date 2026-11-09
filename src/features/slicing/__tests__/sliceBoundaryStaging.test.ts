import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { runSliceExportOrchestrator } from '../sliceExportOrchestrator';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';

function boxModel(id: string, x: number, y: number, z: number): LoadedModel {
  const source = new THREE.BoxGeometry(8, 6, 10);
  const geometry = source.toNonIndexed();
  source.dispose();
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  return {
    id, name: id, fileUrl: '', color: '#a3a3a3', visible: true, polygonCount: 12,
    geometry: { geometry, bbox, center: bbox.getCenter(new THREE.Vector3()), size: bbox.getSize(new THREE.Vector3()), flatteningPlanes: [] },
    transform: { position: new THREE.Vector3(x, y, z), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
  };
}

for (const transfer of ['single-shot', 'streamed'] as const) {
  test(`${transfer} staging preserves closed surfaces across plate borders and excludes disjoint models`, async () => {
    const models = [
      boxModel('center', 0, 0, 3),
      boxModel('left', -10, 0, 3),
      boxModel('right', 10, 0, 3),
      boxModel('front', 0, -10, 3),
      boxModel('back', 0, 10, 3),
    ];
    // Mirrored geometry must remain outward-wound after transform baking.
    models[2].transform.scale.x = -1;
    const support = boxModel('support', -10, 0, 19);
    support.isSupportGeometry = true;
    const outside = boxModel('outside', 30, 0, 50);
    const scene = [...models, support, outside];
    if (transfer === 'streamed') models[0].polygonCount = 16_000_000;

    const chunks: Uint8Array[] = [];
    let metadata: { model_triangle_count: number; total_layers: number; mesh_encoding: string } | undefined;
    const reachedSlicer = new Error('captured boundary staging input');
    const invoke = async (command: string, args?: unknown): Promise<unknown> => {
      switch (command) {
        case 'stage_mesh_binary_start':
          assert.equal(transfer, 'streamed');
          chunks.length = 0;
          return;
        case 'stage_mesh_binary_set':
          assert.equal(transfer, 'single-shot');
          chunks.length = 0;
          chunks.push(new Uint8Array(args as Uint8Array));
          return {};
        case 'stage_mesh_binary_chunk':
          assert.equal(transfer, 'streamed');
          chunks.push(new Uint8Array(args as Uint8Array));
          return {};
        case 'plugin:event|listen': return 1;
        case 'plugin:event|unlisten': return;
        case 'slice_solid_native_to_temp_path':
          assert.ok(args && typeof args === 'object' && 'jobJson' in args && typeof args.jobJson === 'string');
          metadata = JSON.parse(args.jobJson);
          throw reachedSlicer;
        default: throw new Error(`Unexpected native command: ${command}`);
      }
    };
    const restoreWindow = installFakeWindow({
      dispatchEvent: () => true,
      __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
    try {
      await assert.rejects(runSliceExportOrchestrator({
        models: scene,
        // No excludedModelIds: the orchestrator must independently reject the
        // disjoint model, without rejecting any of the four straddling ones.
        printerProfile: {
          id: 'boundary-printer', name: 'Boundary printer',
          buildVolumeMm: { width: 20, depth: 20, height: 20 },
          display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
        } as PrinterProfile,
        materialProfile: { id: 'boundary-material', name: 'Boundary material', layerHeightMm: 0.05 } as MaterialProfile,
        filenameBase: 'closed-boundaries', outputMode: 'return',
      }), reachedSlicer);
      assert.ok(metadata);
      assert.equal(metadata.mesh_encoding, 'raw_f32');
      assert.equal(metadata.model_triangle_count, 5 * 12);
      assert.equal(metadata.total_layers, 400, 'build height limits layers, not geometry coordinates');
      const bytes = Buffer.concat(chunks);
      const vertices = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      assert.equal(vertices.length, 6 * 12 * 9, 'five complete models and one support, without the fully-outside model');

      for (let object = 0; object < 6; object += 1) {
        const mesh = vertices.subarray(object * 108, (object + 1) * 108);
        const edges = new Map<string, number>();
        let volume6 = 0;
        for (let i = 0; i < mesh.length; i += 9) {
          const a = Array.from(mesh.subarray(i, i + 3));
          const b = Array.from(mesh.subarray(i + 3, i + 6));
          const c = Array.from(mesh.subarray(i + 6, i + 9));
          volume6 += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
          const points = [a.join(','), b.join(','), c.join(',')];
          for (let j = 0; j < 3; j += 1) {
            const start = points[j], end = points[(j + 1) % 3];
            const key = start < end ? `${start}|${end}` : `${end}|${start}`;
            edges.set(key, (edges.get(key) ?? 0) + (start < end ? 1 : -1));
          }
        }
        assert.ok([...edges.values()].every((count) => count === 0), `${scene[object].id}: open contour at a plate border`);
        assert.equal(volume6 / 6, 480, `${scene[object].id}: full volume and outward winding survive transport`);
      }
      const xs = Array.from(vertices).filter((_, i) => i % 3 === 0);
      const ys = Array.from(vertices).filter((_, i) => i % 3 === 1);
      const zs = Array.from(vertices).filter((_, i) => i % 3 === 2);
      assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-14, 14]);
      assert.deepEqual([Math.min(...ys), Math.max(...ys)], [-13, 13]);
      assert.deepEqual([Math.min(...zs), Math.max(...zs)], [-2, 24]);
    } finally {
      restoreWindow();
      for (const model of scene) model.geometry.geometry.dispose();
    }
  });
}
