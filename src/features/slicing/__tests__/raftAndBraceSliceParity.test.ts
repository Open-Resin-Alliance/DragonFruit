import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupportAndRaftWorldTriangles } from '../rasterLayerZipExport';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { DEFAULT_RAFT_SETTINGS } from '@/supports/Rafts/Crenelated/RaftDefaults';
import {
  getRaftStateSnapshot,
  seedRaftStateSnapshot,
  setRaftSettings,
  setRaftSettingsForModel,
} from '@/supports/Rafts/Crenelated/RaftState';
import { braceSpanDiameters } from '@/supports/SupportTypes/Brace/braceSpanDiameters';
import type { Brace, Knot, Stump, SupportState } from '@/supports/types';

function makeStump(id: string, modelId: string, x: number, y: number, baseDiameter = 3.0): Stump {
  const joint = { id: `${id}-joint`, pos: { x, y, z: 1.1 }, diameter: 1.5 };
  return {
    id,
    typeId: 'stump',
    modelId,
    rootPos: { x, y, z: 0 },
    rootBaseDiameter: baseDiameter,
    rootTopDiameter: 1.5,
    rootHeight: 1.0,
    joint,
    segments: [
      {
        id: `${id}-seg`,
        type: 'straight',
        diameter: 0.8,
        bottomJoint: joint,
        topJoint: { id: `${id}-top`, pos: { x, y, z: 2.0 }, diameter: 1.2 },
      },
    ],
    contactCone: {
      id: `${id}-cone`,
      pos: { x, y, z: 3.5 },
      normal: { x: 0, y: 0, z: -1 },
      surfaceNormal: { x: 0, y: 0, z: -1 },
      profile: {
        type: 'cone',
        contactDiameterMm: 0.4,
        bodyDiameterMm: 1.2,
        lengthMm: 1.5,
        penetrationMm: 0.05,
      },
    } as any,
  };
}

function buildSupportState(partial: Partial<SupportState>): SupportState {
  return {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
    ...partial,
  };
}

test('slicer buildSupportAndRaftWorldTriangles emits solid and line rafts for stump-only models and respects per-model overrides', () => {
  const savedSupport = getSnapshot();
  const savedRaft = getRaftStateSnapshot();
  try {
    setSnapshot(
      buildSupportState({
        stumps: {
          s1: makeStump('s1', 'm-stump', 0, 0, 3.0),
          s2: makeStump('s2', 'm-stump', 12, 0, 3.0),
          s3: makeStump('s3', 'm-stump', 6, 10, 3.0),
        },
      }),
    );

    const visible = new Set(['m-stump']);

    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
      perModel: {},
    });
    const trisOff = buildSupportAndRaftWorldTriangles(visible);
    assert.ok(trisOff.length > 0, 'stumps themselves emit support triangles');

    setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: true });
    const trisSolid = buildSupportAndRaftWorldTriangles(visible);
    assert.ok(
      trisSolid.length > trisOff.length + 20,
      `expected solid raft triangles for stump-only model (${trisSolid.length} vs off ${trisOff.length})`,
    );

    setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'line' });
    const trisLine = buildSupportAndRaftWorldTriangles(visible);
    assert.ok(
      trisLine.length > trisOff.length + 10,
      `expected line raft triangles for stump-only model (${trisLine.length} vs off ${trisOff.length})`,
    );

    // Per-model override: global = 'off', 'm-stump' = 'solid'
    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
      perModel: {},
    });
    setRaftSettingsForModel('m-stump', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: true });
    const trisModelSolid = buildSupportAndRaftWorldTriangles(visible);
    assert.equal(trisModelSolid.length, trisSolid.length);

    // Per-model override: global = 'solid', 'm-stump' = 'off'
    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid', wallEnabled: true },
      perModel: {},
    });
    setRaftSettingsForModel('m-stump', { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' });
    const trisModelOff = buildSupportAndRaftWorldTriangles(visible);
    assert.equal(trisModelOff.length, trisOff.length);
  } finally {
    setSnapshot(savedSupport);
    seedRaftStateSnapshot(savedRaft);
  }
});

test('slicer clamps brace diameter to brace.profile.diameter rather than uncapped host knot diameter', () => {
  const savedSupport = getSnapshot();
  const savedRaft = getRaftStateSnapshot();
  try {
    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
      perModel: {},
    });

    const k1: Knot = {
      id: 'k1',
      parentShaftId: 'host-1',
      pos: { x: 0, y: 0, z: 10 },
      diameter: 1.9, // 1.8 mm host trunk + 0.1 mm joint offset
    };
    const k2: Knot = {
      id: 'k2',
      parentShaftId: 'host-2',
      pos: { x: 10, y: 0, z: 10 },
      diameter: 1.9,
    };
    const brace: Brace = {
      id: 'brace-thin',
      typeId: 'brace',
      modelId: 'm-brace',
      startKnotId: 'k1',
      endKnotId: 'k2',
      profile: { diameter: 0.8 },
    };

    setSnapshot(
      buildSupportState({
        knots: { k1, k2 },
        braces: { 'brace-thin': brace },
      }),
    );

    const tris = buildSupportAndRaftWorldTriangles(new Set(['m-brace']));
    assert.ok(tris.length > 0, 'expected sliced brace triangles');

    let maxRadius = 0;
    for (const tri of tris) {
      for (const [y, z] of [
        [tri.ay, tri.az],
        [tri.by, tri.bz],
        [tri.cy, tri.cz],
      ]) {
        const r = Math.hypot(y, z - 10);
        if (r > maxRadius) maxRadius = r;
      }
    }

    assert.ok(
      maxRadius <= 0.405 && maxRadius >= 0.39,
      `expected brace cross-section radius ~0.4 mm (0.8 mm dia), got ${maxRadius.toFixed(4)} mm`,
    );
  } finally {
    setSnapshot(savedSupport);
    seedRaftStateSnapshot(savedRaft);
  }
});

test('slicer tapers straight and bezier braces across unequal host knots matching braceSpanDiameters', () => {
  const savedSupport = getSnapshot();
  const savedRaft = getRaftStateSnapshot();
  try {
    seedRaftStateSnapshot({
      global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' },
      perModel: {},
    });

    const kStart: Knot = {
      id: 'k-start',
      parentShaftId: 'host-start',
      pos: { x: 0, y: 0, z: 10 },
      diameter: 1.1, // 1.0 mm host shaft + 0.1 mm joint offset
    };
    const kEnd: Knot = {
      id: 'k-end',
      parentShaftId: 'host-end',
      pos: { x: 10, y: 0, z: 10 },
      diameter: 0.7, // 0.6 mm host shaft + 0.1 mm joint offset
    };
    const straightBrace: Brace = {
      id: 'brace-taper-straight',
      typeId: 'brace',
      modelId: 'm-taper',
      startKnotId: 'k-start',
      endKnotId: 'k-end',
      profile: { diameter: 1.2 },
    };

    const span = braceSpanDiameters(straightBrace, kStart, kEnd);
    assert.ok(Math.abs(span.startDiameterMm - 1.0) < 1e-6);
    assert.ok(Math.abs(span.endDiameterMm - 0.6) < 1e-6);

    setSnapshot(
      buildSupportState({
        knots: { 'k-start': kStart, 'k-end': kEnd },
        braces: { 'brace-taper-straight': straightBrace },
      }),
    );

    const straightTris = buildSupportAndRaftWorldTriangles(new Set(['m-taper']));
    assert.ok(straightTris.length > 0);

    const maxRadiusNearX = (tris: typeof straightTris, targetX: number, tol = 1e-3): number => {
      let maxR = 0;
      for (const tri of tris) {
        for (const [x, y, z] of [
          [tri.ax, tri.ay, tri.az],
          [tri.bx, tri.by, tri.bz],
          [tri.cx, tri.cy, tri.cz],
        ]) {
          if (Math.abs(x - targetX) <= tol) {
            maxR = Math.max(maxR, Math.hypot(y, z - 10));
          }
        }
      }
      return maxR;
    };

    const rStartStraight = maxRadiusNearX(straightTris, 0);
    const rEndStraight = maxRadiusNearX(straightTris, 10);
    assert.ok(
      Math.abs(rStartStraight - 0.5) < 5e-3,
      `expected start radius ~0.5 mm (1.0 mm dia) at x=0, got ${rStartStraight.toFixed(4)} mm`,
    );
    assert.ok(
      Math.abs(rEndStraight - 0.3) < 5e-3,
      `expected end radius ~0.3 mm (0.6 mm dia) at x=10, got ${rEndStraight.toFixed(4)} mm`,
    );

    // Bezier tapered brace along the same X-axis
    const bezierBrace: Brace = {
      ...straightBrace,
      id: 'brace-taper-bezier',
      curve: {
        type: 'bezier',
        controlPoint1: { x: 10 / 3, y: 0, z: 10 },
        controlPoint2: { x: 20 / 3, y: 0, z: 10 },
        startTangent: { x: 1, y: 0, z: 0 },
        endTangent: { x: 1, y: 0, z: 0 },
        tension: 0.5,
        bias: 0.5,
        resolution: 12,
      },
    };

    setSnapshot(
      buildSupportState({
        knots: { 'k-start': kStart, 'k-end': kEnd },
        braces: { 'brace-taper-bezier': bezierBrace },
      }),
    );

    const bezierTris = buildSupportAndRaftWorldTriangles(new Set(['m-taper']));
    assert.ok(bezierTris.length > straightTris.length);

    const rStartBezier = maxRadiusNearX(bezierTris, 0);
    const rMidBezier = maxRadiusNearX(bezierTris, 5, 0.05);
    const rEndBezier = maxRadiusNearX(bezierTris, 10);

    assert.ok(
      Math.abs(rStartBezier - 0.5) < 5e-3,
      `expected bezier start radius ~0.5 mm at x=0, got ${rStartBezier.toFixed(4)} mm`,
    );
    assert.ok(
      Math.abs(rMidBezier - 0.4) < 1e-2,
      `expected bezier midpoint radius ~0.4 mm at x=5, got ${rMidBezier.toFixed(4)} mm`,
    );
    assert.ok(
      Math.abs(rEndBezier - 0.3) < 5e-3,
      `expected bezier end radius ~0.3 mm at x=10, got ${rEndBezier.toFixed(4)} mm`,
    );
  } finally {
    setSnapshot(savedSupport);
    seedRaftStateSnapshot(savedRaft);
  }
});
