import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { resetStore, getSnapshot, setSnapshot, addKnot, addBranch } from '../state';
import type { SupportState } from '../types';
import { updateSupportEntity } from '../supportTypeRegistry';
import { splitShaft } from '../SupportPrimitives/Joint/jointUtils';
import { buildTrunkDataFromPlacement } from '../SupportTypes/Trunk/trunkBuilder';

const MODEL_ID = 'model-1';

function makeSettings() {
    const settings = createDefaultSettings();
    settings.grid.enabled = true;
    settings.grid.spacingMm = 4;
    settings.grid.minBranchAngleDeg = 60;
    settings.grid.attachSearchStepMm = 2.0;
    return settings;
}

test('grid merge splits the host at the graft knot so the branch shaft visibly starts there', async () => {
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

    // Commit the way the trunk placement path does: split the host at the
    // graft knot, then add the knot and the branch.
    const base = getSnapshot();
    setSnapshot({
        ...base,
        roots: { ...base.roots, [hostRootId]: snapshot.roots[hostRootId] },
        trunks: { ...base.trunks, [hostTrunkId]: snapshot.trunks[hostTrunkId] },
    });
    const before = getSnapshot().trunks[hostTrunkId];
    const root = getSnapshot().roots[hostRootId];
    const { trunk: splitHost } = splitShaft(before, d.knot.parentShaftId, d.knot.pos, d.knot.t, root);
    updateSupportEntity('trunk', splitHost);
    addKnot(d.knot);
    addBranch(d.branch);

    const after = getSnapshot();
    const knotSeg = after.trunks[hostTrunkId].segments.find((s) => s.id === d.knot.parentShaftId);
    assert.ok(knotSeg, 'graft segment still exists after the split');
    const topJoint = knotSeg!.topJoint;
    assert.ok(topJoint, 'split leaves a joint at the graft point');
    assert.ok(
        Math.abs(topJoint!.pos.z - d.knot.pos.z) < 1e-6,
        `joint sits at the knot z=${d.knot.pos.z.toFixed(2)}, got ${topJoint!.pos.z.toFixed(2)}`,
    );
});
