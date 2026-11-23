/**
 * The resin estimate against the triangles the slicer receives.
 *
 * `computeSupportAndRaftResinMl` re-derives the printed geometry analytically, so
 * the only honest check is the export itself: hand the same support state to
 * `buildSupportAndRaftWorldTriangles` and compare the volume of its triangles with
 * the estimate. A change to either side that forgets the other fails here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSupportAndRaftResinMl } from '../supportResinVolume';
import { buildSupportAndRaftWorldTriangles } from '@/features/slicing/rasterLayerZipExport';
import { DEFAULT_RAFT_SETTINGS } from '@/supports/Rafts/Crenelated/RaftDefaults';
import { setRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { resetStore, setSnapshot } from '@/supports/state';
import type { Roots, SupportCollections, SupportState, Trunk } from '@/supports/types';

const MODEL_ID = 'model';
const RAFT_OFF = { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' as const };

function createRoot(id: string, x: number): Roots {
    return {
        id,
        modelId: MODEL_ID,
        transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function createTrunk(id: string, rootId: string, x: number, topZ: number): Trunk {
    return {
        id,
        typeId: 'trunk',
        modelId: MODEL_ID,
        rootId,
        segments: [{
            id: `seg-${id}`,
            diameter: 1,
            topJoint: { id: `joint-${id}`, pos: { x, y: 0, z: topZ }, diameter: 1.2 },
        }],
    };
}

function withRoots(roots: Roots[], trunks: Trunk[] = []): SupportCollections {
    const state = createEmptySupportCollections();
    for (const root of roots) state.roots[root.id] = root;
    for (const trunk of trunks) state.trunks[trunk.id] = trunk;
    return state;
}

/**
 * The estimate measures true circles; the sliced mesh is tessellated (a 14-sided
 * root, 12-sided shafts, a polyhedral joint sphere, fewer sides in dense scenes).
 * A few percent below the analytic figure is the honest floor, so the comparison
 * is at 5%: a structural miss — a missing wall, chamfer or beam network, a root cap
 * that is not printed — lands far outside it.
 *
 * Signed tetrahedron sum of the exporter's triangles, in ml.
 */
function exportedMl(triangles: ReadonlyArray<{
    ax: number; ay: number; az: number;
    bx: number; by: number; bz: number;
    cx: number; cy: number; cz: number;
}>): number {
    let mm3 = 0;
    for (const t of triangles) {
        mm3 += (
            t.ax * (t.by * t.cz - t.bz * t.cy)
            - t.ay * (t.bx * t.cz - t.bz * t.cx)
            + t.az * (t.bx * t.cy - t.by * t.cx)
        ) / 6;
    }
    return Math.abs(mm3) / 1000;
}

function estimateMl(state: SupportCollections, raft: typeof DEFAULT_RAFT_SETTINGS): number {
    return computeSupportAndRaftResinMl({
        supportState: state,
        raftSettings: raft,
        visibleModelIds: new Set([MODEL_ID]),
        plateModels: [],
    });
}

function install(state: SupportCollections, raft: typeof DEFAULT_RAFT_SETTINGS): void {
    setSnapshot({ ...state, selectedId: null, hoveredId: null } as SupportState);
    setRaftSettings(raft);
}

test('the estimate matches the sliced supports and raft', () => {
    const state = withRoots(
        [createRoot('r1', 0), createRoot('r2', 10)],
        [createTrunk('t1', 'r1', 0, 10), createTrunk('t2', 'r2', 10, 8)],
    );
    const raft = DEFAULT_RAFT_SETTINGS;

    try {
        install(state, raft);
        const triangles = buildSupportAndRaftWorldTriangles(new Set([MODEL_ID]), undefined, 0, []);
        const printed = exportedMl(triangles);
        const estimate = estimateMl(state, raft);

        assert.ok(printed > 0, 'the exporter produced no geometry');
        assert.ok(
            Math.abs(estimate - printed) < printed * 0.05,
            `estimate ${estimate} ml vs sliced ${printed} ml`,
        );
    } finally {
        resetStore();
    }
});

test('the estimate matches the sliced supports with the raft off', () => {
    const state = withRoots([createRoot('r1', 0)], [createTrunk('t1', 'r1', 0, 10)]);

    try {
        install(state, RAFT_OFF);
        const triangles = buildSupportAndRaftWorldTriangles(new Set([MODEL_ID]), undefined, 0, []);
        const printed = exportedMl(triangles);
        const estimate = estimateMl(state, RAFT_OFF);

        assert.ok(printed > 0, 'the exporter produced no geometry');
        assert.ok(
            Math.abs(estimate - printed) < printed * 0.05,
            `estimate ${estimate} ml vs sliced ${printed} ml`,
        );
    } finally {
        resetStore();
    }
});
