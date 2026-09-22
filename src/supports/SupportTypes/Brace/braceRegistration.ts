import * as THREE from 'three';

import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import { bezierToLineSegments } from '../../Curves/BezierUtils';
import type { Brace, Knot } from '../../types';
import './braceProxyGeometry';
import './braceMarqueeShape';
import './braceSettle';

// A brace spans two knots and touches neither model nor plate, so its export
// geometry is one shaft between them -- curved when the entity says so. Its
// diameter falls back to the mean of the two knots, because a brace has no root
// to take a diameter from.
registerSupportExportGroup<Brace>('brace', (brace, context) => {
    const startKnot: Knot | undefined = context.supportState.knots[brace.startKnotId];
    const endKnot: Knot | undefined = context.supportState.knots[brace.endKnotId];
    if (!startKnot || !endKnot) return null;

    const modelId = brace.modelId
        ?? context.modelIdOf(brace.startKnotId)
        ?? context.modelIdOf(brace.endKnotId);

    const group = new THREE.Group();
    addModelMetadata(group, modelId);

    const diameter = Math.max(
        0.001,
        brace.profile?.diameter
            ?? Math.max(0.001, ((startKnot.diameter ?? 1.2) + (endKnot.diameter ?? 1.2)) * 0.5),
    );

    if (brace.curve?.type === 'bezier') {
        const points = bezierToLineSegments(
            startKnot.pos,
            brace.curve.controlPoint1,
            brace.curve.controlPoint2,
            endKnot.pos,
            brace.curve.resolution,
        );
        for (let i = 0; i < points.length - 1; i += 1) {
            const shaft = SupportGeometryGenerator.generateShaftMesh(
                new THREE.Vector3(points[i].x, points[i].y, points[i].z),
                new THREE.Vector3(points[i + 1].x, points[i + 1].y, points[i + 1].z),
                diameter,
            );
            if (shaft) group.add(shaft);
        }
        return group;
    }

    const shaft = SupportGeometryGenerator.generateShaftMesh(
        new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z),
        new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z),
        diameter,
    );
    if (shaft) group.add(shaft);

    return group;
});

// Registered here rather than in the store's own list: a brace recomputes its curve and the knots riding it.

