import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { decideOrganicPlacement } from '../PlacementLogic/proximityPlacement';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { SupportState, Knot } from '../types';
import {
    buildTrunkDataFromPlacement,
    type TrunkBuildInput,
    type TrunkBuildResult,
} from '../SupportTypes/Trunk/trunkBuilder';

const MODEL_ID = 'model-1';

interface FixtureBuild {
    input: TrunkBuildInput;
    build: TrunkBuildResult;
}

function makeSettings() {
    const settings = createDefaultSettings();
    settings.grid.enabled = false; // Organic mode is when grid is disabled
    settings.grid.spacingMm = 15;
    return settings;
}

function makeEmptySnapshot(): SupportState {
    return {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        anchors: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
    };
}

function makePlacement(args: {
    x: number;
    y: number;
    socketZ: number;
}): ReturnType<typeof buildTrunkDataFromPlacement>['trunk'] {
    return {
        id: 'trunk-id',
        modelId: MODEL_ID,
        rootId: 'root-id',
        segments: [],
    };
}

function buildManualHostFixture(args: {
    x: number;
    y: number;
    tipZ: number;
    bottomZ: number;
    topZ: number;
}): FixtureBuild {
    const input: TrunkBuildInput = {
        tipPos: { x: args.x, y: args.y, z: args.tipZ },
        tipNormal: { x: 0, y: 0, z: 1 },
        modelId: MODEL_ID,
    };

    const trunkId = 'host-trunk-' + Math.random().toString(36).substring(2, 9);
    const rootId = 'host-root-' + Math.random().toString(36).substring(2, 9);

    const segment = {
        id: `${trunkId}-segment`,
        diameter: 1.5,
        bottomJoint: {
            id: `${trunkId}-bottom`,
            pos: { x: args.x, y: args.y, z: args.bottomZ },
            diameter: 2.0,
        },
        topJoint: {
            id: `${trunkId}-top`,
            pos: { x: args.x, y: args.y, z: args.topZ },
            diameter: 2.0,
        },
    };

    const root = {
        id: rootId,
        modelId: MODEL_ID,
        transform: {
            pos: { x: args.x, y: args.y, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 5.0,
        diskHeight: 1.0,
        coneHeight: 2.0,
    };

    const trunk = {
        id: trunkId,
        modelId: MODEL_ID,
        rootId,
        segments: [segment],
        contactCone: {
            id: `${trunkId}-cone`,
            pos: { x: args.x, y: args.y, z: args.tipZ },
            surfaceNormal: { x: 0, y: 0, z: 1 },
            coneAxis: { x: 0, y: 0, z: 1 },
            contactDiameterMm: 0.5,
            bodyDiameterMm: 1.5,
            coneLengthOverride: 2.0,
        },
    };

    const supportData = {
        id: trunkId,
        segments: [segment],
        contactCones: [trunk.contactCone],
        roots: root,
        error: undefined,
    };

    return {
        input,
        build: {
            trunk,
            root,
            route: {
                joints: [],
                constructionJoints: [],
                basePos: { x: args.x, y: args.y, z: 0 },
                socketPos: { x: args.x, y: args.y, z: args.topZ },
            },
            supportData,
        },
    };
}

function addTrunkBuild(snapshot: SupportState, fixture: FixtureBuild) {
    snapshot.roots[fixture.build.root.id] = fixture.build.root;
    snapshot.trunks[fixture.build.trunk.id] = fixture.build.trunk;
}

test('decideOrganicPlacement merges into a nearby trunk segment using a Leaf when close and angle constraints are met', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    // Host trunk at (0, 0)
    const host = buildManualHostFixture({
        x: 0,
        y: 0,
        tipZ: 30,
        bottomZ: 3,
        topZ: 28,
    });
    addTrunkBuild(snapshot, host);

    // Tip near host: x=1.0, y=0, z=20 (horizontal dist 1.0mm, vertical attachment points below 20 are available)
    const candidate = buildManualHostFixture({
        x: 1.0,
        y: 0,
        tipZ: 20,
        bottomZ: 3,
        topZ: 18,
    });

    const decision = decideOrganicPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_leaf');
    assert.equal(decision.hostTrunkId, host.build.trunk.id);
});

test('decideOrganicPlacement promotes to a Branch if Leaf would be too horizontal (<30 deg) or too stretched (>2.0x)', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    // Host trunk at (0, 0)
    const host = buildManualHostFixture({
        x: 0,
        y: 0,
        tipZ: 30,
        bottomZ: 3,
        topZ: 28,
    });
    addTrunkBuild(snapshot, host);

    // Tip far horizontally: x=10.0, y=0, z=5.0 (highly horizontal leaf)
    const candidate = buildManualHostFixture({
        x: 10.0,
        y: 0,
        tipZ: 5.0,
        bottomZ: 3,
        topZ: 4.0,
    });

    const decision = decideOrganicPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    // The resolver should promote to a Branch to allow routed/curved segments that satisfy structural limits
    assert.equal(decision.kind, 'place_branch');
    assert.equal(decision.hostTrunkId, host.build.trunk.id);
});

test('decideOrganicPlacement falls back to place_trunk if the host trunk already has 3 branches/leaves', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const host = buildManualHostFixture({
        x: 0,
        y: 0,
        tipZ: 30,
        bottomZ: 3,
        topZ: 28,
    });
    addTrunkBuild(snapshot, host);

    // Add 3 mock knots on the host segment to simulate 3 branches
    const segId = host.build.trunk.segments[0].id;
    for (let i = 0; i < 3; i++) {
        const knotId = `knot-${i}`;
        const knot: Knot = {
            id: knotId,
            parentShaftId: segId,
            t: 0.5,
            pos: { x: 0, y: 0, z: 10 + i * 4 },
        };
        snapshot.knots[knotId] = knot;
    }

    // Candidate near host
    const candidate = buildManualHostFixture({
        x: 1.0,
        y: 0,
        tipZ: 20,
        bottomZ: 3,
        topZ: 18,
    });

    const decision = decideOrganicPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    // Since the host already has 3 attachments, we expect it to place a new separate trunk instead of overloading
    assert.equal(decision.kind, 'place_trunk');
});

test('decideOrganicPlacement enforces vertical spacing of >3mm between knots', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const host = buildManualHostFixture({
        x: 0,
        y: 0,
        tipZ: 30,
        bottomZ: 3,
        topZ: 28,
    });
    addTrunkBuild(snapshot, host);

    // Add a knot at Z=10 on the host segment
    const segId = host.build.trunk.segments[0].id;
    const knot: Knot = {
        id: 'knot-existing',
        parentShaftId: segId,
        t: 0.28, // corresponds approximately to Z = 3 + 0.28*(28-3) = 10
        pos: { x: 0, y: 0, z: 10 },
    };
    snapshot.knots['knot-existing'] = knot;

    // Candidate whose direct vertical/horizontal alignment would try to place a leaf knot close to Z=10
    const candidate = buildManualHostFixture({
        x: 1.0,
        y: 0,
        tipZ: 11.5, // tip at Z=11.5, Leaf length nominal is 2, so it wants to attach near Z=9.5 - 10.5
        bottomZ: 3,
        topZ: 9.5,
    });

    const decision = decideOrganicPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    // It should select a point on the segment that respects spacing (e.g. further down or promoting to a branch/placing branch)
    // Here we verify it does not place a leaf at Z=10.
    if (decision.kind === 'place_leaf') {
        const knotZ = decision.knot.pos.z;
        assert.ok(Math.abs(knotZ - 10) > 3.0, `Knot Z ${knotZ} is too close to existing knot at Z=10`);
    } else {
        // Branch promotion or fallback is also valid as long as the spacing wasn't violated.
        assert.ok(true);
    }
});
