import type * as THREE from 'three';

import { registerContactOverride, type PlacedSupport } from '../../supportTypeRegistry';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { buildStumpData } from './stumpBuilder';

/**
 * The stump's build, overriding auto-placement's default for its band.
 *
 * Auto-placement stands a trunk on a contact by default. A stump claims the
 * near-plate band through the `tipHeight` rule on its descriptor and puts a stub
 * there instead. Registered here, so the grid engine builds whatever a contact's
 * type declares without importing this module.
 */
registerContactOverride('stump', (request) => {
    const built = buildStumpData({
        tipPos: request.tipPos,
        tipNormal: request.tipNormal,
        modelId: request.modelId,
        // The registry passes a structural mesh so it need not depend on the
        // renderer; the builder wants the real one, and only ever reads it.
        mesh: request.mesh as THREE.Mesh | undefined,
    });

    const { stump, supportData } = built;
    const placed: PlacedSupport = {
        // A stump declares no `edges`: its frustum root IS the support, so it
        // carries no separate primitive into the draft.
        typeId: 'stump',
        entity: stump,
        supplied: {},
    };

    // The cone body spans contact disk → socket and must never dip below the
    // root joint: an over-long cone on a downward axis pushes the shaft below
    // the root, into -Z.
    const jointZ = stump.joint.pos.z;
    const lowestShaftZ = Math.min(
        stump.contactCone.pos.z,
        getFinalSocketPosition(stump.contactCone).z,
    );
    if (lowestShaftZ < jointZ - 1e-3) {
        // Preview the invalid stump (red, with the reason as `error`) so the
        // hover tooltip explains the rejection.
        return {
            placed,
            refusal: 'STUMP_BELOW_ROOT',
            supportData: { ...supportData, error: 'STUMP_BELOW_ROOT' },
        };
    }
    return { placed, supportData };
});
