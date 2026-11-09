import type { Joint, LimitationCode, Segment, Vec3 } from '../../types';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getJointDiameter } from '../../constants';
import { isShaftBlocked } from '../../PlacementLogic/CollisionAvoidance';
import * as THREE from 'three';
import { toVector3 } from '../../Curves/BezierUtils';
import { assertKickstandHostKind, clampKickstandHostT } from './kickstandRules';
import {
    getKickstandKnotDiameterMm,
    getKickstandRootProfile,
    resolveKickstandLayout,
} from './kickstandSettings';
import type { KickstandBuildInput, KickstandBuildResult } from './types';
import { v4 as uuidv4 } from 'uuid';

function createJoint(id: string, pos: { x: number; y: number; z: number }, diameter: number): Joint {
    return {
        id,
        pos,
        diameter,
    };
}

function createRootAndJointHeights(input: KickstandBuildInput, rootTopZ: number) {
    const layout = resolveKickstandLayout(input.layoutOverrides);

    const hostZ = input.host.pos.z;
    const rawRise = hostZ - rootTopZ;

    // Kickstands are grounded columns first. If the host is very low,
    // keep a tiny positive vertical chain and let the terminal segment angle as needed.
    const effectiveRise = Math.max(rawRise, layout.minJointSpacingMm * 2 + layout.minTerminalClearanceMm + 0.01);

    let firstJointZ = rootTopZ + effectiveRise * layout.firstJointHeightRatio;
    let secondJointZ = rootTopZ + effectiveRise * layout.secondJointHeightRatio;

    const minFirst = rootTopZ + 0.01;
    const maxSecond = Math.max(minFirst + layout.minJointSpacingMm, hostZ - layout.minTerminalClearanceMm);

    if (secondJointZ > maxSecond) secondJointZ = maxSecond;

    const maxFirst = secondJointZ - layout.minJointSpacingMm;
    if (firstJointZ > maxFirst) firstJointZ = maxFirst;
    if (firstJointZ < minFirst) firstJointZ = minFirst;

    if (secondJointZ - firstJointZ < layout.minJointSpacingMm) {
        secondJointZ = firstJointZ + layout.minJointSpacingMm;
    }

    const maxThird = Math.max(secondJointZ + layout.minJointSpacingMm, hostZ - layout.minTerminalClearanceMm);
    const thirdJointZ = THREE.MathUtils.clamp(
        secondJointZ + Math.max(layout.minJointSpacingMm, (hostZ - secondJointZ) * 0.6),
        secondJointZ + layout.minJointSpacingMm,
        maxThird,
    );

    return { firstJointZ, secondJointZ, thirdJointZ, layout };
}

/** At least this far from horizontal, matching the shaft constraint's 80deg default. */
const DEFAULT_MAX_SHAFT_ANGLE_DEG = 80;

/** A descending run means the chain overshot its host and doubled back. */
function columnShapeError(
    segments: Segment[],
    hostPos: Vec3,
    maxShaftAngleDeg: number | undefined,
): LimitationCode | undefined {
    const limitDeg = maxShaftAngleDeg ?? DEFAULT_MAX_SHAFT_ANGLE_DEG;
    const points = columnPoints(segments, hostPos);

    for (let i = 0; i < points.length - 1; i += 1) {
        const run = new THREE.Vector3().subVectors(points[i + 1], points[i]);
        const span = run.length();
        if (span < 1e-6) continue;
        const angleFromUpDeg = THREE.MathUtils.radToDeg(
            Math.acos(THREE.MathUtils.clamp(run.z / span, -1, 1)),
        );
        if (angleFromUpDeg > limitDeg) return 'ANGLE_TOO_STEEP';
    }
    return undefined;
}

/** The column's joints bottom to top, ending at the host it reaches. */
function columnPoints(segments: Segment[], hostPos?: Vec3): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (const segment of segments) {
        if (segment.bottomJoint?.pos && points.length === 0) points.push(toVector3(segment.bottomJoint.pos));
        if (segment.topJoint?.pos) points.push(toVector3(segment.topJoint.pos));
    }
    if (hostPos) points.push(toVector3(hostPos));
    return points;
}

/** Does the column run through the model? The top run insets off its host. */
function columnCollision(
    segments: Segment[],
    bodyDiameterMm: number,
    mesh: THREE.Mesh | undefined,
): LimitationCode | undefined {
    if (!mesh) return undefined;

    const radius = Math.max(0.001, bodyDiameterMm / 2);
    const points = columnPoints(segments);

    for (let i = 0; i < points.length - 1; i += 1) {
        const start = points[i];
        const end = points[i + 1];
        const probeEnd = i === points.length - 2 ? insetTowards(end, start, radius) : end;
        if (isShaftBlocked(start, probeEnd, radius, mesh)) return 'COLLISION_WITH_MODEL';
    }
    return undefined;
}

/** `from` pulled back toward `towards`, or unchanged when the run is shorter. */
function insetTowards(from: THREE.Vector3, towards: THREE.Vector3, distanceMm: number): THREE.Vector3 {
    const run = new THREE.Vector3().subVectors(towards, from);
    const length = run.length();
    if (length <= distanceMm) return from;
    return from.clone().addScaledVector(run.divideScalar(length), distanceMm);
}

export function buildKickstandData(input: KickstandBuildInput): KickstandBuildResult {
    assertKickstandHostKind(input.host.supportKind);

    const rootProfile = getKickstandRootProfile();
    const bodyDiameterMm = Math.max(0.001, input.host.diameterMm);
    const jointDiameterMm = getJointDiameter(bodyDiameterMm);

    // A seeded build is reproducible: auto-bracing compares supports by id in
    // some tie-breaks, so a fresh uuid per run made the brace pass drift.
    const nextId = (suffix: string): string => (input.idSeed ? `${input.idSeed}-${suffix}` : uuidv4());
    const rootId = nextId('root');
    const hostKnotId = nextId('host-knot');
    const kickstandId = nextId('kickstand');

    const root = {
        id: rootId,
        modelId: input.modelId,
        transform: {
            pos: input.rootPos,
            rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: rootProfile.diameter,
        diskHeight: rootProfile.diskHeight,
        coneHeight: rootProfile.coneHeight,
    };

    const rootTopZ = input.rootPos.z + root.diskHeight + root.coneHeight;
    const { firstJointZ, secondJointZ, thirdJointZ } = createRootAndJointHeights(input, rootTopZ);

    const joint1 = createJoint(
        nextId('j1'),
        {
            x: input.rootPos.x,
            y: input.rootPos.y,
            z: firstJointZ,
        },
        jointDiameterMm,
    );

    const joint2 = createJoint(
        nextId('j2'),
        {
            x: input.rootPos.x,
            y: input.rootPos.y,
            z: secondJointZ,
        },
        jointDiameterMm,
    );

    const topBlend = 0.65;
    const joint3 = createJoint(
        nextId('j3'),
        {
            x: input.rootPos.x + (input.host.pos.x - input.rootPos.x) * topBlend,
            y: input.rootPos.y + (input.host.pos.y - input.rootPos.y) * topBlend,
            z: thirdJointZ,
        },
        jointDiameterMm,
    );

    const segment1: Segment = {
        id: nextId('s1'),
        diameter: bodyDiameterMm,
        topJoint: joint1,
    };

    const segment2: Segment = {
        id: nextId('s2'),
        diameter: bodyDiameterMm,
        bottomJoint: joint1,
        topJoint: joint2,
    };

    const terminalSegment: Segment = {
        id: nextId('s4'),
        diameter: bodyDiameterMm,
        bottomJoint: joint3,
    };

    const upperSegment: Segment = {
        id: nextId('s3'),
        diameter: bodyDiameterMm,
        bottomJoint: joint2,
        topJoint: joint3,
    };

    const hostT = clampKickstandHostT(input.host.t, input.host.minT ?? 0);

    const hostKnot = {
        id: hostKnotId,
        parentShaftId: input.host.segmentId,
        t: hostT,
        pos: input.host.pos,
        diameter: getKickstandKnotDiameterMm(input.host.diameterMm),
    };

    // An authored column is already straight, so it keeps that shape: one column
    // segment and one terminal. The derived joints exist to give a placed
    // kickstand something to drag, and would bend it.
    const columnTop = input.authoredColumn
        ? createJoint(nextId('column-top'), input.authoredColumn.topPos, jointDiameterMm)
        : null;
    const segments = columnTop
        ? [
            { id: nextId('s1'), diameter: bodyDiameterMm, topJoint: columnTop },
            { id: nextId('s2'), diameter: bodyDiameterMm, bottomJoint: columnTop },
        ]
        : [segment1, segment2, upperSegment, terminalSegment];

    const kickstand = {
        id: kickstandId,
        // Stamped here, not only by the store: auto-bracing builds a kickstand
        // into a local snapshot before committing it, and the type resolver
        // falls back to store membership for an unstamped entity. Without this
        // the fresh kickstand has no resolvable segments, so the brace pass
        // gives it no samples and never braces it to its host.
        typeId: 'kickstand' as const,
        modelId: input.modelId,
        rootId,
        hostKnotId,
        hostSegmentId: input.host.segmentId,
        hostMinT: input.host.minT ?? 0,
        segments,
        profile: {
            bodyDiameterMm,
            terminalStartDiameterMm: bodyDiameterMm,
            terminalEndDiameterMm: Math.max(0.001, input.host.diameterMm),
        },
    };

    return {
        root,
        hostKnot,
        kickstand,
        error: columnShapeError(segments, hostKnot.pos, input.maxShaftAngleDeg)
            ?? columnCollision(segments, bodyDiameterMm, input.collisionMesh),
    };
}

export function toKickstandPreviewData(build: KickstandBuildResult): SupportData {
    const lastIndex = build.kickstand.segments.length - 1;

    const previewSegments = build.kickstand.segments.map((segment, index) => {
        if (index !== lastIndex) return segment;
        return {
            ...segment,
            topJoint: {
                id: `preview-terminal-${build.kickstand.id}`,
                pos: build.hostKnot.pos,
                diameter: build.hostKnot.diameter ?? build.kickstand.profile.terminalEndDiameterMm,
            },
        };
    });

    return {
        id: build.kickstand.id,
        roots: build.root,
        segments: previewSegments,
        knot: build.hostKnot,
        error: build.error,
    };
}
