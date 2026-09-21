import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import type { TrunkPlacementResult } from '../PlacementLogic/StandardPlacement';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone';
import { getResolvedSnappedNodeKey } from '../SupportTypes/Trunk/trunkRouteResolution';
import { gridNodeKeyFromXY } from '../PlacementLogic/Grid/gridMath';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { SupportState } from '../types';
import {
    buildTrunkData,
    buildTrunkDataFromPlacement,
    type TrunkBuildInput,
    type TrunkBuildResult,
} from '../SupportTypes/Trunk/trunkBuilder';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
        kickstands: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
    };
}

function makePlacement(args: {
    x: number;
    y: number;
    socketZ: number;
    baseX?: number;
    baseY?: number;
    joints?: TrunkPlacementResult['joints'];
    constructionJoints?: TrunkPlacementResult['constructionJoints'];
}): TrunkPlacementResult {
    const baseX = args.baseX ?? args.x;
    const baseY = args.baseY ?? args.y;
    return {
        basePos: { x: baseX, y: baseY, z: 0 },
        socketPos: { x: args.x, y: args.y, z: args.socketZ },
        unsnappedBottomPos: { x: baseX, y: baseY, z: 0 },
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
    baseX?: number;
    baseY?: number;
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
        makePlacement({ x: args.x, y: args.y, socketZ: args.socketZ, baseX: args.baseX, baseY: args.baseY }),
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

test('decideGridPlacement merges into the occupied preferred node when the candidate is taller', () => {
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

    // A trunk already standing on the node is never replaced: the taller
    // contact attaches to it, so the pillar keeps carrying everything it
    // already serves instead of being torn out and rebuilt around the new tip.
    if (decision.kind !== 'place_branch' && decision.kind !== 'place_leaf') {
        assert.fail(`expected an attachment to the occupied node, got ${decision.kind}`);
    }
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

    // High enough that no knot on the host can reach it inside the leaf span:
    // the host's knots top out at its socket, so every candidate span here is
    // longer than an auto-leaf allows.
    const candidate = buildStraightFixture({
        x: 1.9,
        y: 0,
        tipZ: 16,
        socketZ: 15,
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

test('decideGridPlacement still merges into the preferred node when a candidate tip is higher and neighbours are taller', () => {
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

    // A trunk already standing on the node is never replaced: the taller
    // contact attaches to it, so the pillar keeps carrying everything it
    // already serves instead of being torn out and rebuilt around the new tip.
    if (decision.kind !== 'place_branch' && decision.kind !== 'place_leaf') {
        assert.fail(`expected an attachment to the occupied node, got ${decision.kind}`);
    }
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, preferredHost.build.trunk.id);
});

test('decideGridPlacement rejects when the fixed preferred host cannot accept an attachment', () => {
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
            // Keep Z height out of candidate's (tipZ=6.5) branch angle reach (Z 5 to 7)
            return buildManualHostFixture({
                x: gx * GRID_SPACING_MM,
                y: gy * GRID_SPACING_MM,
                tipZ: 8,
                bottomZ: 5,
                topZ: 7,
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
    assert.ok(fixtures.get('1,0'));

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

    assert.equal(decision.kind, 'reject');
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.reason, 'NO_VALID_ATTACHMENT');
    // The preview draws this trunk as a ghost: without a reason on it the ghost
    // of a second pillar on the node reads as a placement that works.
    assert.equal(decision.trunkBuild?.supportData.error, 'TOO_CLOSE_TO_EXISTING');
});

test('decideGridPlacement applies the same trunk collision gate for preview and commit', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
    });

    const blocker = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial(),
    );
    blocker.position.set(0, 0, 4.5);
    blocker.updateMatrixWorld(true);

    const baseArgs = {
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
        mesh: blocker,
    };

    const previewDecision = decideGridPlacement({
        ...baseArgs,
        isPreview: true,
    });
    const commitDecision = decideGridPlacement(baseArgs);

    assert.equal(previewDecision.kind, 'reject');
    assert.equal(commitDecision.kind, 'reject');
    assert.equal(previewDecision.nodeKey, '0,0');
    assert.equal(commitDecision.nodeKey, '0,0');
    assert.equal(previewDecision.reason, 'COLLISION_WITH_MODEL');
    assert.equal(commitDecision.reason, 'COLLISION_WITH_MODEL');
});

test('decideGridPlacement places branch on neighbor host when co-located host cannot accept attachment but neighbor is valid', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    // Co-located host too high
    const preferredHost = buildManualHostFixture({
        x: 0,
        y: 0,
        tipZ: 7.1,
        bottomZ: 6.7,
        topZ: 6.9,
    });
    addTrunkBuild(snapshot, preferredHost);

    // Neighbor host at 1,0 is valid (bottomZ=0, topZ=2)
    const neighborHost = buildManualHostFixture({
        x: 1 * GRID_SPACING_MM,
        y: 0,
        tipZ: 2.5,
        bottomZ: 0,
        topZ: 2,
    });
    addTrunkBuild(snapshot, neighborHost);

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
    assert.equal(decision.nodeKey, '1,0'); // Snapped to neighbor node
    assert.equal(decision.hostTrunkId, neighborHost.build.trunk.id);
});

test('decideGridPlacement rejects an anchor whose tip sits below the root joint and previews the ghost', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 0.5, // Below the anchor root joint (~1.1mm) — shaft would dip into -Z
        socketZ: 0.4,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: MODEL_ID,
    });

    if (decision.kind !== 'reject' || decision.reason !== 'ANCHOR_BELOW_ROOT') {
        assert.fail(`expected ANCHOR_BELOW_ROOT reject, got ${decision.kind}`);
    }
    // Ghost preview carries the reason so the hover tooltip can render it.
    assert.equal(decision.supportData?.error, 'ANCHOR_BELOW_ROOT');
});

test('decideGridPlacement places a valid anchor for an above-root near-plate tip', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    const candidate = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 3,
        socketZ: 2.5,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: MODEL_ID,
    });
    if (decision.kind !== 'place_anchor') assert.fail(`expected place_anchor, got ${decision.kind}`);
    const anchor = decision.anchor;
    const socketZ = getFinalSocketPosition(anchor.contactCone).z;
    const lowestShaftZ = Math.min(anchor.contactCone.pos.z, socketZ);
    assert.ok(
        lowestShaftZ >= anchor.joint.pos.z - 1e-3,
        `shaft dips below the root joint: ${lowestShaftZ} < ${anchor.joint.pos.z}`,
    );
    assert.ok(
        Math.abs(socketZ - anchor.joint.pos.z) <= 1e-3,
        `cone socket does not land on the root joint: ${socketZ} vs ${anchor.joint.pos.z}`,
    );
});

/** Jaw chip overhanging a body slab: a straight pillar from the tip pierces the body. */
function makeOverhangMesh(): THREE.Mesh {
    const body = new THREE.BoxGeometry(25, 20, 10);
    body.translate(-7.5, 0, 5);
    const jaw = new THREE.BoxGeometry(4, 4, 2);
    jaw.translate(3.5, 0, 17);
    const geometry = mergeGeometries([body, jaw])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('grid mode routes a tip under an overhang instead of refusing to reach it', () => {
    initializeBVH();
    const settings = makeSettings();
    setSettings(settings);
    const mesh = makeOverhangMesh();
    const tipPos = { x: 4, y: 0, z: 16 };
    const tipNormal = { x: 0, y: 0, z: -1 };

    // Grid mode used to build this candidate with no mesh, so the shaft went
    // straight down from the socket, pierced the body, and the node was
    // refused. It routes now, and the router's base is already a grid node.
    const trunk = buildTrunkData({ tipPos, tipNormal, modelId: MODEL_ID, mesh });
    assert.equal(trunk.error, undefined, `the tip is reachable (${trunk.error})`);
    assert.ok(trunk.route.joints.length >= 1,
        'the pillar has to tilt out from under the jaw, so it cannot be a straight drop');
    assert.ok(getResolvedSnappedNodeKey(trunk.route), 'the router committed its base to a grid node');

    // The committed chain clears the mesh at the same clearance the
    // post-thickening cull uses, so nothing here is placed and then deleted.
    const root = trunk.root;
    for (const seg of trunk.trunk.segments) {
        const start = seg.bottomJoint?.pos ?? root.transform.pos;
        const end = seg.topJoint?.pos;
        assert.ok(end, 'segment has endpoints');
        assert.equal(isShaftBlocked(start, end, (seg.diameter ?? 1) / 2 + 0.15, mesh), false,
            'every grid-mode segment clears the mesh');
    }

    const decision = decideGridPlacement({
        settings,
        snapshot: makeEmptySnapshot(),
        candidate: trunk,
        tipPos,
        tipNormal,
        modelId: MODEL_ID,
        mesh,
    });
    assert.equal(decision.kind, 'place_trunk');
});

// ---------------------------------------------------------------------------
// The grid is a convenience for where the base lands, not a licence to break
// the shape rule, and not a reason to plant a pillar on top of an existing one.
// ---------------------------------------------------------------------------

/** Lean of a trunk's own segments, in degrees from vertical. */
function trunkSegmentLeansDeg(fixture: Pick<FixtureBuild, 'build'>): number[] {
    const root = fixture.build.root;
    const cone = fixture.build.trunk.contactCone;
    const topZ = fixture.build.trunk.segments[fixture.build.trunk.segments.length - 1]?.topJoint?.pos;
    return fixture.build.trunk.segments.map((seg) => {
        const start = seg.bottomJoint?.pos ?? root.transform.pos;
        const end = seg.topJoint?.pos ?? (cone ? getFinalSocketPosition(cone) : { x: start.x, y: start.y, z: topZ?.z ?? start.z });
        const rise = end.z - start.z;
        const lateral = Math.hypot(end.x - start.x, end.y - start.y);
        return (Math.atan2(lateral, Math.max(rise, 1e-6)) * 180) / Math.PI;
    });
}

/** Slab with a low jaw reaching out at ~7mm: the contact sits barely above the anchor band. */
function makeLowOverhangMesh(): THREE.Mesh {
    const body = new THREE.BoxGeometry(25, 20, 8);
    body.translate(-9, 0, 4);
    const jaw = new THREE.BoxGeometry(6, 20, 2);
    jaw.translate(3, 0, 7);
    const geometry = mergeGeometries([body, jaw])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
}

test('a low contact whose grid node would need a flatter shaft than 45 degrees drops the grid', () => {
    initializeBVH();
    const settings = makeSettings();
    setSettings(settings);
    const mesh = makeLowOverhangMesh();
    const tipPos = { x: 6, y: 0, z: 6.2 };
    const tipNormal = { x: 0, y: 0, z: -1 };

    // The column under this contact is clear, but the node nearest it is 2 mm out
    // and the contact sits ~1.6 mm above the root top: a 45 degree diagonal needs
    // more height than that, so the grid drop would close the gap with a
    // near-horizontal elbow (measured at 74 degrees from vertical).
    const trunk = buildTrunkData({ tipPos, tipNormal, modelId: MODEL_ID, mesh });
    assert.equal(trunk.error, undefined, `the tip is reachable (${trunk.error})`);
    assert.equal(getResolvedSnappedNodeKey(trunk.route), null,
        'the grid is ignored rather than met with a shaft past 45 degrees');
    for (const leanDeg of trunkSegmentLeansDeg({ build: trunk })) {
        assert.ok(leanDeg <= 45 + 1e-6, `every routed span stays inside the shape rule, got ${leanDeg}`);
    }

    // The decision must not put the snap back: it is the same node, and the same
    // flat span, whether the snap happens in the router or in the decision.
    const decision = decideGridPlacement({
        settings,
        snapshot: makeEmptySnapshot(),
        candidate: trunk,
        tipPos,
        tipNormal,
        modelId: MODEL_ID,
        mesh,
    });
    assert.equal(decision.kind, 'place_trunk');
    if (decision.kind !== 'place_trunk') return;
    assert.equal(decision.nodeKey, 'unsnapped');
    assert.equal(decision.trunkBuild.root.transform.pos.x, 6, 'the clear column under the contact stands');
    for (const leanDeg of trunkSegmentLeansDeg({ build: decision.trunkBuild })) {
        assert.ok(leanDeg <= 45 + 1e-6, `the placed trunk stays inside the shape rule, got ${leanDeg}`);
    }
});

test('a snap that keeps the shaft inside 45 degrees still lands on the node', () => {
    const settings = makeSettings();
    setSettings(settings);

    // Same 2 mm snap, but 10 mm of rise under it: 11 degrees, well inside the rule.
    const candidate = buildStraightFixture({ x: 2, y: 0, tipZ: 10, socketZ: 10 });

    const decision = decideGridPlacement({
        settings,
        snapshot: makeEmptySnapshot(),
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    assert.equal(decision.kind, 'place_trunk');
    assert.equal(decision.nodeKey, '1,0');
    if (decision.kind !== 'place_trunk') return;
    assert.equal(decision.trunkBuild.root.transform.pos.x, 4, 'the base lands on the node');
});

test('a trunk standing between nodes still takes the merge for the node it covers', () => {
    const settings = makeSettings();
    setSettings(settings);

    // A hand-placed root 2 mm off node (0,0) keys to the neighbouring node (1,0),
    // so a key lookup at (0,0) finds no host: the point is occupied all the same.
    const snapshot = makeEmptySnapshot();
    const host = buildStraightFixture({ x: 2, y: 0, tipZ: 10, socketZ: 9 });
    addTrunkBuild(snapshot, host);

    const candidate = buildStraightFixture({ x: 0, y: 0, tipZ: 6, socketZ: 5 });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    if (decision.kind !== 'place_branch' && decision.kind !== 'place_leaf') {
        assert.fail(`expected a merge into the trunk already standing there, got ${decision.kind}`);
    }
    assert.equal(decision.hostTrunkId, host.build.trunk.id);
});

test('decideGridPlacement merges into a trunk standing off-grid whose contact holds the node', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    // The grid could not be met at 45 degrees, so the base stands routed away
    // from the contact it carries (gridIgnored): its root is not on this node.
    const offGridHost = buildStraightFixture({
        x: 0,
        y: 0,
        tipZ: 10,
        socketZ: 9,
        baseX: 2.5,
    });
    addTrunkBuild(snapshot, offGridHost);
    assert.equal(
        gridNodeKeyFromXY(offGridHost.build.root.transform.pos.x, offGridHost.build.root.transform.pos.y, GRID_SPACING_MM),
        '1,0',
        'fixture premise: the routed base is keyed to a neighbouring node',
    );

    const candidate = buildStraightFixture({
        x: -0.5,
        y: 0,
        tipZ: 9.5,
        socketZ: 8.5,
    });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    // The contact is what occupies the point: a second pillar beside the first
    // is a preview that overlaps it and a placement the click refuses.
    if (decision.kind !== 'place_branch' && decision.kind !== 'place_leaf') {
        assert.fail(`expected an attachment to the trunk serving this node, got ${decision.kind}`);
    }
    assert.equal(decision.nodeKey, '0,0');
    assert.equal(decision.hostTrunkId, offGridHost.build.trunk.id);
});

test('a neighbour leaning over a node does not hide the pillar standing on it', () => {
    const settings = makeSettings();
    setSettings(settings);

    const snapshot = makeEmptySnapshot();
    // The pillar standing on the node the candidate wants.
    const standing = buildStraightFixture({ x: 0, y: 0, tipZ: 8, socketZ: 7 });
    addTrunkBuild(snapshot, standing);

    // A neighbour one node over, whose shaft leans back over this node: its
    // base keys to (1,0), its contact lands in (0,0) — the same key as the
    // pillar standing there.
    const leaning = buildStraightFixture({ x: 8, y: 0, tipZ: 12, socketZ: 11 });
    const leaningSegment = {
        ...leaning.build.trunk.segments[0],
        topJoint: {
            ...leaning.build.trunk.segments[0].topJoint!,
            pos: { x: 1.5, y: 0, z: 11 },
        },
    };
    leaning.build.trunk = {
        ...leaning.build.trunk,
        segments: [leaningSegment],
        contactCone: { ...leaning.build.trunk.contactCone!, pos: { x: 1.5, y: 0, z: 12 } },
    };
    addTrunkBuild(snapshot, leaning);

    assert.equal(
        gridNodeKeyFromXY(leaning.build.root.transform.pos.x, leaning.build.root.transform.pos.y, GRID_SPACING_MM),
        '2,0',
        'fixture premise: the leaning trunk stands on another node',
    );
    assert.equal(
        gridNodeKeyFromXY(leaning.build.trunk.contactCone!.pos.x, leaning.build.trunk.contactCone!.pos.y, GRID_SPACING_MM),
        '0,0',
        'fixture premise: the leaning trunk contact covers the candidate node',
    );

    // A low tip directly over the pillar standing on (0,0). The leaning
    // neighbour cannot reach it: its shaft is millimetres away at this height,
    // so the merge has to be the pillar underneath.
    const candidate = buildStraightFixture({ x: 0, y: 0, tipZ: 6, socketZ: 5 });

    const decision = decideGridPlacement({
        settings,
        snapshot,
        candidate: candidate.build,
        tipPos: candidate.input.tipPos,
        tipNormal: candidate.input.tipNormal,
        modelId: MODEL_ID,
    });

    if (decision.kind !== 'place_branch' && decision.kind !== 'place_leaf') {
        assert.fail(`expected a merge into the pillar standing on the node, got ${decision.kind}`);
    }
    assert.equal(decision.hostTrunkId, standing.build.trunk.id);
});
