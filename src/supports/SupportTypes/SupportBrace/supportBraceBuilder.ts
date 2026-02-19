import type { Joint, Segment } from '../../types';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getJointDiameter } from '../../constants';
import * as THREE from 'three';
import { assertSupportBraceHostKind, clampSupportBraceHostT } from './supportBraceRules';
import {
    getSupportBraceBodyDiameterMm,
    getSupportBraceKnotDiameterMm,
    getSupportBraceRootProfile,
    resolveSupportBraceLayout,
} from './supportBraceSettings';
import type { SupportBraceBuildInput, SupportBraceBuildResult } from './types';

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

function createRootAndJointHeights(input: SupportBraceBuildInput, rootTopZ: number) {
    const layout = resolveSupportBraceLayout(input.layoutOverrides);

    const hostZ = input.host.pos.z;
    const rawRise = hostZ - rootTopZ;

    // Support braces are grounded columns first. If the host is very low,
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

export function buildSupportBraceData(input: SupportBraceBuildInput): SupportBraceBuildResult {
    assertSupportBraceHostKind(input.host.supportKind);

    const rootProfile = getSupportBraceRootProfile();
    const bodyDiameterMm = getSupportBraceBodyDiameterMm();
    const jointDiameterMm = getJointDiameter(bodyDiameterMm);

    const rootId = uuid();
    const hostKnotId = uuid();
    const supportBraceId = uuid();

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

    const hostT = clampSupportBraceHostT(input.host.t, input.host.minT ?? 0);

    const hostKnot = {
        id: hostKnotId,
        parentShaftId: input.host.segmentId,
        t: hostT,
        pos: input.host.pos,
        diameter: getSupportBraceKnotDiameterMm(input.host.diameterMm),
    };

    const supportBrace = {
        id: supportBraceId,
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
        supportBrace,
    };
}

export function toSupportBracePreviewData(build: SupportBraceBuildResult): SupportData {
    const lastIndex = build.supportBrace.segments.length - 1;

    const previewSegments = build.supportBrace.segments.map((segment, index) => {
        if (index !== lastIndex) return segment;
        return {
            ...segment,
            topJoint: {
                id: `preview-terminal-${build.supportBrace.id}`,
                pos: build.hostKnot.pos,
                diameter: build.hostKnot.diameter ?? build.supportBrace.profile.terminalEndDiameterMm,
            },
        };
    });

    return {
        id: build.supportBrace.id,
        roots: build.root,
        segments: previewSegments,
        knot: build.hostKnot,
    };
}
