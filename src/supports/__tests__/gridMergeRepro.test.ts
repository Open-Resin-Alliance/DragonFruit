import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import {
    memberDepartureAngleFromVerticalDeg,
    SHORT_SPAN_DETOUR_MAX_ANGLE_FROM_VERTICAL_DEG,
} from '../PlacementLogic/smartPlacementSearchUtils';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { Branch, Knot, SupportState } from '../types';
import { buildTrunkDataFromPlacement, type TrunkBuildResult } from '../SupportTypes/Trunk/trunkBuilder';

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

/** A vertical trunk from the plate to `tipZ`, with its socket at `socketZ`. */
function straight(x: number, y: number, tipZ: number, socketZ: number): TrunkBuildResult {
    const input = {
        tipPos: { x, y, z: tipZ }, tipNormal: { x: 0, y: 0, z: 1 }, modelId: MODEL_ID,
        overrides: { rootsDiskHeightMm: 0, rootsConeHeightMm: 0 },
    };
    const placement = {
        basePos: { x, y, z: 0 }, socketPos: { x, y, z: socketZ },
        unsnappedBottomPos: { x, y, z: 0 }, snappedNodeKey: null, joints: [], constructionJoints: [],
    };
    return buildTrunkDataFromPlacement(input, placement);
}

/** The host of both tests below, standing on the grid node the tip snaps to. */
function hostSnapshot(host: TrunkBuildResult): SupportState {
    const snapshot = makeSnapshot();
    snapshot.roots[host.root.id] = host.root;
    snapshot.trunks[host.trunk.id] = host.trunk;
    return snapshot;
}

test('grid merge takes the highest graft whose shaft holds 45 degrees', () => {
    const settings = makeSettings();
    setSettings(settings);
    const host = straight(0, 0, 10, 9);
    const snapshot = hostSnapshot(host);
    const d = decideGridPlacement({
        settings, snapshot, candidate: straight(1.9, 0, 9, 8),
        tipPos: { x: 1.9, y: 0, z: 9 }, tipNormal: { x: 0, y: 0, z: 1 }, modelId: MODEL_ID,
    });
    assert.equal(d.kind, 'place');
    if (d.kind !== 'place') return;
    assert.equal(d.placed.typeId, 'branch', 'a close tip grafts as a branch on the host');
    // A close tip must graft high with a proper climb, not dive to the
    // base: the first knot top-down whose built shaft holds 45 wins.
    const knot = d.placed.supplied.parentKnotId as Knot | undefined;
    assert.ok(knot, 'the graft carries the knot it hangs from');
    const segIndex = host.trunk.segments.findIndex((s) => s.id === knot.parentShaftId);
    assert.equal(segIndex, 1, `graft lands on the upper section, not segment ${segIndex}`);
    const firstJoint = (d.placed.entity as Branch).segments[0]?.topJoint?.pos;
    assert.ok(firstJoint, 'branch has a first joint');
    const departureDeg = memberDepartureAngleFromVerticalDeg(knot.pos, firstJoint);
    assert.ok(
        departureDeg <= 45.05,
        `merged shaft leaves at ${departureDeg.toFixed(1)}deg, shallower than 45`,
    );
});

test('a tip offset from its host grafts under the host top, not down the shaft', () => {
    const settings = makeSettings();
    setSettings(settings);
    const host = straight(0, 0, 20, 19);
    const snapshot = hostSnapshot(host);

    // 3mm to the side and 1mm below the host's top. From every knot near the
    // top the straight line to the tip is shallower than the branch angle, but
    // the built shaft leaves at 31.7 degrees against the 60 it is allowed, so
    // the departure gate takes those knots. The chord pre-filter used to
    // measure that chord against the length-aware allowance and drop them,
    // which left the walk no knot above z=13: the graft landed 6mm below the
    // host's top for a tip 1mm under it.
    const tipPos = { x: 3, y: 0, z: 19 };
    const d = decideGridPlacement({
        settings, snapshot, candidate: host,
        tipPos, tipNormal: { x: 0, y: 0, z: 1 }, modelId: MODEL_ID,
    });
    assert.equal(d.kind, 'place');
    if (d.kind !== 'place') return;
    assert.equal(d.placed.typeId, 'branch');
    const knot = d.placed.supplied.parentKnotId as Knot | undefined;
    assert.ok(knot, 'the graft carries the knot it hangs from');
    const hostTopZ = host.trunk.segments[host.trunk.segments.length - 1]?.topJoint?.pos.z ?? 0;
    const dropMm = hostTopZ - knot.pos.z;
    // The search samples every `attachSearchStepMm` (2mm), so the highest knot
    // it can take sits at most one step below the tip.
    assert.ok(dropMm <= 2.5, `graft landed ${dropMm.toFixed(2)}mm below the host's top`);
});

test('no grid attachment leaves its host past the short-span allowance', () => {
    // The junction is where a member meets its host, and an occupied node used
    // to add the socket elbow on top of the allowance (75° from vertical, 15°
    // above flat). The member that produced was the near-horizontal whisker at
    // a junction, so every tip around a host's top is swept here and each
    // placed attachment held to the allowance it earned.
    const settings = makeSettings();
    setSettings(settings);
    const host = straight(0, 0, 20, 19);
    const snapshot = hostSnapshot(host);
    let placed = 0;

    for (let lateral = 0.5; lateral <= 3.5; lateral += 0.5) {
        for (let rise = 0.1; rise <= 3.0; rise += 0.5) {
            const tipPos = { x: lateral, y: 0, z: 19 + rise };
            const d = decideGridPlacement({
                settings, snapshot, candidate: host,
                tipPos,
                tipNormal: { x: 0, y: 0, z: 1 },
                modelId: MODEL_ID,
            });
            if (d.kind !== 'place') continue;
            placed++;
            const knot = d.placed.supplied.parentKnotId as Knot | undefined;
            assert.ok(knot, 'the member names the knot it hangs from');
            if (!knot) return;
            // The gate's own quantity: a leaf is one tapered cone, so its chord
            // is the member; a branch's opening segment is where it leaves.
            const member = d.placed.entity as Branch;
            const firstJoint = member.segments?.[0]?.topJoint?.pos;
            const departureDeg = d.placed.typeId === 'leaf'
                ? memberDepartureAngleFromVerticalDeg(knot.pos, tipPos)
                : memberDepartureAngleFromVerticalDeg(knot.pos, firstJoint ?? tipPos);
            assert.ok(
                departureDeg <= SHORT_SPAN_DETOUR_MAX_ANGLE_FROM_VERTICAL_DEG + 0.05,
                `tip ${lateral}mm out and ${rise.toFixed(1)}mm up leaves at `
                + `${departureDeg.toFixed(1)}deg, past the allowance`,
            );
        }
    }
    assert.ok(placed >= 10, `the sweep places members to check (${placed})`);
});
