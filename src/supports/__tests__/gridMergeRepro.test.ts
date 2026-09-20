import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { resetStore, getSnapshot, setSnapshot, addKnot, addBranch } from '../state';
import type { SupportState } from '../types';
import { buildTrunkDataFromPlacement } from '../SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';

const MODEL_ID = 'model-1';

function makeSettings() {
    const settings = createDefaultSettings();
    settings.grid.enabled = true;
    settings.grid.spacingMm = 4;
    settings.grid.minBranchAngleDeg = 60;
    settings.grid.attachSearchStepMm = 2.0;
    return settings;
}

test('grid merge re-pins a graft knot above the host joint below it and rebuilds the branch', () => {
    const settings = makeSettings();
    setSettings(settings);
    resetStore();
    const straight = (x: number, y: number, tipZ: number, socketZ: number) => {
        const input = {
            tipPos: { x, y, z: tipZ }, tipNormal: { x: 0, y: 0, z: 1 }, modelId: MODEL_ID,
            overrides: { rootsDiskHeightMm: 0, rootsConeHeightMm: 0 },
        };
        const placement = {
            basePos: { x, y, z: 0 }, socketPos: { x, y, z: socketZ },
            unsnappedBottomPos: { x, y, z: 0 }, snappedNodeKey: null, joints: [], constructionJoints: [],
        };
        return { input, build: buildTrunkDataFromPlacement(input, placement) };
    };
    const host = straight(0, 0, 10, 9);
    const hostRootId = host.build.root.id;
    const hostTrunkId = host.build.trunk.id;
    const snapshot: SupportState = {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {},
        sticks: {}, braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, hoveredId: null,
    } as unknown as SupportState;
    snapshot.roots[host.build.root.id] = host.build.root;
    snapshot.trunks[host.build.trunk.id] = host.build.trunk;
    const cand = straight(1.9, 0, 9, 8);
    const d = decideGridPlacement({
        settings, snapshot, candidate: cand.build,
        tipPos: cand.input.tipPos, tipNormal: cand.input.tipNormal, modelId: MODEL_ID,
    });
    assert.equal(d.kind, 'place_branch');
    if (d.kind !== 'place_branch') return;

    // Commit the way the trunk placement path does: re-pin the graft
    // knot below the host segment's bottom joint when the walk stopped
    // above it, rebuild the branch from there, then add both.
    const base = getSnapshot();
    setSnapshot({
        ...base,
        roots: { ...base.roots, [hostRootId]: snapshot.roots[hostRootId] },
        trunks: { ...base.trunks, [hostTrunkId]: snapshot.trunks[hostTrunkId] },
    });
    const hostBefore = getSnapshot().trunks[hostTrunkId];
    const graftSeg = hostBefore?.segments.find((s) => s.id === d.knot.parentShaftId);
    const jointZ = graftSeg?.bottomJoint?.pos.z;
    const cone = d.branch.contactCone;
    assert.ok(cone, 'decision carries a contact cone');
    const knot = jointZ !== undefined && d.knot.pos.z >= jointZ
        ? { ...d.knot, pos: { ...d.knot.pos, z: jointZ - 0.3 } }
        : d.knot;
    const branch = knot === d.knot
        ? d.branch
        : buildBranchData({
            tipPos: cone!.pos,
            tipNormal: cone!.surfaceNormal ?? cone!.normal,
            modelId: d.branch.modelId,
            parentKnot: knot,
        }).branch;
    if (knot !== d.knot) {
        // The re-pinned knot sits below the joint the walk stopped above.
        assert.ok(knot.pos.z < jointZ!, `re-pinned knot z=${knot.pos.z.toFixed(2)} below joint z=${jointZ!.toFixed(2)}`);
    }
    addKnot(knot);
    addBranch(branch);
    // The committed branch hangs from the knot the commit stored.
    const stored = getSnapshot().branches[branch.id];
    assert.ok(stored, 'branch committed');
    assert.equal(stored!.parentKnotId, knot.id, 'branch hangs from the re-pinned knot');
});
