import assert from 'node:assert/strict';
import test from 'node:test';

import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { SupportState } from '../types';
import {
    buildTrunkDataFromPlacement,
    type TrunkBuildInput,
    type TrunkBuildResult,
} from '../SupportTypes/Trunk/trunkBuilder';

const GRID_SPACING_MM = 4;
const GRID_RING_RADIUS = 4;
const MODEL_ID = 'model-1';

interface FixtureBuild {
    input: TrunkBuildInput;
    build: TrunkBuildResult;
}

function makeSettings() {
    const settings = createDefaultSettings();
    settings.grid.enabled = true;
    settings.grid.spacingMm = GRID_SPACING_MM;
    settings.grid.minBranchAngleDeg = 45;
    settings.grid.attachSearchStepMm = 0.25;
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
    joints?: TrunkPlacementResult['joints'];
    constructionJoints?: TrunkPlacementResult['constructionJoints'];
}): TrunkPlacementResult {
    return {
        basePos: { x: args.x, y: args.y, z: 0 },
        socketPos: { x: args.x, y: args.y, z: args.socketZ },
        unsnappedBottomPos: { x: args.x, y: args.y, z: 0 },
        snappedNodeKey: null,
        joints: args.joints ?? [],
        constructionJoints: args.constructionJoints ?? [],
    };
}

function buildStraightFixture(args: {
    x: number;
    y: number;
    tipZ: number;
    socketZ: number;
    rootsDiskHeightMm?: number;
    rootsConeHeightMm?: number;
}): FixtureBuild {
    const input: TrunkBuildInput = {
        tipPos: { x: args.x, y: args.y, z: args.tipZ },
        tipNormal: { x: 0, y: 0, z: 1 },
        modelId: MODEL_ID,
        overrides: {
            rootsDiskHeightMm: args.rootsDiskHeightMm ?? 0,
            rootsConeHeightMm: args.rootsConeHeightMm ?? 0,
        },
    };

    const build = buildTrunkDataFromPlacement(
        input,
        makePlacement({ x: args.x, y: args.y, socketZ: args.socketZ }),
    );

    return { input, build };
}

function buildManualHostFixture(args: {
    x: number;
    y: number;
    tipZ: number;
    bottomZ: number;
    topZ: number;
}): FixtureBuild {
    const fixture = buildStraightFixture({
        x: args.x,
        y: args.y,
        tipZ: args.tipZ,
        socketZ: args.topZ,
    });
    const diameter = fixture.build.trunk.baseDiameterMm ?? 1;
    const jointDiameter = diameter + 0.5;
    const segment = {
        id: `${fixture.build.trunk.id}-manual-segment`,
        diameter,
        bottomJoint: {
            id: `${fixture.build.trunk.id}-manual-bottom`,
            pos: { x: args.x, y: args.y, z: args.bottomZ },
            diameter: jointDiameter,
        },
        topJoint: {
            id: `${fixture.build.trunk.id}-manual-top`,
            pos: { x: args.x, y: args.y, z: args.topZ },
            diameter: jointDiameter,
        },
    };

    fixture.build.trunk = {
        ...fixture.build.trunk,
        segments: [segment],
        contactCone: fixture.build.trunk.contactCone
            ? {
                ...fixture.build.trunk.contactCone,
                pos: { x: args.x, y: args.y, z: args.tipZ },
            }
            : fixture.build.trunk.contactCone,
    };
    fixture.build.supportData = {
        ...fixture.build.supportData,
        segments: [segment],
        contactCone: fixture.build.trunk.contactCone,
    };

    return fixture;
}

function addTrunkBuild(snapshot: SupportState, fixture: FixtureBuild) {
    snapshot.roots[fixture.build.root.id] = fixture.build.root;
    snapshot.trunks[fixture.build.trunk.id] = fixture.build.trunk;
}

function populateOccupiedNeighborhood(
    snapshot: SupportState,
    buildForNode: (gx: number, gy: number) => FixtureBuild,
): Map<string, FixtureBuild> {
    const fixtures = new Map<string, FixtureBuild>();

    for (let gx = -GRID_RING_RADIUS; gx <= GRID_RING_RADIUS; gx++) {
        for (let gy = -GRID_RING_RADIUS; gy <= GRID_RING_RADIUS; gy++) {
            const fixture = buildForNode(gx, gy);
            fixtures.set(`${gx},${gy}`, fixture);
            addTrunkBuild(snapshot, fixture);
        }
    }

    return fixtures;
}

test('decideGridPlacement merges into the preferred occupied node before considering nearby empty nodes', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const preferredHost = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
    });
    addTrunkBuild(snapshot, preferredHost);

    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 8,
        socketZ: 7,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_leaf');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement replaces the preferred occupied node before considering nearby empty nodes when the candidate is taller', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const preferredHost = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 6,
        socketZ: 5,
    });
    addTrunkBuild(snapshot, preferredHost);

    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'replace_trunk');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement places a branch on the occupied preferred node when the host remains taller', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const fixtures = populateOccupiedNeighborhood(snapshot, (gx, gy) => buildStraightFixture({
        x: gx * GRID_SPACING_MM,
        y: gy * GRID_SPACING_MM,
        tipZ: gx === 0 && gy === 0 ? 10 : 20,
        socketZ: gx === 0 && gy === 0 ? 9 : 19,
    }));
    const preferredHost = fixtures.get('0,0');
    assert.ok(preferredHost);

    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 8,
        socketZ: 7,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_leaf');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement keeps using a branch when the direct hosted span is too long for an auto-leaf', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const preferredHost = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
    });
    addTrunkBuild(snapshot, preferredHost);

    const candidate = buildStraightFixture({
        x: 1.9,
        y: 0,
        tipZ: 6,
        socketZ: 5,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_branch');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement replaces the preferred host trunk when the candidate tip is higher', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const fixtures = populateOccupiedNeighborhood(snapshot, (gx, gy) => buildStraightFixture({
        x: gx * GRID_SPACING_MM,
        y: gy * GRID_SPACING_MM,
        tipZ: gx === 0 && gy === 0 ? 6 : 20,
        socketZ: gx === 0 && gy === 0 ? 5 : 19,
    }));
    const preferredHost = fixtures.get('0,0');
    assert.ok(preferredHost);

    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'replace_trunk');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement falls back to a different reachable host when the preferred host cannot accept an attachment', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const fixtures = populateOccupiedNeighborhood(snapshot, (gx, gy) => {
        if (gx === 0 && gy === 0) {
            return buildManualHostFixture({
                x: 0,
                y: 0,
                tipZ: 7.1,
                bottomZ: 6.7,
                topZ: 6.9,
            });
        }

        if (gx === 1 && gy === 0) {
            return buildManualHostFixture({
                x: gx * GRID_SPACING_MM,
                y: gy * GRID_SPACING_MM,
                tipZ: 2.5,
                bottomZ: 0,
                topZ: 2,
            });
        }

        return buildManualHostFixture({
            x: gx * GRID_SPACING_MM,
            y: gy * GRID_SPACING_MM,
            tipZ: 8,
            bottomZ: 5,
            topZ: 7,
        });
    });
    const fallbackHost = fixtures.get('1,0');
    assert.ok(fallbackHost);

    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 6.5,
        socketZ: 6,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_branch');
    assert.equal(decision.nodeKey, '1,0');
    assert.equal(decision.hostTrunkId, fallbackHost.build.trunk.id);
});
