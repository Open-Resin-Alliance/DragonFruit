import type * as THREE from 'three';
import { registerContactBridgeBuilder } from '../../supportTypeRegistry';
import { buildStick } from './stickBuilder';
import { isShaftVerticalEnough } from './stickVerticality';

// A stick bridges two model contacts, so it can be built from the type id
// alone once the registry has chosen it by contact span.
//
// The verticality gate belongs here rather than at the caller: a stick that
// cants too far is not a bridge, and refusing to build one is a fact about
// sticks, not about whoever asked for one.
registerContactBridgeBuilder('stick', (request) => {
    const { stick, error } = buildStick({
        modelId: request.modelId,
        aPos: request.aPos,
        aNormal: request.aNormal,
        bPos: request.bPos,
        bNormal: request.bNormal,
        shaftDiameterMm: request.shaftDiameterMm,
        tipContactDiameterMm: request.tipContactDiameterMm,
        mesh: request.mesh as THREE.Mesh | undefined,
    });
    if (!stick || !isShaftVerticalEnough(stick)) return null;
    return { entity: stick, error };
});
