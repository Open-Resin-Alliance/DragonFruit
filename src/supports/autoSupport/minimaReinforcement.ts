import * as THREE from 'three';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { AutoSupportSettings } from './settings';
import {
    MINIMA_RING_COUNT,
    MINIMA_RING_MIN_RISE_MM,
    MINIMA_RING_RADIUS_MM,
    OVERHANG_SELF_SUPPORT_ANGLE_DEG,
} from './constants';

/** One reinforcement contact and the minima it rings. */
export interface MinimaReinforcementPoint {
    /** The minima island being reinforced. */
    islandId: string;
    x: number;
    y: number;
    z: number;
}

/**
 * Radial reinforcement around mesh minima.
 *
 * A minima is the first point of a section: it is the lowest vertex of
 * whatever has just started printing, so its own tip support holds a POINT.
 * The section above it is carried by nothing until the density grid reaches
 * it, and the material that starts printing there has its whole cross-section
 * hanging off that one contact. This pass spreads the contact: a ring of
 * contacts around the minima at {@link MINIMA_RING_RADIUS_MM}, each landing on
 * the feature's own flank.
 *
 * Only islands the minima scanner found and the voxel mask did NOT see
 * (`class === 'minimaOnly'`) are reinforced. A minima coincident with a voxel
 * island (`intersection`) is on a surface the island/overhang passes already
 * cover, and ringing those would double supports on every ordinary overhang.
 *
 * A contact exists only where the ring's ray finds the feature's flank:
 *
 *  - `MINIMA_RING_MIN_RISE_MM` … `radius · tan(selfSupportAngle)` above the
 *    minima — a real upward flank, and no steeper than the classifier's own
 *    self-support angle. A flat around a sub-voxel dip has no flank (its tip
 *    is the whole feature); a needle's flanks are steeper than the angle and
 *    support themselves, and its tip support is what it needs. Both are
 *    dropped, as is a ring direction that leaves the model entirely.
 *  - The ring is drawn in XY (plan), like the density grid's boundary ring: a
 *    ring that cannot climb in Z cannot walk up a limb, and the probe's rise
 *    band is what keeps it on this feature.
 *
 * The points are emitted as `source: 'reinforcement'` candidates and placed as
 * standalone trunks — they broaden the section's base, which is the entire
 * point, so they must not fan onto the tip support they ring.
 */
export function computeMinimaReinforcementPoints(
    islands: DetectedIsland[],
    mesh: THREE.Mesh,
    settings: AutoSupportSettings,
): MinimaReinforcementPoint[] {
    const selfSupportAngleDeg =
        settings.overhangSelfSupportAngleDeg ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG;
    const maxRiseMm = MINIMA_RING_RADIUS_MM * Math.tan((selfSupportAngleDeg * Math.PI) / 180);

    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1);
    raycaster.far = maxRiseMm;

    const points: MinimaReinforcementPoint[] = [];
    for (const island of islands) {
        if (island.source !== 'minima' || island.class !== 'minimaOnly') continue;
        const { x: cx, y: cy, z: cz } = island.contact;
        for (let i = 0; i < MINIMA_RING_COUNT; i++) {
            const angle = (i / MINIMA_RING_COUNT) * Math.PI * 2;
            const x = cx + Math.cos(angle) * MINIMA_RING_RADIUS_MM;
            const y = cy + Math.sin(angle) * MINIMA_RING_RADIUS_MM;
            // Rising from the minima's own plane: every hit is at or above it,
            // and `far` bounds the rise, so the band needs only its floor.
            origin.set(x, y, cz);
            raycaster.set(origin, up);
            const hit = raycaster
                .intersectObject(mesh, false)
                .find((h) => h.point.z - cz >= MINIMA_RING_MIN_RISE_MM);
            if (hit) points.push({ islandId: island.id, x, y, z: hit.point.z });
        }
    }
    return points;
}
