import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { memberDepartureAngleFromVerticalDeg } from '../PlacementLogic/smartPlacementSearchUtils';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { SupportState } from '../types';
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

function makeSnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {},
        sticks: {}, braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, hoveredId: null,
    } as unknown as SupportState;
}

test('grid merge takes the highest graft whose shaft holds 45 degrees', () => {
    const settings = makeSettings();
    setSettings(settings);
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
    const snapshot = makeSnapshot();
    snapshot.roots[host.build.root.id] = host.build.root;
    snapshot.trunks[host.build.trunk.id] = host.build.trunk;
    const cand = straight(1.9, 0, 9, 8);
    const d = decideGridPlacement({
        settings, snapshot, candidate: cand.build,
        tipPos: cand.input.tipPos, tipNormal: cand.input.tipNormal, modelId: MODEL_ID,
    });
    assert.equal(d.kind, 'place_branch');
    if (d.kind !== 'place_branch') return;
    // A close tip must graft high with a proper climb, not dive to the
    // base: the first knot top-down whose built shaft holds 45 wins.
    const segIndex = host.build.trunk.segments.findIndex((s) => s.id === d.knot.parentShaftId);
    assert.equal(segIndex, 1, `graft lands on the upper section, not segment ${segIndex}`);
    const firstJoint = d.branch.segments[0]?.topJoint?.pos;
    assert.ok(firstJoint, 'branch has a first joint');
    const departureDeg = memberDepartureAngleFromVerticalDeg(d.knot.pos, firstJoint!);
    assert.ok(
        departureDeg <= 45.05,
        `merged shaft leaves at ${departureDeg.toFixed(1)}deg, shallower than 45`,
    );
});
