import * as THREE from 'three';
import { round } from '@/utils/math';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import type { CandidatePoint } from './types';
import { CONTACT_WIDTH_PROBE_MM } from './constants';
import { getSettings } from '../Settings/state';
import { AUTO_SUPPORT_CONSTRAINTS } from './settings';
import { activeSizingBand, smallIslandTipDiameterMm } from './parameterSizing';

/**
 * Tip contact cap by local free width.
 *
 * A contact tip is a rendered disc sitting on the model. It must FIT the
 * feature it lands on: a lattice cell that lands on a 0.5 mm tooth was taking
 * the full active-band contact (2–3× the tooth), so the disc spilled across
 * the neighbouring teeth and the printed contact smeared over the row. The
 * island path had no such check either — only sub-0.15 mm² specks got a shrunk
 * tip — and the lattice ignored it outright.
 *
 * The free width is the width of the free span at the contact: the largest
 * sphere that fits there, measured in the plane the tip lands on. For a contact
 * sitting at the middle of a feature that is exactly `2 ×` the distance to the
 * nearest obstructing geometry — the flank beside it — but the span is what the
 * disc has to fit inside, so the probe sums the two sides rather than taking
 * the nearer one. The difference matters at a silhouette edge, where the
 * nearest-geometry reading collapses to zero: a contact on the *rim* of a wide
 * face would floor every time, which is a placement-inset problem (the disc
 * hangs over the edge whatever its width) and not a width problem, and it would
 * churn the corpus's whole boundary ring for nothing.
 *
 * The SDF is the oracle the rest of placement already routes against, so this
 * queries the same field instead of introducing a second geometry source.
 *
 * The query cannot be made AT the contact point: a contact lies ON the surface
 * by construction, where the signed distance is 0 for a wide slab and a narrow
 * tooth alike (measured). The probe steps out along the tangent plane
 * (perpendicular to the contact normal) `CONTACT_WIDTH_PROBE_MM` in each of the
 * four tangent directions and reads how far it walked past the feature's
 * silhouette (`reach - d`); the sum over the two signs of the narrower axis is
 * the span the disc has to fit inside. A feature at least as wide as the reach
 * reads full width — no cap — which is the correct answer for anything wider
 * than the tip.
 */

/** Scratch vectors — the probe runs once per candidate on the placement hot path. */
const _normal = new THREE.Vector3();
const _reference = new THREE.Vector3();
const _tangent1 = new THREE.Vector3();
const _tangent2 = new THREE.Vector3();

/** Local free width (mm) at a contact, from the shared distance field. */
export function localFreeWidthMm(
    sdf: SDFCache,
    x: number,
    y: number,
    z: number,
    normal: { x: number; y: number; z: number },
): number {
    _normal.set(normal.x, normal.y, normal.z);
    if (_normal.lengthSq() < 1e-12) _normal.set(0, 0, -1);
    _normal.normalize();

    // Any reference not parallel to the normal gives a tangent basis. The
    // probe runs in the plane the tip's disc lies in, not in world XY: a
    // contact on a face sloped past the self-support angle still measures
    // across its own surface.
    _reference.set(0, 0, 1);
    if (Math.abs(_normal.z) > 0.9) _reference.set(1, 0, 0);
    _tangent1.crossVectors(_normal, _reference).normalize();
    _tangent2.crossVectors(_normal, _tangent1).normalize();

    const reach = CONTACT_WIDTH_PROBE_MM;
    let minSpanMm = 2 * reach;
    for (let axis = 0; axis < 2; axis++) {
        const tx = axis === 0 ? _tangent1.x : _tangent2.x;
        const ty = axis === 0 ? _tangent1.y : _tangent2.y;
        const tz = axis === 0 ? _tangent1.z : _tangent2.z;
        let spanMm = 0;
        for (let sign = 1; sign >= -1; sign -= 2) {
            const d = sdf.exactSignedDistanceAt(x + tx * reach * sign, y + ty * reach * sign, z + tz * reach * sign);
            // d ≤ 0 → the probe is still on (or inside) the feature: that side
            // reaches at least the full probe. d > 0 → the probe has cleared
            // the silhouette, so the feature's edge sits `reach - d` from the
            // contact on this side. A side can never exceed the probe nor go
            // negative: past the reach the nearest geometry is no longer the
            // silhouette (a probe off a face reads the part below it, farther
            // than the reach), and the honest answer there is the narrowest
            // one, not a negative contribution that would shrink the *other*
            // side's span too.
            spanMm += Number.isFinite(d) && d > 0 ? Math.max(0, reach - d) : reach;
        }
        if (spanMm < minSpanMm) minSpanMm = spanMm;
    }
    return Math.max(0, minSpanMm);
}

/**
 * Clamp a candidate's tip contact by the local free width. Shrinks only:
 * `tipDiameterMm` stays unset when the cap is not binding, so a candidate with
 * room keeps the band sizing it had (shaft floor, angle factor and all) and
 * the change is a no-op wherever the tip already fits. Floored at
 * {@link smallIslandTipDiameterMm} so a capped tip stays a printable contact.
 *
 * A `localFreeWidthMm` of 0 is the probe finding no clearance in EITHER tangent
 * direction — a ridge, a crease or a rim read edge-on — which is inconclusive
 * rather than narrow, and capping on it floors the band tip on evidence the
 * probe does not have. Only a measured, non-zero width caps.
 */
export function applyContactTipCap(candidate: CandidatePoint, sdf: SDFCache): void {
    const ceilingMm = candidate.tipDiameterMm ?? activeSizingBand().tipContactDiameterMm;
    if (ceilingMm <= smallIslandTipDiameterMm()) return;
    const freeWidthMm = localFreeWidthMm(
        sdf,
        candidate.tipPos.x,
        candidate.tipPos.y,
        candidate.tipPos.z,
        candidate.tipNormal,
    );
    if (freeWidthMm <= 0) return;
    const marginScale = getSettings().autoSupport?.tipContactMarginScale
        ?? AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale.defaultValue;
    const targetMm = Math.max(Math.min(ceilingMm, freeWidthMm * marginScale), smallIslandTipDiameterMm());
    if (targetMm >= ceilingMm) return;
    candidate.tipDiameterMm = round(targetMm, 3);
}

/**
 * Cap every candidate against the mesh's distance field.
 *
 * The mesh's geometry must carry a BVH — the SDF is built from it, and a
 * caller without one (unit fixtures, a bare geometry) keeps band sizing rather
 * than failing the run.
 */
export function applyContactTipCaps(candidates: CandidatePoint[], mesh?: THREE.Mesh): void {
    const geometry = mesh?.geometry as (THREE.BufferGeometry & { boundsTree?: unknown }) | undefined;
    if (!mesh || !geometry?.boundsTree || candidates.length === 0) return;
    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();
    for (const candidate of candidates) applyContactTipCap(candidate, sdf);
}
