/**
 * Pose stability, for the orientation advisor.
 *
 * The advisor ranks candidate poses by the support contact they will demand.
 * It had no term for the question a pose actually fails on: can the part stand
 * on the plate at all? A cube auto-oriented onto a corner wins the contact-area
 * ranking and then needs a stabilization anchor at every edge — the exact pose
 * `computeStabilizationAnchors` exists to patch.
 *
 * This is the same model as `compute_stability_report`
 * (`src-tauri/src/overhang.rs`), which logs it for the *placed* pose: the
 * driving moment about a bearing-hull edge is `M_e = Σ A·(n_xy·u)·z`, the
 * gravity restoring moment is `ρg·V·d_e`, and the plate-adhesion restoring
 * moment is `σ·A_contact·d̄_e`. Both collapse to one constant each
 * (`margin = V·d_e/M_e` against a length `L* = p/(ρg)`, and
 * `adhesion_ratio = A_contact·d̄_e/M_e` against the dimensionless `p/σ`), so
 * this module reports the geometry and the constants stay in one place. The
 * advisor only needs the constant-free part: whether the pose has a bearing
 * polygon at all and whether the mass is over it.
 *
 * The two implementations are deliberately separate — the report is Rust, on
 * the posed mesh the scan already holds, and the advisor is a synchronous pure
 * function over triangle soup that must stay testable without IPC — and they
 * are pinned to the same closed-form fixtures on both sides (a flat 20 mm cube
 * reads `bearing 400 mm² over 4 edges, depth 10` in both).
 *
 * Rotation convention matches `measureBoundingBox` and `rotatedNz`: Rx(a) then
 * Ry(b), i.e. `y1 = y·ca − z·sa; z1 = y·sa + z·ca; x2 = x·cb + z1·sb;
 * z2 = −x·sb + z1·cb`.
 */

import * as THREE from 'three';

import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';

/** Plate-contact band (mm) the bearing hull is measured over — the same band
 *  `computeStabilizationAnchors` and `compute_stability_report` use. */
const BEARING_BAND_MM = 2.0;
/** Band points are quantized to this XY cell before hulling, so a finely
 *  tessellated base costs one hull point per cell instead of per vertex. */
const BAND_CELL_MM = 0.5;
/** ...and so is the XY shadow, for the same reason. */
const SHADOW_CELL_MM = 0.5;
/** Below this enclosed volume there is no mass to restore anything. */
const MIN_VOLUME_MM3 = 1e-9;

export interface PoseStability {
    /** World Z of the lowest point under this pose (mm). */
    plateZMm: number;
    volumeMm3: number;
    /** XY area of the bearing hull (mm²); 0 = no bearing polygon. */
    bearingAreaMm2: number;
    /** Hull edge count; 0 = a point or edge contact. */
    bearingEdges: number;
    /** How far the volume centroid sits inside the worst edge (mm). Negative
     *  means the mass is already outside the base — the pose cannot stand. */
    centroidDepthMm: number;
    /** The same for the bearing patch's own centroid (mm). Always positive. */
    contactDepthMm: number;
    /** Driving moment about the worst edge (mm³); 0 when nothing leans. */
    dragMomentMm3: number;
    /** `V·d_e/M_e` (mm) — the gravity verdict's geometry. `Infinity` when the
     *  pose carries no lateral drag. */
    marginMm: number;
    /** `A_contact·d̄_e/M_e` (dimensionless) — the adhesion verdict's geometry. */
    adhesionRatio: number;
    /** Part height above the bearing plane (mm). */
    heightMm: number;
    /** How thick the part is on average: `volume / footprint` (mm). The spacing
     *  between anchoring contacts up a face is a beam span, and the sag between
     *  two of them goes as the span to the fourth power, so this is the length
     *  that spacing has to stay under. */
    thicknessMm: number;
    /** How many times taller the part is than thick: `height / thicknessMm`. A
     *  wall over `SLENDER_RATIO` sways under the peel's lateral load while it
     *  prints, which is a different failure from toppling and needs contact up
     *  its height rather than a band at the bottom. */
    slenderness: number;
    /** Height (mm, above the part's own base) of the TOP of the highest face
     *  that drags — not its centroid. The moment grows with height, so the
     *  load is at the top edge of that face and a brace only resists once it
     *  reaches there; `dragMomentMm3` alone cannot say how tall that is. */
    dragTopMm: number;
    /** Azimuth of the worst edge's outward normal (deg, 0 = +X, 90 = +Y): the
     *  direction the drag pushes the part, i.e. the side the tipping edge is
     *  on. Braces belong on the opposite side — that is where the lever arm
     *  from the tipping edge is longest, and the face that pushes is the worst
     *  place to put them. */
    pushDirDeg: number;
    /** Down-facing area that lies in the contact band, split the way the
     *  advisor's cost splits its terms. This is the plate contact, so it is NOT
     *  an overhang: it needs no support. Charging it made the search prefer
     *  poses that balance on a corner — a corner-down cube's faces all sit
     *  above the self-support angle and scored 0, while the flat pose was
     *  charged its own base twice over, which is why a cube came back oriented
     *  onto a corner. */
    restingContact: RestingContact;
}

/** Down-facing area in the contact band, by the advisor's cost buckets. */
export interface RestingContact {
    overhangAreaMm2: number;
    cupAreaMm2: number;
    scarAreaMm2: number;
    blockedAreaMm2: number;
}

/** The advisor's per-triangle inputs, needed to split the resting contact the
 *  same way its cost does. Optional: without it the resting sums are zero and
 *  the caller keeps the raw areas. */
export interface SupportTerms {
    normals: Float64Array;
    areas: Float64Array;
    details: Float64Array;
    blocked: Set<number> | null;
    /** cos(self-support angle) — the advisor's `threshold`. */
    threshold: number;
    /** cos of the near-flat cutoff — the advisor's `CUP_FLAT_COS`. */
    cupCos: number;
}

const EMPTY_RESTING: RestingContact = {
    overhangAreaMm2: 0,
    cupAreaMm2: 0,
    scarAreaMm2: 0,
    blockedAreaMm2: 0,
};

/** Conservative `p/σ` for the adhesion verdict: treat a pose as needing
 *  anti-topple contact whenever it would lift below this, i.e. whenever it is
 *  even close to marginal. The report's ratio is computed from the model's own
 *  bearing patch, which is smaller than the printed contact whenever a raft is
 *  used, so the true ratio is larger and this errs toward bracing. Calibration
 *  will replace it. */
export const CONSERVATIVE_P_SIGMA = 0.05;

/** How many times taller than thick a part may be before it counts as slender.
 *  A wall past this sways under the peel's lateral load while it prints, which
 *  is a different failure from toppling: anchoring it needs contacts up its
 *  height, because a contact only stops the sway at its own height. Below the
 *  ratio, anchoring wants the low band instead, since a squat part's problem is
 *  rigid-body motion and low contacts are short, stiff and cheap. */
export const SLENDER_RATIO = 4;

/** Is this part tall enough that sway matters? */
export function isSlenderPart(s: {
    heightMm: number;
    volumeMm3: number;
    bearingAreaMm2: number;
}): boolean {
    if (!(s.bearingAreaMm2 > 0) || !(s.volumeMm3 > 0)) return false;
    return s.heightMm / (s.volumeMm3 / s.bearingAreaMm2) >= SLENDER_RATIO;
}

/** A flat at least this big (mm², 3D) is worth anchoring a part with, whether
 *  or not the pose needs rescuing today. It is a SIZE and not a share of the
 *  drag, because anchoring value is about room: a 400mm² face on a 22mm cube is
 *  99% of that part's drag and still not a surface worth spreading contacts
 *  over, while a 2752mm² face is. */
export const STEEP_FLAT_ANCHOR_MIN_AREA_MM2 = 1000;

/**
 * Should this steep flat be covered, given the pose's verdict?
 *
 * The verdict alone is all-or-nothing: a part the raft holds comfortably gets
 * no contact anywhere, even on the one big face that would anchor it best. But
 * size, not share, is what makes a flat an anchoring surface. It is planar, so
 * a contact on it has a well-defined normal and cannot graze; large, so
 * contacts spread across it instead of crowding an edge; and facing the
 * direction the part would move, so holding it holds the part.
 *
 * A share of the drag does not say that. A 20mm cube's face carries 99% of that
 * part's drag and is 400mm² of nowhere to put anything, and covering it sprouted
 * tall supports two thirds of the way up a part that was nearly finished.
 */
export function steepFlatNeedsCoverage(
    surfaceAreaMm2: number | undefined,
    verdictNeedsCoverage: boolean,
): boolean {
    if (verdictNeedsCoverage) return true;
    return (surfaceAreaMm2 ?? 0) >= STEEP_FLAT_ANCHOR_MIN_AREA_MM2;
}

/**
 * Does this pose need anti-topple contact at all?
 *
 * The adhesion verdict alone, in one place, because two passes need the same
 * answer: the stabilization anchors and the steep-flat coverage.
 *
 * NOT the static "is the centroid over the base" test, which is the FDM frame's
 * rule and over-fires badly here. A bottom-up printer hangs the part from the
 * plate, so the failure is peel, and gravity's share of the peel is tiny: on a
 * 97 cm³ part leaning with its centroid 8.4 mm outside a 310 mm² patch, gravity
 * contributes 4e-5 MPa against a peel of tens of kPa. What actually resists is
 * plate adhesion, and the ratio already covers every case the static test was
 * standing in for: a point or edge contact has almost no area, so its ratio
 * collapses toward zero and it still fires.
 */
export function needsToppleCoverage(s: PoseStability): boolean {
    return s.adhesionRatio < CONSERVATIVE_P_SIGMA;
}

/**
 * The mesh's vertices in world space, which is the frame every stability
 * measurement has to happen in: a model whose transform carries its
 * orientation is upright in its own frame, so measuring the raw attribute
 * array reports a part with no drag and a flat top.
 */
export function posedPositions(mesh: { geometry: { getAttribute(name: string): unknown }; matrixWorld: { elements: ArrayLike<number> } }): Float32Array {
    const attribute = mesh.geometry.getAttribute('position') as { array: ArrayLike<number> } | undefined;
    const local = attribute?.array ?? new Float32Array(0);
    const e = mesh.matrixWorld.elements;
    const out = new Float32Array(local.length);
    for (let i = 0; i + 2 < local.length; i += 3) {
        const x = local[i];
        const y = local[i + 1];
        const z = local[i + 2];
        out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
        out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return out;
}

/** A pose with no bearing polygon, or with its mass outside the base, cannot
 *  stand on the plate whatever the drag: no constant has to be calibrated to
 *  say so. This is the only part of the report the advisor gates on.
 *
 *  The mass test needs mass: an open shell (a bare surface with no enclosed
 *  volume) has no volume centroid to be outside anything, and its depth is a
 *  meaningless number rather than a verdict. */
export function isStaticallyUnstable(s: PoseStability): boolean {
    if (s.bearingEdges === 0) return true;
    return s.volumeMm3 > MIN_VOLUME_MM3 && s.centroidDepthMm <= 0;
}

export function measurePoseStability(
    positions: ArrayLike<number>,
    index: ArrayLike<number> | null | undefined,
    rotXRad: number,
    rotYRad: number,
    terms?: SupportTerms,
    hasRaft = false,
): PoseStability {
    const sa = Math.sin(rotXRad);
    const ca = Math.cos(rotXRad);
    const sb = Math.sin(rotYRad);
    const cb = Math.cos(rotYRad);
    const hasIndex = !!index && index.length > 0;
    const triCount = hasIndex
        ? Math.floor((index as ArrayLike<number>).length / 3)
        : Math.floor(positions.length / 9);

    // Rotated vertex scratch, reused across the three passes.
    const vx = [0, 0, 0];
    const vy = [0, 0, 0];
    const vz = [0, 0, 0];
    const load = (t: number): number => {
        let degenerate = 0;
        for (let k = 0; k < 3; k++) {
            const corner = t * 3 + k;
            const i = (hasIndex ? (index as ArrayLike<number>)[corner] : corner) * 3;
            const x = positions[i];
            const y = positions[i + 1];
            const z = positions[i + 2];
            const y1 = y * ca - z * sa;
            const z1 = y * sa + z * ca;
            vx[k] = x * cb + z1 * sb;
            vy[k] = y1;
            vz[k] = -x * sb + z1 * cb;
        }
        // Zero-area triangles are a mesh defect and must not define the plate
        // plane. Tested in the raw frame: the transform preserves collinearity.
        const i0 = (hasIndex ? (index as ArrayLike<number>)[t * 3] : t * 3) * 3;
        const i1 = (hasIndex ? (index as ArrayLike<number>)[t * 3 + 1] : t * 3 + 1) * 3;
        const i2 = (hasIndex ? (index as ArrayLike<number>)[t * 3 + 2] : t * 3 + 2) * 3;
        const ux = positions[i1] - positions[i0];
        const uy = positions[i1 + 1] - positions[i0 + 1];
        const uz = positions[i1 + 2] - positions[i0 + 2];
        const wx = positions[i2] - positions[i0];
        const wy = positions[i2 + 1] - positions[i0 + 1];
        const wz = positions[i2 + 2] - positions[i0 + 2];
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;
        if (nx * nx + ny * ny + nz * nz <= 0) degenerate = 1;
        return degenerate;
    };

    // Pass 1 — plate plane, enclosed volume, volume centroid.
    let zMin = Infinity;
    let zMax = -Infinity;
    let vol6 = 0;
    let cx = 0;
    let cy = 0;
    for (let t = 0; t < triCount; t++) {
        if (load(t)) continue;
        for (let k = 0; k < 3; k++) {
            if (vz[k] < zMin) zMin = vz[k];
            if (vz[k] > zMax) zMax = vz[k];
        }
        const det =
            vx[0] * (vy[1] * vz[2] - vz[1] * vy[2]) -
            vy[0] * (vx[1] * vz[2] - vz[1] * vx[2]) +
            vz[0] * (vx[1] * vy[2] - vy[1] * vx[2]);
        vol6 += det;
        cx += (det * (vx[0] + vx[1] + vx[2])) / 4;
        cy += (det * (vy[0] + vy[1] + vy[2])) / 4;
    }
    if (!Number.isFinite(zMin)) {
        return {
            plateZMm: 0,
            volumeMm3: 0,
            bearingAreaMm2: 0,
            bearingEdges: 0,
            centroidDepthMm: 0,
            contactDepthMm: 0,
            dragMomentMm3: 0,
            marginMm: 0,
            adhesionRatio: 0,
            pushDirDeg: 0,
            heightMm: 0,
            thicknessMm: 0,
            slenderness: 0,
            dragTopMm: 0,
            restingContact: EMPTY_RESTING,
        };
    }
    const volumeMm3 = Math.abs(vol6 / 6);
    const comX = vol6 !== 0 ? cx / vol6 : 0;
    const comY = vol6 !== 0 ? cy / vol6 : 0;

    // Pass 2 — bearing locus, quantized.
    //
    // Without a raft: the hull of the low band. That band makes the patch a
    // spherical cap on a domed base, and the cap's centre WANDERS with the
    // tilt, so the depth is measured from a patch that slides under the part.
    //
    // With a raft: the printed contact is the raft's footprint, not that cap.
    // The raft is built around supports that do not exist yet, so this uses the
    // model's XY shadow as a lower bound on it: smooth under rotation, and it
    // under-estimates the adhesion, which errs toward covering.
    const band = new Map<number, THREE.Vector2>();
    const cell = hasRaft ? SHADOW_CELL_MM : BAND_CELL_MM;
    for (let t = 0; t < triCount; t++) {
        if (load(t)) continue;
        for (let k = 0; k < 3; k++) {
            if (!hasRaft && vz[k] - zMin > BEARING_BAND_MM) continue;
            const qx = Math.round(vx[k] / cell);
            const qy = Math.round(vy[k] / cell);
            const key = qx * 1e7 + qy;
            if (!band.has(key)) band.set(key, new THREE.Vector2(vx[k], vy[k]));
        }
    }
    const hull = convexHull2d(Array.from(band.values()));
    let bearingAreaMm2 = 0;
    let contactX = 0;
    let contactY = 0;
    if (hull.length >= 3) {
        let area2 = 0;
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < hull.length; i++) {
            const p = hull[i];
            const q = hull[(i + 1) % hull.length];
            const cross = p.x * q.y - q.x * p.y;
            area2 += cross;
            sx += (p.x + q.x) * cross;
            sy += (p.y + q.y) * cross;
        }
        bearingAreaMm2 = Math.abs(area2) / 2;
        if (Math.abs(area2) > 1e-9) {
            contactX = sx / (3 * area2);
            contactY = sy / (3 * area2);
        }
    }

    // Pass 3 — driving moment about each hull edge, projected exactly.
    // `hull` is CCW, so an edge's OUTWARD normal is (ey, −ex)/len; depth is
    // measured inward from it, positive inside. A face whose horizontal normal
    // points outward pushes the part outward, and that is the moment that tips
    // it over that edge — the same pairing `compute_stability_report` uses,
    // pinned by the leaning-tower fixture (its underside faces −X, so the worst
    // edge is the −X one and the arm is the centroid's depth from it).
    const edgeNx: number[] = [];
    const edgeNy: number[] = [];
    const edgeX: number[] = [];
    const edgeY: number[] = [];
    const edgeSum: number[] = [];
    for (let i = 0; i < hull.length && hull.length >= 3; i++) {
        const p = hull[i];
        const q = hull[(i + 1) % hull.length];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const len = Math.hypot(ex, ey);
        if (len <= 1e-9) continue;
        edgeNx.push(ey / len);
        edgeNy.push(-ex / len);
        edgeX.push(p.x);
        edgeY.push(p.y);
        edgeSum.push(0);
    }
    let worstMargin = Infinity;
    let worstDepth = 0;
    let worstContactDepth = 0;
    let worstSum = 0;
    let worstDirDeg = 0;
    let haveWorst = false;
    let dragTopMm = 0;
    const resting: RestingContact = { ...EMPTY_RESTING };
    for (let t = 0; t < triCount; t++) {
        if (load(t)) continue;
        const ax = vx[1] - vx[0];
        const ay = vy[1] - vy[0];
        const az = vz[1] - vz[0];
        const bx = vx[2] - vx[0];
        const by = vy[2] - vy[0];
        const bz = vz[2] - vz[0];
        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;
        const twiceArea = Math.hypot(nx, ny, nz);
        if (twiceArea <= 0) continue;
        // Up-facing and vertical faces do not peel away from the plate, and a
        // flat ceiling's drag is vertical: neither rotates the part.
        if (nz >= 0) continue;
        const height = (vz[0] + vz[1] + vz[2]) / 3 - zMin;
        const area = twiceArea / 2;
        // The plate contact: down-facing area inside the band. It needs no
        // support, so the caller's cost must not charge it.
        if (terms && height <= BEARING_BAND_MM) {
            const nzUnit = nz / twiceArea;
            if (nzUnit < -terms.threshold) {
                resting.overhangAreaMm2 += area;
                resting.scarAreaMm2 += area * terms.details[t];
                if (terms.blocked !== null && terms.blocked.has(t)) {
                    resting.blockedAreaMm2 += area;
                }
            }
            if (nzUnit < -terms.cupCos) resting.cupAreaMm2 += area;
        }
        const sinTheta = Math.hypot(nx, ny) / twiceArea;
        if (sinTheta <= 1e-6) continue;
        // The arm is height above the part's own base, so the moment is the
        // same whether or not the pose leaves the part sitting on the plate.
        if (height <= 0) continue;
        const faceTop = Math.max(vz[0], vz[1], vz[2]) - zMin;
        if (faceTop > dragTopMm) dragTopMm = faceTop;
        const nhx = nx / twiceArea;
        const nhy = ny / twiceArea;
        for (let e = 0; e < edgeSum.length; e++) {
            const proj = nhx * edgeNx[e] + nhy * edgeNy[e];
            if (proj > 0) edgeSum[e] += area * proj * height;
        }
    }
    for (let e = 0; e < edgeSum.length; e++) {
        // Inward depth: positive while the point is inside the base, i.e.
        // `(edgePoint − point)·outwardNormal` — the sign convention
        // `compute_stability_report` reports.
        const depth = (edgeX[e] - comX) * edgeNx[e] + (edgeY[e] - comY) * edgeNy[e];
        const contactDepth = (edgeX[e] - contactX) * edgeNx[e] + (edgeY[e] - contactY) * edgeNy[e];
        const sum = edgeSum[e];
        const margin =
            volumeMm3 <= MIN_VOLUME_MM3 ? 0 : sum > 1e-9 ? (volumeMm3 * depth) / sum : Infinity;
        if (!haveWorst || margin < worstMargin) {
            haveWorst = true;
            worstMargin = margin;
            worstDepth = depth;
            worstContactDepth = contactDepth;
            worstSum = sum;
            worstDirDeg = (Math.atan2(edgeNy[e], edgeNx[e]) * 180) / Math.PI;
        }
    }
    if (edgeSum.length === 0) {
        worstMargin = 0;
        worstDepth = 0;
        worstContactDepth = 0;
        worstSum = 0;
    }
    return {
        plateZMm: zMin,
        volumeMm3,
        bearingAreaMm2,
        bearingEdges: edgeSum.length,
        centroidDepthMm: worstDepth,
        contactDepthMm: worstContactDepth,
        dragMomentMm3: worstSum,
        marginMm: worstMargin,
        adhesionRatio:
            worstSum > 1e-9 ? (bearingAreaMm2 * worstContactDepth) / worstSum : Infinity,
        pushDirDeg: (worstDirDeg + 360) % 360,
        heightMm: Number.isFinite(zMax) ? zMax - zMin : 0,
        thicknessMm: bearingAreaMm2 > 0 ? volumeMm3 / bearingAreaMm2 : 0,
        slenderness:
            bearingAreaMm2 > 0 && volumeMm3 > 0
                ? (Number.isFinite(zMax) ? zMax - zMin : 0) / (volumeMm3 / bearingAreaMm2)
                : 0,
        dragTopMm,
        restingContact: resting,
    };
}
