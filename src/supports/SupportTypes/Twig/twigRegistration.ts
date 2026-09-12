import type * as THREE from 'three';
import { registerContactBridgeBuilder, registerKnotDiameterRule } from '../../supportTypeRegistry';
import type { Twig } from '../../types';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from './twigTaper';
import { buildTwig } from './twigBuilder';

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
