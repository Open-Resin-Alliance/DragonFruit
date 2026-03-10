import type { Joint, Segment } from '../../types';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getJointDiameter } from '../../constants';
import * as THREE from 'three';
import { assertKickstandHostKind, clampKickstandHostT } from './kickstandRules';
import {
    getKickstandKnotDiameterMm,
    getKickstandRootProfile,
    resolveKickstandLayout,
} from './kickstandSettings';
import type { KickstandBuildInput, KickstandBuildResult } from './types';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function createJoint(pos: { x: number; y: number; z: number }, diameter: number): Joint {
    return {
        id: uuid(),
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

export function buildKickstandData(input: KickstandBuildInput): KickstandBuildResult {
    assertKickstandHostKind(input.host.supportKind);

    const rootProfile = getKickstandRootProfile();
    const bodyDiameterMm = Math.max(0.001, input.host.diameterMm);
    const jointDiameterMm = getJointDiameter(bodyDiameterMm);

    const rootId = uuid();
    const hostKnotId = uuid();
    const kickstandId = uuid();

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
        {
            x: input.rootPos.x,
            y: input.rootPos.y,
            z: firstJointZ,
        },
        jointDiameterMm,
    );

    const joint2 = createJoint(
        {
            x: input.rootPos.x,
            y: input.rootPos.y,
            z: secondJointZ,
        },
        jointDiameterMm,
    );

    const topBlend = 0.65;
    const joint3 = createJoint(
        {
            x: input.rootPos.x + (input.host.pos.x - input.rootPos.x) * topBlend,
            y: input.rootPos.y + (input.host.pos.y - input.rootPos.y) * topBlend,
            z: thirdJointZ,
        },
        jointDiameterMm,
    );

    const segment1: Segment = {
        id: uuid(),
        diameter: bodyDiameterMm,
        topJoint: joint1,
    };

    const segment2: Segment = {
        id: uuid(),
        diameter: bodyDiameterMm,
        bottomJoint: joint1,
        topJoint: joint2,
    };

    const terminalSegment: Segment = {
        id: uuid(),
        diameter: bodyDiameterMm,
        bottomJoint: joint3,
    };

    const upperSegment: Segment = {
        id: uuid(),
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

    const kickstand = {
        id: kickstandId,
        modelId: input.modelId,
        rootId,
        hostKnotId,
        hostSegmentId: input.host.segmentId,
        hostMinT: input.host.minT ?? 0,
        segments: [segment1, segment2, upperSegment, terminalSegment],
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
    };
}
