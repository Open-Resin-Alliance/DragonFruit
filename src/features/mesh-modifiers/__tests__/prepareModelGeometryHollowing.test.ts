import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { prepareModelGeometryForOutput } from '../prepareModelGeometry';

type InvokeCall = { cmd: string; args: unknown };

// Installs a fake Tauri IPC boundary. `@tauri-apps/api/core`'s `invoke` reads
// `window.__TAURI_INTERNALS__.invoke(cmd, args, options)` at call time
// (node_modules/@tauri-apps/api/core.js:202), and meshHollowing.ts's
// isTauriRuntime()/loadTauriCore() check lazily at call time, so re-installing
// the window per test is sufficient even though loadTauriCore module-caches its
// promise. Command names mirror the real hollowFromGeometry sequence
// (meshHollowing.ts:199-212).
function installFakeTauri(): InvokeCall[] {
  const calls: InvokeCall[] = [];
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const invoke = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'stage_mesh_binary_set':
        return undefined;
      case 'mesh_hollow_staged':
        return JSON.stringify({ removedVoxels: 10 });
      case 'mesh_repair_read_positions':
        return new Uint8Array(positions.buffer.slice(0));
      case 'mesh_hollow_staged_read_cavity_positions':
        return new Uint8Array(0);
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  return calls;
}

function buildHollowedModel(
  rotation: THREE.Euler,
  blockedVoxelIndices: number[],
  scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1),
): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 2, 0, 0, 0, 2, 0,
  ], 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  return {
    id: 'hollow-model',
    name: 'hollow-model.stl',
    visible: true,
    polygonCount: 1,
    geometry: {
      geometry,
      bbox,
      center: bbox.getCenter(new THREE.Vector3()),
      size: bbox.getSize(new THREE.Vector3()),
      flatteningPlanes: [],
    },
    transform: {
      position: new THREE.Vector3(),
      rotation,
      scale,
    },
    meshModifiers: {
      hollowing: {
        enabled: true,
        bakedIntoGeometry: false,
        blockedVoxelIndices,
        mode: 'cavity',
        voxelSizeMm: 0.5,
        shellThicknessMm: 2,
        openFace: 'z_max',
      },
    },
  } as unknown as LoadedModel;
}

test('slice-time hollowing forwards painted blocked voxel indices', async () => {
  const calls = installFakeTauri();
  try {
    const model = buildHollowedModel(new THREE.Euler(0, 0, 0), [3, 5, 8]);
    await prepareModelGeometryForOutput(model);

    const hollowCall = calls.find((call) => call.cmd === 'mesh_hollow_staged');
    assert.ok(hollowCall, 'expected mesh_hollow_staged to be invoked');
    const options = JSON.parse(
      (hollowCall.args as { optionsJson: string }).optionsJson,
    ) as { blockedVoxelIndices?: number[] };
    assert.deepEqual(
      options.blockedVoxelIndices,
      [3, 5, 8],
      'painted blockers must reach the slice-time hollow, not be silently dropped',
    );
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('slice-time hollow cache misses when the model rotation changes', async () => {
  const calls = installFakeTauri();
  try {
    const modelA = buildHollowedModel(new THREE.Euler(0, 0, 0), []);
    await prepareModelGeometryForOutput(modelA);

    // Same geometry object (same uuid/versions), different rotation — today
    // this is a cache HIT and the stale-orientation cavity is served.
    const modelB = {
      ...modelA,
      transform: {
        ...modelA.transform,
        rotation: new THREE.Euler(0, 0, Math.PI / 2),
      },
    } as LoadedModel;
    await prepareModelGeometryForOutput(modelB);

    const hollowCalls = calls.filter((call) => call.cmd === 'mesh_hollow_staged');
    assert.equal(
      hollowCalls.length,
      2,
      'rotating the model must invalidate the prepared-geometry cache',
    );
    const optionsB = JSON.parse(
      (hollowCalls[1].args as { optionsJson: string }).optionsJson,
    ) as { rotationQuat?: number[] };
    assert.ok(
      Math.abs((optionsB.rotationQuat?.[2] ?? 0) - Math.sin(Math.PI / 4)) < 1e-6,
      'second hollow must be computed at the new rotation',
    );
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('slice-time hollow cache misses when the painted blockers change', async () => {
  const calls = installFakeTauri();
  try {
    const modelA = buildHollowedModel(new THREE.Euler(0, 0, 0), [1, 2]);
    await prepareModelGeometryForOutput(modelA);

    // Same geometry object + rotation, different painted blockers. Today the
    // signature ignores blockedVoxelIndices → cache HIT → the previous cavity
    // (computed without the new blockers) is served.
    const modelB = {
      ...modelA,
      meshModifiers: {
        hollowing: {
          ...(modelA.meshModifiers?.hollowing ?? {}),
          blockedVoxelIndices: [1, 2, 3],
        },
      },
    } as LoadedModel;
    await prepareModelGeometryForOutput(modelB);

    const hollowCalls = calls.filter((call) => call.cmd === 'mesh_hollow_staged');
    assert.equal(
      hollowCalls.length,
      2,
      'changing painted blockers must invalidate the prepared-geometry cache',
    );
    const optionsB = JSON.parse(
      (hollowCalls[1].args as { optionsJson: string }).optionsJson,
    ) as { blockedVoxelIndices?: number[] };
    assert.deepEqual(optionsB.blockedVoxelIndices, [1, 2, 3]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('slice-time hollow converts world-mm params to local-mm on scaled models', async () => {
  const calls = installFakeTauri();
  try {
    // Uniform scale ×2: the voxel grid lives in local space, so a 2 mm world
    // shell must be forwarded as a 1 mm local shell — the same conversion the
    // preview and Apply paths already apply. Today the raw world value leaks
    // through, painting blockers onto a mismatched grid on scaled models.
    const model = buildHollowedModel(
      new THREE.Euler(0, 0, 0),
      [],
      new THREE.Vector3(2, 2, 2),
    );
    await prepareModelGeometryForOutput(model);

    const hollowCall = calls.find((call) => call.cmd === 'mesh_hollow_staged');
    assert.ok(hollowCall, 'expected mesh_hollow_staged to be invoked');
    const options = JSON.parse(
      (hollowCall.args as { optionsJson: string }).optionsJson,
    ) as { shellThicknessMm?: number };
    assert.ok(
      Math.abs((options.shellThicknessMm ?? 0) - 1) < 1e-9,
      `scaled-model shell must be world→local converted (expected 1, got ${options.shellThicknessMm})`,
    );
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
