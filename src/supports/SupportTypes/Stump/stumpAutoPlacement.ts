import type * as THREE from 'three';

import { registerContactOverride, type PlacedSupport } from '../../supportTypeRegistry';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { getOrCreateSDFCache } from '../../PlacementLogic/Pathfinding/SDFCachePool';
import type { SDFCache } from '../../PlacementLogic/Pathfinding/SDFCache';
import { buildStumpData } from './stumpBuilder';
import type { Stump, Vec3 } from '../../types';

/** How close to the model a stump's body may come, in mm. */
const STUMP_COLLISION_SAFETY_MM = 0.05;
/** Length of the cone's tip region skipped when sampling, in mm. */
const STUMP_TIP_SKIP_MM = 0.35;
/** Samples along a body axis, and directions around it. */
const STUMP_BODY_SAMPLES = 5;
const STUMP_BODY_DIRECTIONS = 4;

/**
 * Does a tapered body between two world points reach the model?
 *
 * The body's *surface* is sampled, not its axis: a cone standing under a flat
 * ceiling is tangent there, and comparing an axis sample's distance against the
 * local radius reads that tangency as an intersection (the two are equal at the
 * widening rate a short cone has). Points on the surface, measured against the
 * face they actually sit on, answer the real question. `skipMm` steps past the
 * body's own attachment region — the contact disk is *on* the model.
 *
 * Distances come from the exact signed field rather than the quantized grid march
 * every shaft uses: the stump's margins are finer than the grid's cell-centre
 * substitution error (~0.25 mm at the 0.5 mm cell), which would flag bodies on
 * geometry they clear.
 */
function bodyReachesModel(
    sdf: SDFCache,
    from: Vec3,
    to: Vec3,
    fromRadius: number,
    toRadius: number,
    skipMm: number,
): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length <= 1e-6) {
        return sdf.exactSignedDistanceAt(to.x, to.y, to.z) < Math.max(fromRadius, toRadius) + STUMP_COLLISION_SAFETY_MM;
    }

    // Two axes perpendicular to the body's own, for sampling around it.
    const ax = dx / length;
    const ay = dy / length;
    const az = dz / length;
    const helper = Math.abs(az) > 0.9
        ? { x: 1, y: 0, z: 0 }
        : { x: 0, y: 0, z: 1 };
    const side1 = {
        x: ay * helper.z - az * helper.y,
        y: az * helper.x - ax * helper.z,
        z: ax * helper.y - ay * helper.x,
    };
    const side1Length = Math.hypot(side1.x, side1.y, side1.z) || 1;
    side1.x /= side1Length; side1.y /= side1Length; side1.z /= side1Length;
    const side2 = {
        x: ay * side1.z - az * side1.y,
        y: az * side1.x - ax * side1.z,
        z: ax * side1.y - ay * side1.x,
    };

    const first = Math.min(1, skipMm / length);
    const span = 1 - first;
    const steps = Math.max(1, Math.min(STUMP_BODY_SAMPLES, Math.ceil((span * length) / 0.4) + 1));

    for (let i = 0; i <= steps; i += 1) {
        const t = first + (span * i) / steps;
        const radius = fromRadius + (toRadius - fromRadius) * t;
        const cx = from.x + dx * t;
        const cy = from.y + dy * t;
        const cz = from.z + dz * t;

        // Both ends of each direction: a cone under a ceiling is caught by its
        // upper side, one beside a wall by the side that faces it.
        for (let d = 0; d < STUMP_BODY_DIRECTIONS; d += 1) {
            const angle = (d / STUMP_BODY_DIRECTIONS) * Math.PI;
            const ux = side1.x * Math.cos(angle) + side2.x * Math.sin(angle);
            const uy = side1.y * Math.cos(angle) + side2.y * Math.sin(angle);
            const uz = side1.z * Math.cos(angle) + side2.z * Math.sin(angle);
            for (const sign of [1, -1]) {
                const px = cx + ux * radius * sign;
                const py = cy + uy * radius * sign;
                const pz = cz + uz * radius * sign;
                if (sdf.exactSignedDistanceAt(px, py, pz) < STUMP_COLLISION_SAFETY_MM) return true;
            }
        }
    }

    return false;
}

/** Does the joint ball at the socket reach the model? */
function jointReachesModel(sdf: SDFCache, socket: Vec3, radius: number): boolean {
    const margin = radius + STUMP_COLLISION_SAFETY_MM;
    if (sdf.exactSignedDistanceAt(socket.x, socket.y, socket.z) < margin) return true;

    for (const axis of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]) {
        for (const sign of [1, -1]) {
            const px = socket.x + axis.x * radius * sign;
            const py = socket.y + axis.y * radius * sign;
            const pz = socket.z + axis.z * radius * sign;
            if (sdf.exactSignedDistanceAt(px, py, pz) < STUMP_COLLISION_SAFETY_MM) return true;
        }
    }

    return false;
}

/**
 * Whether a built stump's body runs into the model.
 *
 * A stump is the one support that stands where the model is close to the plate,
 * and its socket end — the joint ball plus the cone's wide end — sits a fixed
 * millimetre above the plate. On an underside that clears the contact, that wide
 * end can still be inside the part, and the rendered stump then reads as a blob
 * with the surface cutting through it. The grid's own collision gate never sees a
 * stump: a type with its own contact override returns before the trunk checks, so
 * the check has to live here.
 *
 * The root column is checked from the plate to the joint rather than assumed
 * clear: a model on the plate can overhang the root's own column, and a root
 * printed inside the part is as wrong as a cone through it.
 */
function stumpModelCollision(stump: Stump, mesh: THREE.Mesh | undefined): 'COLLISION_WITH_MODEL' | null {
    if (!mesh) return null;

    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();

    const contact = stump.contactCone.pos;
    const socket = stump.joint.pos;

    const coneReaches = bodyReachesModel(
        sdf,
        contact,
        socket,
        Math.max(0.001, (stump.contactCone.profile.contactDiameterMm ?? 0.4) / 2),
        Math.max(0.001, (stump.contactCone.profile.bodyDiameterMm ?? 1.4) / 2),
        STUMP_TIP_SKIP_MM,
    );
    if (coneReaches) return 'COLLISION_WITH_MODEL';

    if (jointReachesModel(sdf, socket, Math.max(0.001, (stump.joint.diameter ?? 0) / 2))) {
        return 'COLLISION_WITH_MODEL';
    }

    const foot: Vec3 = { x: socket.x, y: socket.y, z: 0 };
    const rootReaches = bodyReachesModel(
        sdf,
        foot,
        socket,
        Math.max(0.001, (stump.rootBaseDiameter ?? 0) / 2),
        Math.max(0.001, (stump.rootTopDiameter ?? 0) / 2),
        0,
    );
    return rootReaches ? 'COLLISION_WITH_MODEL' : null;
}

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

    const collision = stumpModelCollision(stump, request.mesh as THREE.Mesh | undefined);
    if (collision) {
        return {
            placed,
            refusal: collision,
            supportData: { ...supportData, error: collision },
        };
    }

    return { placed, supportData };
});
