import * as THREE from 'three';
import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, appendShafts, raftSettingsFor, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import type { Kickstand, Vec3 } from '../../types';
import { registerLateralStabiliser, type LateralStabiliserRequest } from '../../supportTypeRegistry';
import type { SupportState } from '../../types';
import type { AutoBracingSettings } from '../../autoBracing/settings';
import { generateRequiredKickstands } from './kickstandStabiliser';
import './kickstandProxyGeometry';
import './kickstandMarqueeShape';

/**
 * A kickstand stabilises a shaft without needing a partner to brace against,
 * so auto-bracing can ask for one when no neighbouring shaft is in reach.
 */
registerLateralStabiliser('kickstand', (request: LateralStabiliserRequest) => generateRequiredKickstands(
    request.snapshot as SupportState,
    request.existing as Pick<SupportState, 'kickstands' | 'roots' | 'knots'>,
    request.settings as AutoBracingSettings,
    request.existingEdges as Array<{ a: string; b: string; angleRad: number }>,
    request.gridSettings,
));

// A kickstand stands on its own plate root and ends on the host knot it braces,
// so both ends come from the live store rather than from the entity.
registerSupportExportGroup<Kickstand>('kickstand', (kickstand, context) => {
    const root = context.supportState.roots[kickstand.rootId];
    const hostKnot = context.supportState.knots[kickstand.hostKnotId];
    if (!root || !hostKnot) return null;

    const modelId = kickstand.modelId
        ?? root.modelId
        ?? context.modelIdOf(kickstand.hostKnotId)
        ?? context.modelIdOf(kickstand.hostSegmentId);

    const group = new THREE.Group();
    addModelMetadata(group, modelId);
    group.add(SupportGeometryGenerator.generateRootsMesh(
        root,
        kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm,
        raftSettingsFor(modelId),
    ));

    const effectiveDiskHeight = Math.max(0.001, root.diskHeight);
    let currentStart: Vec3 = {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + effectiveDiskHeight + Math.max(0, root.coneHeight),
    };

    kickstand.segments.forEach((segment, index) => {
        const isLast = index === kickstand.segments.length - 1;
        const end = segment.topJoint ? segment.topJoint.pos : isLast ? hostKnot.pos : currentStart;
        appendShafts(group, segment, currentStart, end);
        if (segment.topJoint) group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
        currentStart = end;
    });

    return group;
});
