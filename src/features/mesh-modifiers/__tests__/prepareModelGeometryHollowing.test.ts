import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { snapshotGeometryPositions } from '@/utils/geometrySnapshot';
import { clearPreparedGeometryCacheForModel, prepareLoadedModelsForOutput, prepareModelGeometryForOutput } from '../prepareModelGeometry';
import type { PreparedLoadedModelsForOutput } from '../prepareModelGeometry';
import { deleteStoredMeshModifiers, storeModelMeshModifiers } from '../meshModifierStore';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';

type InvokeCall = { cmd: string; args: unknown };

// Native hollowing produces a smaller shell; uploads use the real worker body.
function installFakeTauri(onHollow?: (source: Float32Array) => Promise<Float32Array>) {
  const calls: InvokeCall[] = [];
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const upload = installFakeMeshChunkUpload(async (cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'mesh_hollow_staged': {
        const source = upload.readStaged();
        const output = onHollow
          ? await onHollow(new Float32Array(source.buffer, source.byteOffset, source.byteLength / 4))
          : positions;
        upload.replaceStaged(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
        return JSON.stringify({ removedVoxels: 10 });
      }
      case 'mesh_repair_read_positions':
        return upload.readStaged();
      case 'mesh_hollow_staged_read_cavity_positions':
        return new Uint8Array(0);
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
  const restoreWindow = installFakeWindow({ __TAURI_INTERNALS__: { invoke: upload.invoke } });
  return {
    calls,
    restore: () => {
      restoreWindow();
      upload.restore();
    },
  };
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
        ...snapshotGeometryPositions(geometry),
        blockedVoxelIndices,
        mode: 'cavity',
        voxelSizeMm: 0.5,
        shellThicknessMm: 2,
        openFace: 'z_max',
      },
    },
  } as unknown as LoadedModel;
}

test('flags-only hollowing leaves the restored model solid at output', async () => {
  const { calls, restore } = installFakeTauri();
  const model = buildHollowedModel(new THREE.Euler(), []);
  const source = model.meshModifiers?.hollowing;
  assert.ok(source);
  model.meshModifiers = undefined;
  try {
    storeModelMeshModifiers(model.id, {
      hollowing: { ...source, sourcePositionsBase64: undefined, sourcePositionCount: undefined },
    });
    const prepared = await prepareModelGeometryForOutput(model);
    assert.equal(prepared.geometry, model.geometry.geometry);
    assert.equal(prepared.disposeAfterUse, false);
    assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 0);
  } finally {
    clearPreparedGeometryCacheForModel(model.id);
    deleteStoredMeshModifiers(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});

test('slice-time hollowing forwards painted blocked voxel indices', async () => {
  const { calls, restore } = installFakeTauri();
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
    restore();
  }
});

test('slice-time hollow cache misses when the model rotation changes', async () => {
  const { calls, restore } = installFakeTauri();
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
    restore();
  }
});

test('slice-time hollow cache misses when the painted blockers change', async () => {
  const { calls, restore } = installFakeTauri();
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
    restore();
  }
});

test('slice-time hollow converts world-mm params to local-mm on scaled models', async () => {
  const { calls, restore } = installFakeTauri();
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
    restore();
  }
});

test('undo releases only the reversed model\'s prepared shell before another bake', async () => {
  const { calls, restore } = installFakeTauri();
  const model = buildHollowedModel(new THREE.Euler(), []);
  const other = { ...buildHollowedModel(new THREE.Euler(), []), id: 'other-hollow-model' } as LoadedModel;
  const hollowing = model.meshModifiers?.hollowing;
  assert.ok(hollowing);
  model.meshModifiers = undefined;
  other.meshModifiers = undefined;
  storeModelMeshModifiers(model.id, { hollowing });
  storeModelMeshModifiers(other.id, { hollowing });
  const bake = async (target: LoadedModel) => {
    const result = await prepareModelGeometryForOutput(target);
    const attribute = result.geometry.getAttribute('position');
    assert.ok(attribute);
    const positions = Array.from(attribute.array);
    if (result.disposeAfterUse) result.geometry.dispose();
    return positions;
  };
  const hollowCalls = () => calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length;
  try {
    const shell = await bake(model);
    assert.deepEqual(shell, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    await bake(other);
    assert.equal(hollowCalls(), 2);

    storeModelMeshModifiers(model.id, { hollowing: { ...hollowing, enabled: false, bakedIntoGeometry: false } });
    clearPreparedGeometryCacheForModel(model.id);
    const originalPositions = model.geometry.geometry.getAttribute('position');
    assert.ok(originalPositions);
    assert.deepEqual(await bake(model), Array.from(originalPositions.array));
    assert.equal(hollowCalls(), 2, 'restored solid must not be baked');

    storeModelMeshModifiers(model.id, { hollowing });
    assert.deepEqual(await bake(model), shell);
    assert.equal(hollowCalls(), 3, 're-enabled hollow must not reuse the discarded shell');
    assert.deepEqual(await bake(other), shell);
    assert.equal(hollowCalls(), 3, 'other model cache remains valid');
  } finally {
    clearPreparedGeometryCacheForModel(model.id);
    clearPreparedGeometryCacheForModel(other.id);
    deleteStoredMeshModifiers(model.id);
    deleteStoredMeshModifiers(other.id);
    model.geometry.geometry.dispose();
    other.geometry.geometry.dispose();
    restore();
  }
});


function replaceSourcePositions(model: LoadedModel, positions: number[]): void {
  const geometry = model.geometry.geometry;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox?.clone() ?? new THREE.Box3();
  model.geometry.bbox = bbox;
  model.geometry.center = bbox.getCenter(new THREE.Vector3());
  model.geometry.size = bbox.getSize(new THREE.Vector3());
}

function classifiedModel(id: string): LoadedModel {
  const model = buildHollowedModel(new THREE.Euler(), []);
  model.id = id;
  replaceSourcePositions(model, [
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    4, 0, 0, 6, 0, 0, 4, 2, 0,
    10, 0, 0, 12, 0, 0, 10, 2, 0,
  ]);
  const classified = {
    ...model,
    polygonCount: 3,
    geometry: {
      ...model.geometry,
      meshDefects: {
        hasDefects: false,
        repairedFloats: 0,
        totalVertices: 9,
        nativeRepairReport: { model_triangle_count: 2, likely_support_geometry: false },
      },
    },
  } as unknown as LoadedModel;
  return classified;
}

test('nine unchanged classified models reuse shells across fresh split geometries and selection changes', async () => {
  const { calls, restore } = installFakeTauri(async (source) => source.map((value) => value * 0.5));
  const models = Array.from({ length: 9 }, (_, i) => classifiedModel(`split-cache-${i}`));
  let bakes = 0;
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const selectedModels = models.map((model) => ({ ...model, isSelected: pass === 1 }));
      const prepared = await prepareLoadedModelsForOutput(selectedModels, { onBake: () => { bakes += 1; } });
      try {
        assert.equal(prepared.models.length, 18);
        assert.equal(prepared.modifiedModelCount, 9);
        for (let i = 0; i < 9; i += 1) {
          const shell = prepared.models[i * 2];
          const support = prepared.models[i * 2 + 1];
          assert.deepEqual(Array.from(shell.geometry.geometry.getAttribute('position').array), [
            0, 0, 0, 1, 0, 0, 0, 1, 0,
            2, 0, 0, 3, 0, 0, 2, 1, 0,
          ]);
          assert.deepEqual(Array.from(support.geometry.geometry.getAttribute('position').array), [
            10, 0, 0, 12, 0, 0, 10, 2, 0,
          ]);
          assert.equal(support.isSupportGeometry, true);
          assert.notEqual(shell.geometry.geometry, models[i].geometry.geometry);
          shell.geometry.geometry.getAttribute('position').array.fill(123);
        }
      } finally {
        prepared.dispose();
      }
    }
    assert.equal(bakes, 9, 'cache hits must not report or perform modifier work');
    assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 9);
    assert.deepEqual(Array.from(models[0].geometry.geometry.getAttribute('position').array).slice(0, 9), [
      0, 0, 0, 2, 0, 0, 0, 2, 0,
    ], 'neither output mutation nor disposal may modify source storage');
  } finally {
    for (const model of models) {
      clearPreparedGeometryCacheForModel(model.id);
      model.geometry.geometry.dispose();
    }
    restore();
  }
});

test('exact effective options, attribute/buffer swaps and revisions invalidate prepared shells', async () => {
  const { calls, restore } = installFakeTauri(async (source) => source.map((value) => value * 0.5));
  const model = buildHollowedModel(new THREE.Euler(), []);
  model.id = 'exact-input-cache';
  let bakes = 0;
  const bake = async () => {
    const result = await prepareModelGeometryForOutput(model, { onBake: () => { bakes += 1; } });
    try { return Array.from(result.geometry.getAttribute('position').array); }
    finally { if (result.disposeAfterUse) result.geometry.dispose(); }
  };
  try {
    assert.deepEqual(await bake(), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    await bake();
    assert.equal(bakes, 1);
    model.transform.rotation.z = 1e-8;
    await bake();
    assert.equal(bakes, 2, 'sub-quantization rotation is still a different native option');
    model.transform.scale.setScalar(1 + 1e-8);
    await bake();
    assert.equal(bakes, 3, 'scale must not be rounded to six decimal places');
    const hollowing = model.meshModifiers?.hollowing;
    assert.ok(hollowing);
    hollowing.shellThicknessMm += 1e-8;
    await bake();
    assert.equal(bakes, 4);
    const geometry = model.geometry.geometry;
    const originalAttribute = geometry.getAttribute('position');
    const replacement = new THREE.Float32BufferAttribute([0, 0, 0, 4, 0, 0, 0, 4, 0], 3);
    geometry.setAttribute('position', replacement);
    assert.deepEqual(await bake(), [0, 0, 0, 2, 0, 0, 0, 2, 0]);
    assert.equal(bakes, 5, 'same-count/version attribute replacement must invalidate');
    assert.notEqual(originalAttribute, replacement);
    replacement.array = new Float32Array([0, 0, 0, 6, 0, 0, 0, 6, 0]);
    assert.deepEqual(await bake(), [0, 0, 0, 3, 0, 0, 0, 3, 0]);
    assert.equal(bakes, 6, 'same attribute with swapped storage must invalidate');
    replacement.needsUpdate = true;
    await bake();
    assert.equal(bakes, 7);
    geometry.setIndex([0, 1, 2]);
    await bake();
    assert.equal(bakes, 8);
    geometry.setIndex([0, 2, 1]);
    assert.deepEqual(await bake(), [0, 0, 0, 0, 3, 0, 3, 0, 0]);
    assert.equal(bakes, 9, 'same-count/version index replacement must invalidate');
    assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 9);
  } finally {
    clearPreparedGeometryCacheForModel(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});

test('changing classification boundary invalidates only the derived model partition', async () => {
  const { calls, restore } = installFakeTauri(async (source) => source.map((value) => value * 0.5));
  const model = classifiedModel('partition-cache');
  const bake = async () => {
    const result = await prepareLoadedModelsForOutput([model]);
    try {
      return result.models.map((part) => ({
        support: part.isSupportGeometry,
        positions: Array.from(part.geometry.geometry.getAttribute('position').array),
      }));
    } finally { result.dispose(); }
  };
  try {
    assert.equal((await bake())[0].positions.length, 18);
    const report = model.geometry.meshDefects?.nativeRepairReport;
    assert.ok(report);
    report.model_triangle_count = 1;
    const changed = await bake();
    assert.deepEqual(changed[0].positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.equal(changed[1].positions.length, 18);
    assert.equal(changed[1].support, true);
    await bake();
    assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 2);
  } finally {
    clearPreparedGeometryCacheForModel(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});

function bakeGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await ready; } };
}

test('concurrent prewarm and export of identical split sources share one native bake', async () => {
  const gate = bakeGate();
  const { calls, restore } = installFakeTauri(async (source) => {
    await gate.wait();
    return source.map((value) => value * 0.5);
  });
  const model = classifiedModel('concurrent-split-cache');
  let bakes = 0;
  try {
    const options = { onBake: () => { bakes += 1; } };
    const prewarm = prepareLoadedModelsForOutput([model], options);
    const clicked = prepareLoadedModelsForOutput([model], options);
    await gate.entered;
    gate.release();
    const [first, second] = await Promise.all([prewarm, clicked]);
    try {
      const a = first.models[0].geometry.geometry.getAttribute('position').array;
      const b = second.models[0].geometry.geometry.getAttribute('position').array;
      assert.deepEqual(a, b);
      assert.notEqual(a.buffer, b.buffer);
      a.fill(999);
      assert.equal(b[3], 1);
      assert.equal(bakes, 1);
      assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 1);
    } finally { first.dispose(); second.dispose(); }
  } finally {
    gate.release();
    clearPreparedGeometryCacheForModel(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});

test('clear during native work prevents stale completion from restoring the shell cache', async () => {
  const gate = bakeGate();
  const { calls, restore } = installFakeTauri(async (source) => {
    await gate.wait();
    return source.map((value) => value * 0.5);
  });
  const model = buildHollowedModel(new THREE.Euler(), []);
  model.id = 'clear-native-cache';
  let bakes = 0;
  const bake = () => prepareModelGeometryForOutput(model, { onBake: () => { bakes += 1; } });
  try {
    const stale = bake();
    await gate.entered;
    clearPreparedGeometryCacheForModel(model.id);
    const fresh = bake();
    gate.release();
    const results = await Promise.all([stale, fresh]);
    for (const result of results) {
      assert.deepEqual(Array.from(result.geometry.getAttribute('position').array), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
      result.geometry.dispose();
    }
    const cached = await bake();
    cached.geometry.dispose();
    assert.equal(bakes, 2, 'fresh request must not join an invalidated flight');
    assert.equal(calls.filter(({ cmd }) => cmd === 'mesh_hollow_staged').length, 2);
  } finally {
    gate.release();
    clearPreparedGeometryCacheForModel(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});


test('non-Desktop hollowing preserves the source and never reports a native bake', async () => {
  const restore = installFakeWindow({});
  const model = buildHollowedModel(new THREE.Euler(), []);
  model.id = 'browser-no-bake';
  const original = Array.from(model.geometry.geometry.getAttribute('position').array);
  let bakes = 0;
  try {
    await assert.rejects(
      prepareModelGeometryForOutput(model, { onBake: () => { bakes += 1; } }),
      /only available in DragonFruit Desktop/,
    );
    assert.equal(bakes, 0);
    assert.deepEqual(Array.from(model.geometry.geometry.getAttribute('position').array), original);
  } finally {
    clearPreparedGeometryCacheForModel(model.id);
    model.geometry.geometry.dispose();
    restore();
  }
});


test('a copied partition revision cannot be cached under a source edited while another model bakes', { timeout: 10_000 }, async () => {
  const gate = bakeGate();
  let first = true;
  const { restore } = installFakeTauri(async source => {
    if (first) { first = false; await gate.wait(); }
    return source.map(value => value * 0.5);
  });
  const a = classifiedModel('partition-race-a');
  const b = classifiedModel('partition-race-b');
  let prepared: PreparedLoadedModelsForOutput | undefined;
  try {
    const pending = prepareLoadedModelsForOutput([a, b]);
    await gate.entered; // Both classified partitions were copied before A's await.
    const position = b.geometry.geometry.getAttribute('position');
    position.setX(3, 4.25); // Interior edit: bounds and classification stay identical.
    position.needsUpdate = true;
    gate.release();
    prepared = await pending;
    const current = await prepareLoadedModelsForOutput([b]);
    try {
      const output = current.models[0].geometry.geometry.getAttribute('position').array;
      assert.equal(output[9], 2.125, 'the current shell must contain the edited source, not a stale copied partition');
      assert.deepEqual(Array.from(output), Array.from(position.array).slice(0, 18).map(value => value * 0.5));
    } finally { current.dispose(); }
  } finally {
    gate.release(); prepared?.dispose();
    for (const model of [a, b]) { clearPreparedGeometryCacheForModel(model.id); model.geometry.geometry.dispose(); }
    restore();
  }
});


test('cancelled batch finishes only its active native model and skips later modifier work', { timeout: 10_000 }, async () => {
  const gate = bakeGate();
  let bakes = 0;
  const { restore } = installFakeTauri(async source => {
    if (++bakes === 1) await gate.wait();
    return source.map(value => value * 0.5);
  });
  const models = [classifiedModel('cancel-batch-a'), classifiedModel('cancel-batch-b')];
  const controller = new AbortController();
  try {
    const pending = prepareLoadedModelsForOutput(models, { signal: controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await gate.entered;
    controller.abort(); gate.release();
    await cancelled;
    assert.equal(bakes, 1, 'cancellation must prevent starting the next model, not just discard its result');
    const next = await prepareLoadedModelsForOutput([models[1]]);
    try {
      assert.deepEqual(Array.from(next.models[0].geometry.geometry.getAttribute('position').array),
        Array.from(models[1].geometry.geometry.getAttribute('position').array).slice(0, 18).map(value => value * 0.5));
    } finally { next.dispose(); }
  } finally {
    gate.release();
    for (const model of models) { clearPreparedGeometryCacheForModel(model.id); model.geometry.geometry.dispose(); }
    restore();
  }
});
