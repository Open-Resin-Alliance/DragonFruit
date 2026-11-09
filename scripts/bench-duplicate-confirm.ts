#!/usr/bin/env npx tsx
/**
 * Duplicate-confirm performance benchmark.
 *
 * The "Confirm Duplicate (N new)" button ends in
 * `duplicateModelWithTransforms`, which (per created copy) clones the source
 * model's supports into the scene support store:
 *
 *   captureModelSupportsToClipboard(source)
 *   → captureSceneSnapshot(before, includeSupportState)   // structuredClone(state)
 *   → pasteModelSupports(N targets)                       // one merge + one store write
 *   → captureSceneSnapshot(after, includeSupportState)    // structuredClone(state)
 *
 * This measures those pieces against a synthetic scene of MODELS models ×
 * SUPPORTS supports, for several copy counts, and against the per-copy paste it
 * replaced, so the whole-state terms (`O(total)`) are separable from the
 * per-copy ones (`O(supports of source)`).
 *
 * Usage:  npx tsx scripts/bench-duplicate-confirm.ts
 * Env:    MODELS (default 20), SUPPORTS (default 150), DUPS (default 1,2,4,8,16)
 */

import * as THREE from 'three';
import {
  cloneSupportState,
  getSnapshot,
  resetStore,
  setSnapshot,
  transformSupportsForModel,
} from '../src/supports/state';
import {
  captureModelSupportsToClipboard,
  pasteModelSupports,
  pasteModelSupportsFromClipboard,
  type SupportClipboardPayload,
} from '../src/supports/PlacementLogic/supportClipboard';
import type { Knot, Roots, SupportState, Trunk } from '../src/supports/types';

const MODELS = Number(process.env.MODELS ?? 20);
const SUPPORTS_PER_MODEL = Number(process.env.SUPPORTS ?? 150);
const DUP_COUNTS = (process.env.DUPS ?? '1,2,4,8,16').split(',').map(Number);
const SOURCE_MODEL_ID = 'model-0';
const COLLECTION_KEYS = [
  'roots', 'knots', 'trunks', 'branches', 'leaves',
  'twigs', 'sticks', 'braces', 'stumps', 'kickstands',
];

function buildSceneState(): SupportState {
  const roots: Record<string, Roots> = {};
  const knots: Record<string, Knot> = {};
  const trunks: Record<string, Trunk> = {};

  for (let m = 0; m < MODELS; m += 1) {
    const modelId = `model-${m}`;
    for (let i = 0; i < SUPPORTS_PER_MODEL; i += 1) {
      const id = `trunk-${m}-${i}`;
      const segmentId = `${id}-s`;
      const x = i * 0.5;
      const y = m * 0.5;

      roots[`root-${m}-${i}`] = {
        id: `root-${m}-${i}`,
        modelId,
        transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.8,
        coneHeight: 1.2,
      };

      trunks[id] = {
        id,
        modelId,
        rootId: `root-${m}-${i}`,
        segments: [{
          id: segmentId,
          type: 'straight',
          diameter: 1,
          bottomJoint: { id: `${segmentId}-b`, pos: { x, y, z: 1 }, diameter: 1.1 },
          topJoint: { id: `${segmentId}-t`, pos: { x, y, z: 6 }, diameter: 1.1 },
        }],
        contactCone: {
          id: `${id}-cone`,
          pos: { x, y, z: 8 },
          normal: { x: 0, y: 0, z: 1 },
          surfaceNormal: { x: 0, y: 0, z: 1 },
          socketJointId: `${segmentId}-t`,
          profile: {
            contactDiameterMm: 0.4,
            bodyDiameterMm: 0.8,
            lengthMm: 3,
            penetrationMm: 0.05,
          },
        },
      };

      knots[`knot-${m}-${i}`] = {
        id: `knot-${m}-${i}`,
        parentShaftId: segmentId,
        t: 0.5,
        pos: { x, y, z: 4 },
        diameter: 1.1,
      };
    }
  }

  return { roots, knots, trunks } as unknown as SupportState;
}

function timed<T>(fn: () => T): { ms: number; value: T } {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

function countState(state: SupportState): number {
  let total = 0;
  for (const key of COLLECTION_KEYS) {
    const collection = (state as unknown as Record<string, Record<string, unknown> | undefined>)[key];
    if (collection) total += Object.keys(collection).length;
  }
  return total;
}

type RunResult = {
  dups: number;
  captureMs: number;
  cloneBeforeMs: number;
  cloneAfterMs: number;
  rawStructuredCloneMs: number;
  spreadCollectionsMs: number;
  pasteSingleMs: number;
  pasteBatchMs: number;
  transformMs: number;
  endStateEntities: number;
};

function buildTargets(dups: number, payload: SupportClipboardPayload) {
  const sourceTransform = {
    position: new THREE.Vector3(0, 0, 0),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  };
  return Array.from({ length: dups }, (_, i) => ({
    payload,
    targetModelId: `dup-${i}`,
    sourceTransform,
    targetTransform: {
      position: new THREE.Vector3(60 + i * 20, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  }));
}

function run(dups: number): RunResult {
  resetStore();
  setSnapshot(buildSceneState());

  const capture = timed(() => captureModelSupportsToClipboard(SOURCE_MODEL_ID));
  const payload = capture.value as SupportClipboardPayload;
  if (!payload) throw new Error('capture returned no payload');

  const cloneBefore = timed(() => cloneSupportState(getSnapshot()));
  const rawClone = timed(() => structuredClone(getSnapshot()));
  const spread = timed(() => {
    const state = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const copies = COLLECTION_KEYS.map((key) => ({ ...state[key] }));
    return copies.length;
  });

  // What the duplicate used to do: one paste call per copy, each with its own
  // state write. Each phase starts from its own fresh scene, built outside the
  // timer, so both see the same starting state.
  resetStore();
  setSnapshot(buildSceneState());
  const single = timed(() => {
    for (const target of buildTargets(dups, payload)) {
      pasteModelSupportsFromClipboard(
        target.payload,
        target.targetModelId,
        target.sourceTransform,
        target.targetTransform,
        { recordHistory: false },
      );
    }
  });

  // What it does now: every copy in one call, one state write.
  resetStore();
  setSnapshot(buildSceneState());
  const batch = timed(() => pasteModelSupports(buildTargets(dups, payload), { recordHistory: false }));

  const cloneAfter = timed(() => cloneSupportState(getSnapshot()));

  const transform = timed(() => transformSupportsForModel(
    SOURCE_MODEL_ID,
    {
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
    {
      position: new THREE.Vector3(0, 0, 10),
      rotation: new THREE.Euler(0, 0, 0),
      scale: new THREE.Vector3(1, 1, 1),
    },
  ));

  return {
    dups,
    captureMs: capture.ms,
    cloneBeforeMs: cloneBefore.ms,
    cloneAfterMs: cloneAfter.ms,
    rawStructuredCloneMs: rawClone.ms,
    spreadCollectionsMs: spread.ms,
    pasteSingleMs: single.ms,
    pasteBatchMs: batch.ms,
    transformMs: transform.ms,
    endStateEntities: countState(getSnapshot()),
  };
}

const RUNS = Number(process.env.RUNS ?? 3);

/** Best of several runs: each phase allocates hard enough that GC lands inside
 * a single-shot timing and doubles it. */
function bestOf(dups: number): RunResult {
  let best = run(dups);
  for (let i = 1; i < RUNS; i += 1) {
    const next = run(dups);
    const merged = { ...best };
    for (const key of Object.keys(best) as (keyof RunResult)[]) {
      if (typeof best[key] === 'number' && (next[key] as number) < (best[key] as number)) {
        (merged as Record<string, number>)[key] = next[key] as number;
      }
    }
    best = merged;
  }
  return best;
}

function main() {
  console.log(`scene: ${MODELS} models × ${SUPPORTS_PER_MODEL} supports (trunk+root+knot each), best of ${RUNS}`);
  console.log('');

  const baseline = bestOf(0);
  console.log(`baseline state: ${baseline.endStateEntities} entities`);
  console.log(`  capture supports:            ${baseline.captureMs.toFixed(1)} ms`);
  console.log(`  clone state (before snap):   ${baseline.cloneBeforeMs.toFixed(1)} ms`);
  console.log(`  raw structuredClone(state):  ${baseline.rawStructuredCloneMs.toFixed(1)} ms`);
  console.log(`  spread 8 collections:        ${baseline.spreadCollectionsMs.toFixed(1)} ms`);
  console.log(`  clone state (after snap):    ${baseline.cloneAfterMs.toFixed(1)} ms`);
  console.log(`  transformSupportsForModel:   ${baseline.transformMs.toFixed(1)} ms`);
  console.log('');

  console.log('dups | paste, per copy | paste, one call | total confirm (clone ×2 + capture + paste)  | end entities');
  for (const dups of DUP_COUNTS) {
    const r = bestOf(dups);
    const confirmOld = r.cloneBeforeMs + r.cloneAfterMs + r.captureMs + r.pasteSingleMs + r.transformMs;
    const confirmNew = r.cloneBeforeMs + r.cloneAfterMs + r.captureMs + r.pasteBatchMs + r.transformMs;
    console.log(
      `${String(dups).padStart(4)} | ${r.pasteSingleMs.toFixed(1).padStart(15)} | `
      + `${r.pasteBatchMs.toFixed(1).padStart(14)} | `
      + `${confirmOld.toFixed(1)} → ${confirmNew.toFixed(1)} ms`.padEnd(40)
      + ` | ${r.endStateEntities}`,
    );
  }
}

main();
