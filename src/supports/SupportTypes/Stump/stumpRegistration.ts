import * as THREE from 'three';

import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, appendConeGeometry, appendShafts, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { Stump, Vec3 } from '../../types';

// The stump puts its own primitive in the near-plate band, overriding
// auto-placement's default trunk. Registered here because the stub's geometry is
// the stump's; the grid engine only decides WHICH type claims a tip height.
import './stumpAutoPlacement';
import './stumpProxyGeometry';
import './stumpMarqueeShape';

// A stump is a near-plate stub: a frustum root, one joint, one segment and a
// contact cone. It has no Roots entry -- the frustum is its root -- so its
// geometry is built here rather than through the shared generator.
registerSupportExportGroup<Stump>('stump', (stump) => {
    const group = new THREE.Group();
    addModelMetadata(group, stump.modelId);

    const rootHeight = Math.max(0.001, stump.rootHeight);
    const rootMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(
            Math.max(0.001, stump.rootTopDiameter / 2),
            Math.max(0.001, stump.rootBaseDiameter / 2),
            rootHeight,
            20,
        ),
    );
    rootMesh.position.set(stump.rootPos.x, stump.rootPos.y, stump.rootPos.z + (rootHeight / 2));
    rootMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1));
    group.add(rootMesh);

    group.add(SupportGeometryGenerator.generateJointMesh(stump.joint));

    let currentStart: Vec3 = stump.joint.pos;
    stump.segments.forEach((segment) => {
        const end = segment.topJoint
            ? segment.topJoint.pos
            : stump.contactCone
                ? getFinalSocketPosition(stump.contactCone)
                : currentStart;

        appendShafts(group, segment, currentStart, end);

        if (segment.topJoint) {
            group.add(SupportGeometryGenerator.generateJointMesh(segment.topJoint));
        }

        currentStart = end;
    });

    appendConeGeometry(group, stump.contactCone);
    return group;
});

// No bespoke updater: stump declares `hasEditableSettings: false` and no knot
// rides its segment, so the generic pass covers it.
