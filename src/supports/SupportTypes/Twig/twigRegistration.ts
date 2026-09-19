import * as THREE from 'three';
import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, appendShafts, globalPenetrationMm, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { Vec3 } from '../../types';
import { registerContactBridgeBuilder, registerKnotDiameterRule } from '../../supportTypeRegistry';
import type { Twig } from '../../types';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from './twigTaper';
import { buildTwig } from './twigBuilder';
import './twigProxyGeometry';
import './twigMarqueeShape';

// Twigs taper along their length, so a knot on one is sized from the taper
// rather than the generic segment-diameter rule.
registerKnotDiameterRule<Twig>('twig', (twig, segmentId, t) => {
    const local = resolveTwigDiameterAtSegmentT(twig, segmentId, t);
    return local !== null && local > 0 ? twigJointDiameterForLocalDiameter(local) : null;
});

// A twig bridges two model contacts, so it can be built from the type id
// alone once the registry has chosen it by contact span.
registerContactBridgeBuilder('twig', (request) => {
    const { twig, error } = buildTwig({
        modelId: request.modelId,
        aPos: request.aPos,
        aNormal: request.aNormal,
        bPos: request.bPos,
        bNormal: request.bNormal,
        tipContactDiameterMm: request.tipContactDiameterMm,
        mesh: request.mesh as THREE.Mesh | undefined,
    });
    return twig ? { entity: twig, error } : null;
});

/**
 * Where a contact disk's tip centre sits, given the disk's standoff.
 *
 * The disk is drawn as a flat pad; the shaft runs to the CENTRE of that pad, so
 * the exported shaft length depends on the disk thickness rather than the disk
 * position alone.
 */
function twigDiskTipCenter(disk: Twig['contactDiskA']): Vec3 {
    const thickness = disk.diskLengthOverride
        ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
    return {
        x: disk.pos.x + (disk.surfaceNormal.x * thickness),
        y: disk.pos.y + (disk.surfaceNormal.y * thickness),
        z: disk.pos.z + (disk.surfaceNormal.z * thickness),
    };
}

// A twig runs between two contact DISKS rather than cones, and its joints are
// shared between neighbouring segments, so the shaft is walked once and each
// joint drawn the first time it is seen.
registerSupportExportGroup<Twig>('twig', (twig) => {
    const startPos = twigDiskTipCenter(twig.contactDiskA);
    const endPos = twigDiskTipCenter(twig.contactDiskB);
    const group = new THREE.Group();
    addModelMetadata(group, twig.modelId);

    const seenJointIds = new Set<string>();
    let currentStart = startPos;

    twig.segments.forEach((segment, index) => {
        if (segment.bottomJoint && !seenJointIds.has(segment.bottomJoint.id)) {
            seenJointIds.add(segment.bottomJoint.id);
            group.add(SupportGeometryGenerator.generateJointMesh(segment.bottomJoint));
        }

        const isLast = index === twig.segments.length - 1;
        const end = segment.topJoint ? segment.topJoint.pos : isLast ? endPos : currentStart;

        appendShafts(group, segment, segment.bottomJoint?.pos ?? currentStart, end);

        if (segment.topJoint && !seenJointIds.has(segment.topJoint.id)) {
            seenJointIds.add(segment.topJoint.id);
            group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
        }

        currentStart = end;
    });

    const diskMesh = (disk: Twig['contactDiskA']) => SupportGeometryGenerator.generateContactDiskMesh({
        pos: disk.pos,
        normal: disk.coneAxis,
        surfaceNormal: disk.surfaceNormal,
        diskLengthOverride: disk.diskLengthOverride,
        profile: disk.profile,
        contactDiameterMm: disk.contactDiameterMm,
    }, globalPenetrationMm());

    for (const disk of [twig.contactDiskA, twig.contactDiskB]) {
        const mesh = diskMesh(disk);
        if (mesh.children.length > 0) group.add(mesh);
    }

    return group;
});
