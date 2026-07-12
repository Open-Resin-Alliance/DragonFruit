import * as THREE from 'three';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';

const DEFAULT_MIN_DISK_THICKNESS_MM = 0.1;
const DEFAULT_STANDOFF_ANGLE_THRESHOLD_RAD = Math.PI / 4;
const DEFAULT_LEGACY_MAX_STANDOFF_MM = 1.5;
const DEFAULT_LEGACY_CLAMPED_MAX_STANDOFF_MM = 0.35;
const MAX_STANDOFF_ANGLE_RAD = Math.PI * 0.5 * 0.9; // ~81°
const EPS = 1e-8;

/**
 * Clearance between the tip ball and the model surface.
 *
 * The ball at the cone junction is as wide as the contact face
 * (radius = contactDiameterMm / 2) and its center sits at the top of the
 * disk standoff. Whenever the ball radius exceeds the standoff, the ball
 * dips below the model surface — invisible on a circular disk (it hides
 * inside the disk column) but exposed by a squished (oval) contact face,
 * and it silently prints extra material at the contact. The standoff is
 * therefore floored at (ball radius + this clearance) so the ball always
 * stays clear of the model.
 */
export const TIP_BALL_CLEARANCE_MM = 0.1;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Calculates the thickness of the contact disk ("nib") based on cone angle relative to surface.
 *
 * Logic:
 * - Ideally perpendicular (Cone Axis aligned with Surface Normal) -> Min thickness.
 * - Steeper angle -> Thicker disk to prevent cone body from clipping into wall.
 * - Always at least (contact radius + TIP_BALL_CLEARANCE_MM), so the tip ball
 *   at the cone junction never touches the model.
 *
 * The contact diameter is read from `contactDiameterMm` when the profile is a
 * full SupportTipProfile (most callers), or passed explicitly for ContactDisk
 * entities whose bare ContactDiskProfile does not carry it (twig disks).
 * Without a diameter from either source the ball floor is skipped.
 */
export function calculateDiskThickness(
    surfaceNormal: Vec3,
    coneAxis: Vec3, // The direction the cone is pointing (usually towards the socket)
    profile: ContactDiskProfile,
    contactDiameterMm?: number
): number {
    const diameterForBall = contactDiameterMm
        ?? (profile as { contactDiameterMm?: number } | undefined)?.contactDiameterMm;
    const ballClearanceFloor = typeof diameterForBall === 'number' && Number.isFinite(diameterForBall) && diameterForBall > 0
        ? diameterForBall / 2 + TIP_BALL_CLEARANCE_MM
        : 0;

    // SAFETY CHECK: Fallback for legacy profiles or missing props
    if (!profile) {
        return Math.max(DEFAULT_MIN_DISK_THICKNESS_MM, ballClearanceFloor);
    }

    const threshold = profile.standoffAngleThreshold ?? DEFAULT_STANDOFF_ANGLE_THRESHOLD_RAD;
    const minThickness = Math.max(
        profile.diskThicknessMm ?? DEFAULT_MIN_DISK_THICKNESS_MM,
        ballClearanceFloor,
    );
    
    // SMART LEGACY FIX: 
    // If maxStandoff is exactly 1.5 (old default), clamp it to 0.35.
    // If it's anything else (user customized), use it directly.
    const rawMax = profile.maxStandoffMm ?? DEFAULT_LEGACY_MAX_STANDOFF_MM;
    const maxStandoff = (rawMax === DEFAULT_LEGACY_MAX_STANDOFF_MM)
        ? DEFAULT_LEGACY_CLAMPED_MAX_STANDOFF_MM
        : rawMax;
    const maxThickness = Math.max(minThickness, maxStandoff);

    const nx = surfaceNormal.x;
    const ny = surfaceNormal.y;
    const nz = surfaceNormal.z;
    const ax = coneAxis.x;
    const ay = coneAxis.y;
    const az = coneAxis.z;

    const nLenSq = nx * nx + ny * ny + nz * nz;
    const aLenSq = ax * ax + ay * ay + az * az;

    if (nLenSq < EPS || aLenSq < EPS) {
        return minThickness;
    }

    // Angle between Surface Normal and Cone Axis
    // 0 = Perfectly Perpendicular (Cone pointing straight out)
    // 90 = Parallel to surface (Bad)
    const invMag = 1 / Math.sqrt(nLenSq * aLenSq);
    const dot = (nx * ax + ny * ay + nz * az) * invMag;
    const clampedDot = Math.max(-1, Math.min(1, dot));
    const angle = Math.acos(clampedDot);

    if (angle <= threshold) {
        return minThickness;
    }
    
    // Interpolate
    // We want to cap expansion at some max angle (e.g. 80 degrees?)
    // Let's assume max extension is reached at 70 degrees or so?
    // Or just linear map from Threshold to 90deg?
    
    const maxAngle = MAX_STANDOFF_ANGLE_RAD;
    
    // Clamp angle
    const effectiveAngle = Math.min(angle, maxAngle);
    
    const denom = Math.max(EPS, maxAngle - threshold);
    const t = (effectiveAngle - threshold) / denom;
    const factor = clamp01(t);
    
    // Lerp
    return minThickness + factor * (maxThickness - minThickness);
}

/**
 * Get the center position for the disk.
 * The disk is centered at: pos + (normal * thickness/2)
 */
export function getDiskCenter(
    pos: Vec3,
    normal: Vec3,
    thickness: number
): Vec3 {
    return {
        x: pos.x + normal.x * (thickness / 2),
        y: pos.y + normal.y * (thickness / 2),
        z: pos.z + normal.z * (thickness / 2),
    };
}

/**
 * Get Quaternion to align cylinder Y-axis with Normal.
 */
export function getDiskRotation(normal: Vec3): THREE.Quaternion {
    const alignVector = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const defaultUp = new THREE.Vector3(0, 1, 0); // Cylinder default axis
    return new THREE.Quaternion().setFromUnitVectors(defaultUp, alignVector);
}

/**
 * Resolve the penetration depth ("embed depth") for a contact disk.
 * Resolution order: explicit value → profile.penetrationMm → 0. Never negative.
 */
export function resolveDiskPenetrationMm(
    profile: { penetrationMm?: number } | undefined,
    explicitPenetrationMm?: number,
): number {
    const raw = explicitPenetrationMm ?? profile?.penetrationMm ?? 0;
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

export interface ContactDiskGeometrySpec {
    radius: number;             // Contact radius (mm)
    thickness: number;          // Resolved standoff thickness (excludes penetration)
    penetrationMm: number;      // Resolved, clamped penetration depth
    height: number;             // Full cylinder height = thickness + penetration
    center: Vec3;               // World center of the cylinder (accounts for penetration)
    tipCenter: Vec3;            // Cone-side tip sphere center — never moves with penetration
    rotation: THREE.Quaternion; // Aligns cylinder Y-axis with the surface normal
}

/**
 * Structural profile shape accepted by getContactDiskGeometrySpec, so both
 * ContactDiskProfile and disk-typed SupportTipProfile (or partial profiles
 * from export/slicing paths) can be passed without casts.
 */
export interface ContactDiskProfileLike {
    type?: string;
    diskThicknessMm?: number;
    maxStandoffMm?: number;
    standoffAngleThreshold?: number;
    penetrationMm?: number;
}

/**
 * Single source of truth for the contact-disk solid.
 *
 * The disk cylinder spans from (pos - normal·penetration) — embedded into the
 * model — up to (pos + normal·thickness) where the round tip meets the cone.
 * Penetration extends the disk INTO the model only; the cone-side connection
 * (tipCenter) is unaffected, so sockets and joints never move with this setting.
 *
 * Every consumer that produces disk geometry (detailed renderer, instanced
 * renderer, file export, slicer feed) must derive its dimensions from this
 * spec so viewport and printed output stay in lockstep.
 */
export function getContactDiskGeometrySpec(params: {
    pos: Vec3;
    surfaceNormal: Vec3;
    coneAxis: Vec3;
    profile: ContactDiskProfileLike;
    contactDiameterMm: number;
    penetrationMm?: number;     // Explicit override; defaults to profile.penetrationMm
    overrideThickness?: number; // Explicit thickness (e.g. from collision logic)
}): ContactDiskGeometrySpec {
    const { pos, surfaceNormal, coneAxis, profile, contactDiameterMm, penetrationMm, overrideThickness } = params;
    const thickness = overrideThickness !== undefined
        ? overrideThickness
        // calculateDiskThickness reads the standoff fields with ?? fallbacks,
        // so a partial profile is safe at runtime. The diameter feeds the
        // tip-ball clearance floor.
        : calculateDiskThickness(surfaceNormal, coneAxis, profile as ContactDiskProfile, contactDiameterMm);
    const pen = resolveDiskPenetrationMm(profile, penetrationMm);
    // Cylinder spans pos - n·pen → pos + n·thickness.
    const centerOffset = (thickness - pen) / 2;
    return {
        radius: contactDiameterMm / 2,
        thickness,
        penetrationMm: pen,
        height: thickness + pen,
        center: {
            x: pos.x + surfaceNormal.x * centerOffset,
            y: pos.y + surfaceNormal.y * centerOffset,
            z: pos.z + surfaceNormal.z * centerOffset,
        },
        tipCenter: {
            x: pos.x + surfaceNormal.x * thickness,
            y: pos.y + surfaceNormal.y * thickness,
            z: pos.z + surfaceNormal.z * thickness,
        },
        rotation: getDiskRotation(surfaceNormal),
    };
}

// --- Oval contact face ("squish") ---

export const CONTACT_FACE_MIN_RATIO = 0.25;
export const CONTACT_FACE_MAX_RATIO = 1;

export interface ContactFaceShape {
    ratio: number;    // Squished-axis width as a fraction of the contact diameter (1 = circle)
    angleRad: number; // Rotation of the squished axis about the disc normal
}

/**
 * Resolve the per-disc oval contact-face shape from an entity that may carry
 * the optional fields. Absent/invalid values fall back to a perfect circle,
 * so legacy discs are unaffected.
 */
export function resolveContactFaceShape(
    source: { contactFaceRatio?: number; contactFaceAngleRad?: number } | undefined,
): ContactFaceShape {
    const rawRatio = source?.contactFaceRatio;
    const rawAngle = source?.contactFaceAngleRad;
    const ratio = Number.isFinite(rawRatio)
        ? Math.min(CONTACT_FACE_MAX_RATIO, Math.max(CONTACT_FACE_MIN_RATIO, rawRatio as number))
        : 1;
    const angleRad = Number.isFinite(rawAngle) ? (rawAngle as number) : 0;
    return { ratio, angleRad };
}

/**
 * Radial tessellation policy for the contact-disk solid.
 *
 * A squished (oval) disc renders its tangent flank + ball wrap crossing the
 * tip ball and cone body at shallow angles, where facet-scale artifacts are
 * plainly visible — so ovals always get the fine wall: 24 segments, or 12 in
 * low-detail contexts (base ≤ 8). An untouched circular disc is a plain
 * cylinder with no such crossings, so it keeps the caller's cheaper base
 * tessellation unchanged.
 */
export function resolveContactDiskRadialSegments(baseSegments: number, ratio: number): number {
    const base = Math.max(3, Math.floor(baseSegments));
    if (ratio >= 1 - 1e-6) return base;
    return base <= 8 ? 12 : 24;
}

/**
 * Build the contact-disk solid as a two-stage loft (local space, Y-up,
 * centered like CylinderGeometry at ±height/2 so it is a drop-in replacement
 * for the disk cylinder everywhere):
 *
 *   tip center (+h/2)     — circle (radius)
 *      ▲  standoff zone   — blends oval → circle
 *   model surface plane   — FULL OVAL (the user-drawn shape crosses the skin here)
 *      ▼  penetration zone — constant oval prism
 *   embedded end (−h/2)   — same full oval
 *
 * The squished axis is local X (ratio · radius); local Z keeps the full
 * radius. Oval orientation is NOT baked in — consumers rotate about local Y
 * (the disc normal) by the per-disc angle, keeping one geometry per ratio so
 * instancing can share it. ratio = 1 reproduces a plain cylinder exactly.
 *
 * Tip-ball tangency: the tip ball (radius = contact radius, centered at the
 * top cap) is wider than a squished wall, so a naive blend either cuts a
 * chord through it (ball bulges out in a crease) or wraps it with a kink. The
 * wall is instead built per azimuth as the true tangent construction: a
 * straight flank from the full oval at the model surface to the point where
 * it just touches the ball, then the ball's own arc up to the equator — C¹
 * smooth at the touch point. Unsquished azimuths tangent exactly at the
 * equator (the vertical cylinder wall), so ratio = 1 reproduces a plain
 * cylinder bit-for-bit. The contact face at and below the surface always
 * keeps the exact drawn oval.
 */
export function createContactDiskLoftGeometry(params: {
    radius: number;
    ratio: number;
    thickness: number;
    penetrationMm: number;
    radialSegments?: number;
}): THREE.BufferGeometry {
    const { radius, thickness } = params;
    const radialSegments = Math.max(3, Math.floor(params.radialSegments ?? 24));
    const ratio = Math.min(CONTACT_FACE_MAX_RATIO, Math.max(CONTACT_FACE_MIN_RATIO, params.ratio));
    const pen = Math.max(0, params.penetrationMm);
    const height = Math.max(1e-4, thickness + pen);
    const surfaceY = -height / 2 + pen;

    const tipY = height / 2;
    const wallT = tipY - surfaceY; // Standoff span the wall climbs (= thickness)

    // Ring Y positions (bottom → top). The surface ring is only needed when a
    // penetration zone exists below it. Squished lofts get interior rings so
    // the wall can follow the tangent flank + ball arc (see ringPoint); a
    // plain cylinder (ratio 1) never curves and keeps the minimal wall.
    const rings: number[] = [];
    rings.push(-height / 2);
    if (pen > 1e-6) {
        rings.push(surfaceY); // model surface plane
    }
    if (ratio < 1 - 1e-6) {
        const INTERIOR_RINGS = 10;
        for (let i = 1; i <= INTERIOR_RINGS; i += 1) {
            rings.push(surfaceY + wallT * (i / (INTERIOR_RINGS + 1)));
        }
    }
    rings.push(tipY);

    const positions: number[] = [];
    const indices: number[] = [];

    // The wall wraps an INFLATED ball: 1/cos(π/n) is the circumscribed-polygon
    // factor, so the faceted wall's flat faces clear the true sphere — and
    // therefore also clear every faceted tip-sphere mesh (whose vertices lie
    // ON the true sphere), even the coarse 10-segment instanced ball. Without
    // it the two facet sets interleave and z-fight, which reads as a choppy
    // band along the junction on deselected (instanced) supports. The small
    // constant additionally keeps slicer unions away from exactly-coincident
    // surfaces.
    const hugR = radius / Math.cos(Math.PI / radialSegments) + 0.002;
    const hugRSq = hugR * hugR;

    // Wall profile per azimuth (tangent construction, see the doc comment):
    // every ring vertex for a segment lies in an azimuthal plane, at radial
    // distance rho(y). Azimuths are spaced uniformly in POLAR angle — not
    // ellipse parameter — so each facet spans at most 2π/n of the ball's
    // cross-section and the circumscribed-polygon inflation holds on the
    // squished sides too (ellipse-parameter spacing leaves polar gaps up to
    // 1/ratio wider near the squished axis, and the ball punched through
    // those long chord facets).
    const semiX = radius * ratio;
    const ringPoint = (y: number, segment: number): [number, number, number] => {
        const psi = (segment / radialSegments) * Math.PI * 2;
        const cosPsi = Math.cos(psi);
        const sinPsi = Math.sin(psi);
        // Full-oval surface radius along this direction (ellipse polar form).
        const p = (semiX * radius) / Math.sqrt(
            radius * radius * cosPsi * cosPsi + semiX * semiX * sinPsi * sinPsi,
        );
        const ex = p * cosPsi;
        const ez = p * sinPsi;

        if (y <= surfaceY + 1e-9 || ratio >= 1 - 1e-6) {
            // Penetration zone keeps the exact drawn oval; a circle face is
            // the plain cylinder wall (tangent to the ball at the equator),
            // preserved bit-for-bit.
            return [ex, y, ez];
        }
        const d = tipY - y; // depth below the tip-ball center
        const dSq = p * p + wallT * wallT;
        let rho: number;
        if (dSq <= hugRSq + 1e-12) {
            // Degenerate: standoff shorter than the (inflated) ball radius —
            // pre-floor legacy inputs. Vertical wall that lets the ball emerge.
            const ball = d < hugR ? Math.sqrt(hugRSq - d * d) : 0;
            rho = Math.max(p, ball);
        } else {
            // Tangent point Q of the flank from surface point (p, wallT) to
            // the inflated ball circle about the tip center.
            const tangentLen = Math.sqrt(dSq - hugRSq);
            const qRho = hugR * (hugR * p + tangentLen * wallT) / dSq;
            const qD = hugR * (hugR * wallT - tangentLen * p) / dSq;
            if (d <= qD + 1e-12) {
                rho = Math.sqrt(Math.max(0, hugRSq - d * d)); // ball arc
            } else {
                const s = (wallT - d) / Math.max(1e-9, wallT - qD);
                rho = p + s * (qRho - p); // straight flank surface → Q
            }
        }
        return [(ex / p) * rho, y, (ez / p) * rho];
    };

    // Side wall: one vertex ring per profile ring (shared between wall quads).
    const wallRingStart: number[] = [];
    for (const ringY of rings) {
        wallRingStart.push(positions.length / 3);
        for (let s = 0; s <= radialSegments; s += 1) {
            positions.push(...ringPoint(ringY, s));
        }
    }
    for (let r = 0; r < rings.length - 1; r += 1) {
        const a0 = wallRingStart[r];
        const b0 = wallRingStart[r + 1];
        for (let s = 0; s < radialSegments; s += 1) {
            const a = a0 + s;
            const b = b0 + s;
            // Outward-facing winding (CCW seen from outside)
            indices.push(a, b, a + 1);
            indices.push(a + 1, b, b + 1);
        }
    }

    // Caps (separate vertices so computeVertexNormals keeps hard edges).
    const buildCap = (y: number, facingUp: boolean) => {
        const centerIndex = positions.length / 3;
        positions.push(0, y, 0);
        const rimStart = positions.length / 3;
        for (let s = 0; s <= radialSegments; s += 1) {
            positions.push(...ringPoint(y, s));
        }
        for (let s = 0; s < radialSegments; s += 1) {
            if (facingUp) {
                indices.push(centerIndex, rimStart + s + 1, rimStart + s);
            } else {
                indices.push(centerIndex, rimStart + s, rimStart + s + 1);
            }
        }
    };
    buildCap(-height / 2, false); // bottom (embedded end)
    buildCap(tipY, true);         // top (cone side, hidden inside the tip sphere)

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}
