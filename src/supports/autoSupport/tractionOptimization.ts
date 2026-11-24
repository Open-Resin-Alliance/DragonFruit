import * as THREE from 'three';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import { bridgeRadiusForAngleDeg } from './constants';
import { computeRegionSpacing } from './gridPlacement';

/** Coarse occupancy cell size (mm) for cross-sectional layer IoU clustering. */
const LAYER_IOU_CELL_MM = 2.0;
/** Adjacent layers with IoU >= this and relative area change <= threshold belong to one cluster. */
const LAYER_COHERENCE_IOU_MIN = 0.85;
const LAYER_COHERENCE_AREA_DELTA_MAX = 0.20;
/** Minimum XY spacing (mm) between a traction-added contact and any existing contact (UV-bleed guard). */
const MIN_TRACTION_CONTACT_SPACING_MM = 1.2;
/** Cap on greedy Voronoi deficit insertions per overhang region. */
const MAX_TRACTION_ADDS_PER_REGION = 12;
/** Voxel cell size (mm) matching `voxelFootprint`. */
const FOOTPRINT_VOXEL_MM = 0.25;
/** Characteristic flexible-FEP progressive peel screening length λ_FEP (mm) in (∇² - κ²)p = -1. */
export const STEFAN_FEP_SCREENING_LENGTH_MM = 4.5;
/** Target grid spacing (mm) for the 2D Screened Stefan Poisson solver on representative layers. */
const STEFAN_TARGET_CELL_MM = 0.75;
/** Cap per-axis grid resolution so even large 150 mm parts solve in < 5 ms. */
const STEFAN_MAX_GRID_DIM = 140;
/** Red-Black SOR relaxation factor and sweep count for (∇² - κ²)p = -1. */
const STEFAN_SOR_OMEGA = 1.60;
const STEFAN_SOR_ITERATIONS = 28;

/**
 * 2D Screened Stefan viscous-suction pressure field solved on a representative
 * layer's solid cross-section mask:
 *   (∇² - κ²) p̃(x, y) = -1   in Ω,   p̃ = 0   on ∂Ω,   κ = 1 / λ_FEP.
 *
 * Units of `pressure`: mm² (independent of resin viscosity/lift speed; normalizes
 * cleanly against the analytical mean pressure of a reference single-support disc).
 */
export interface StefanPressureField {
    minX: number;
    minY: number;
    cellMm: number;
    nx: number;
    ny: number;
    /** Row-major (`j * nx + i`) dimensionless Stefan pressure p̃ (mm²); 0 outside Ω. */
    pressure: Float32Array;
    /** Maximum p̃ across the cross-section (mm²). */
    peakPressureMm2: number;
    /** Mean p̃ over solid cells (mm²). */
    meanPressureMm2: number;
    /** Integrated Stefan force ∫_Ω p̃ dA (mm⁴). */
    integratedForceMm4: number;
    /** Solid mask area reconstructed on the solver grid (mm²). */
    maskAreaMm2: number;
}

export interface RepresentativeLayer {
    /** World Z height (mm) of the peak-load layer in this coherent cluster. */
    zMm: number;
    /** Exact cross-sectional area (mm²) at this slice via Green's theorem. */
    areaMm2: number;
    /** Ratio of this cluster's peak area to the preceding cluster's peak area (>1 = sudden expansion). */
    areaJumpRatio: number;
    /** Number of raw sampled slices collapsed into this cluster. */
    clusterSpanCount: number;
    /** Solved 2D Screened Stefan suction field on this representative layer's cross-section. */
    stefanField?: StefanPressureField;
}

export interface RepresentativeLayerProfile {
    layers: RepresentativeLayer[];
    /** Peak cross-sectional area across the entire model (mm²). */
    peakAreaMm2: number;
    /** Total raw Z planes sampled before clustering. */
    sampledPlaneCount: number;
}

export interface TractionOptimizationStats {
    representativeLayers: number;
    peakCrossSectionMm2: number;
    added: number;
    pruned: number;
}

export interface TractionOptimizationResult {
    candidates: CandidatePoint[];
    stats: TractionOptimizationStats;
    profile: RepresentativeLayerProfile;
}

/** Modified Bessel function I_0(x) via power series (machine precision for x <= 10). */
function besselI0(x: number): number {
    const halfXSq = 0.25 * x * x;
    let sum = 1.0;
    let term = 1.0;
    for (let k = 1; k <= 12; k++) {
        term *= halfXSq / (k * k);
        sum += term;
        if (term < 1e-12 * sum) break;
    }
    return sum;
}

/** Modified Bessel function I_1(x) via power series (machine precision for x <= 10). */
function besselI1(x: number): number {
    const halfXSq = 0.25 * x * x;
    let sum = 0.5 * x;
    let term = 0.5 * x;
    for (let k = 1; k <= 12; k++) {
        term *= halfXSq / (k * (k + 1));
        sum += term;
        if (term < 1e-12 * sum) break;
    }
    return sum;
}

/**
 * Exact analytical mean Screened Stefan pressure p̄(R) (mm²) over a circular
 * cross-section of area `areaMm2` under `(∇² - κ²)p̃ = -1, p̃|_∂Ω = 0`:
 *   p̄(R) = (1 / κ²) * (1 - 2 I_1(κR) / (κR I_0(κR))).
 *
 * Approaches exact rigid Stefan `R² / 8` as `κR -> 0` and saturates at `λ_FEP²`
 * as `κR -> ∞`. Used to normalize solved 2D fields into unitless support demand.
 */
export function referenceStefanMeanPressureMm2(
    areaMm2: number,
    screeningLengthMm: number = STEFAN_FEP_SCREENING_LENGTH_MM,
): number {
    const safeArea = Math.max(0.5, areaMm2);
    const R = Math.sqrt(safeArea / Math.PI);
    const kappa = 1 / Math.max(0.5, screeningLengthMm);
    const kR = kappa * R;
    if (kR < 1e-3) return (R * R) / 8;
    const ratio = (2 * besselI1(kR)) / (kR * besselI0(kR));
    return Math.max(1e-4, (1 - ratio) / (kappa * kappa));
}

/**
 * Scanline-fill closed 2D slice segments `[px, py, qx, qy, ...]` onto a padded
 * solid mask and solve `(∇² - κ²)p̃ = -1` via Red-Black SOR.
 */
export function solveStefanFieldFromSegments(
    segments: readonly number[],
    screeningLengthMm: number = STEFAN_FEP_SCREENING_LENGTH_MM,
): StefanPressureField | undefined {
    const segCount = Math.floor(segments.length / 4);
    if (segCount < 3) return undefined;

    let rawMinX = Infinity, rawMaxX = -Infinity;
    let rawMinY = Infinity, rawMaxY = -Infinity;
    for (let s = 0; s < segCount; s++) {
        const px = segments[s * 4];
        const py = segments[s * 4 + 1];
        const qx = segments[s * 4 + 2];
        const qy = segments[s * 4 + 3];
        if (px < rawMinX) rawMinX = px;
        if (px > rawMaxX) rawMaxX = px;
        if (qx < rawMinX) rawMinX = qx;
        if (qx > rawMaxX) rawMaxX = qx;
        if (py < rawMinY) rawMinY = py;
        if (py > rawMaxY) rawMaxY = py;
        if (qy < rawMinY) rawMinY = qy;
        if (qy > rawMaxY) rawMaxY = qy;
    }

    const spanX = rawMaxX - rawMinX;
    const spanY = rawMaxY - rawMinY;
    if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || (spanX < 0.05 && spanY < 0.05)) {
        return undefined;
    }

    const cellMm = Math.max(STEFAN_TARGET_CELL_MM, Math.max(spanX, spanY) / (STEFAN_MAX_GRID_DIM - 4));
    // Pad by 2 cells on all sides so boundary Dirichlet condition p = 0 holds automatically.
    const minX = rawMinX - 2 * cellMm;
    const minY = rawMinY - 2 * cellMm;
    const nx = Math.min(STEFAN_MAX_GRID_DIM, Math.max(5, Math.ceil(spanX / cellMm) + 4));
    const ny = Math.min(STEFAN_MAX_GRID_DIM, Math.max(5, Math.ceil(spanY / cellMm) + 4));
    const total = nx * ny;
    const solid = new Uint8Array(total);
    const crossings: number[] = [];

    // Exact half-open scanline polygon fill per row.
    for (let j = 1; j < ny - 1; j++) {
        const y = minY + (j + 0.5) * cellMm;
        crossings.length = 0;
        for (let s = 0; s < segCount; s++) {
            const y0 = segments[s * 4 + 1];
            const y1 = segments[s * 4 + 3];
            if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
                const x0 = segments[s * 4];
                const x1 = segments[s * 4 + 2];
                const t = (y - y0) / (y1 - y0);
                crossings.push(x0 + t * (x1 - x0));
            }
        }
        if (crossings.length < 2) continue;
        crossings.sort((a, b) => a - b);
        const rowOffset = j * nx;
        for (let c = 0; c + 1 < crossings.length; c += 2) {
            const xStart = crossings[c];
            const xEnd = crossings[c + 1];
            const i0 = Math.max(1, Math.floor((xStart - minX) / cellMm));
            const i1 = Math.min(nx - 2, Math.floor((xEnd - minX) / cellMm));
            for (let i = i0; i <= i1; i++) {
                solid[rowOffset + i] = 1;
            }
        }
    }

    // Collect interior solid indices once so Red-Black SOR touches only solid cells.
    const redIdx: number[] = [];
    const blackIdx: number[] = [];
    for (let j = 1; j < ny - 1; j++) {
        const rowOffset = j * nx;
        for (let i = 1; i < nx - 1; i++) {
            const idx = rowOffset + i;
            if (!solid[idx]) continue;
            if (((i + j) & 1) === 0) redIdx.push(idx);
            else blackIdx.push(idx);
        }
    }
    const solidCount = redIdx.length + blackIdx.length;
    if (solidCount === 0) return undefined;

    const pressure = new Float32Array(total);
    const h2 = cellMm * cellMm;
    const kappa = 1 / Math.max(0.5, screeningLengthMm);
    const invDiag = 1 / (4 + kappa * kappa * h2);
    const omega = STEFAN_SOR_OMEGA;
    const oneMinusOmega = 1 - omega;

    for (let iter = 0; iter < STEFAN_SOR_ITERATIONS; iter++) {
        for (let r = 0; r < redIdx.length; r++) {
            const idx = redIdx[r];
            const gs = (pressure[idx - 1] + pressure[idx + 1] + pressure[idx - nx] + pressure[idx + nx] + h2) * invDiag;
            pressure[idx] = oneMinusOmega * pressure[idx] + omega * gs;
        }
        for (let b = 0; b < blackIdx.length; b++) {
            const idx = blackIdx[b];
            const gs = (pressure[idx - 1] + pressure[idx + 1] + pressure[idx - nx] + pressure[idx + nx] + h2) * invDiag;
            pressure[idx] = oneMinusOmega * pressure[idx] + omega * gs;
        }
    }

    let sumP = 0;
    let peakP = 0;
    for (let r = 0; r < redIdx.length; r++) {
        const p = pressure[redIdx[r]];
        sumP += p;
        if (p > peakP) peakP = p;
    }
    for (let b = 0; b < blackIdx.length; b++) {
        const p = pressure[blackIdx[b]];
        sumP += p;
        if (p > peakP) peakP = p;
    }

    const maskAreaMm2 = solidCount * h2;
    return {
        minX,
        minY,
        cellMm,
        nx,
        ny,
        pressure,
        peakPressureMm2: peakP,
        meanPressureMm2: sumP / solidCount,
        integratedForceMm4: sumP * h2,
        maskAreaMm2,
    };
}

/** Sample solved Screened Stefan pressure p̃ (mm²) at world `(x, y)` (3×3 max fallback on rim). */
export function sampleStefanPressure(field: StefanPressureField, x: number, y: number): number {
    const fi = (x - field.minX) / field.cellMm - 0.5;
    const fj = (y - field.minY) / field.cellMm - 0.5;
    const i = Math.round(fi);
    const j = Math.round(fj);
    if (i < 0 || i >= field.nx || j < 0 || j >= field.ny) return 0;
    const direct = field.pressure[j * field.nx + i];
    if (direct > 0) return direct;
    // Surface overhang contacts can sit half a cell outside the rasterized interior;
    // sample the immediate 3×3 neighborhood so rim overhangs feel the adjacent solid.
    let best = 0;
    for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= field.ny) continue;
        const row = jj * field.nx;
        for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= field.nx) continue;
            const p = field.pressure[row + ii];
            if (p > best) best = p;
        }
    }
    return best;
}

function packCell(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
}

function setIoU(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const k of small) {
        if (large.has(k)) inter++;
    }
    const union = a.size + b.size - inter;
    return union > 0 ? inter / union : 1;
}

/**
 * Fast single-pass representative-layer slicer (Cao et al. 2025, Algorithm 1).
 *
 * Samples `24–72` horizontal planes through the world-frame mesh, computes exact
 * closed cross-section area per slice via Green's theorem on triangle-plane
 * intersections, and clusters consecutive coherent slices by coarse 2D IoU and
 * relative area delta. Emits the peak-load representative layer per cluster.
 */
export function extractRepresentativeLayers(
    mesh: THREE.Mesh | undefined | null,
    planeCountOverride?: number,
): RepresentativeLayerProfile {
    if (!mesh || !mesh.geometry) {
        return { layers: [], peakAreaMm2: 0, sampledPlaneCount: 0 };
    }
    const posAttr = mesh.geometry.getAttribute('position');
    if (!posAttr || posAttr.count < 3) {
        return { layers: [], peakAreaMm2: 0, sampledPlaneCount: 0 };
    }

    mesh.updateMatrixWorld(true);
    const m = mesh.matrixWorld.elements;
    const m0 = m[0], m1 = m[1], m2 = m[2];
    const m4 = m[4], m5 = m[5], m6 = m[6];
    const m8 = m[8], m9 = m[9], m10 = m[10];
    const m12 = m[12], m13 = m[13], m14 = m[14];

    const vCount = posAttr.count;
    const wx = new Float32Array(vCount);
    const wy = new Float32Array(vCount);
    const wz = new Float32Array(vCount);

    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < vCount; i++) {
        const lx = posAttr.getX(i);
        const ly = posAttr.getY(i);
        const lz = posAttr.getZ(i);
        wx[i] = m0 * lx + m4 * ly + m8 * lz + m12;
        wy[i] = m1 * lx + m5 * ly + m9 * lz + m13;
        const z = m2 * lx + m6 * ly + m10 * lz + m14;
        wz[i] = z;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }

    const spanZ = maxZ - minZ;
    if (!Number.isFinite(spanZ) || spanZ < 0.5) {
        return { layers: [], peakAreaMm2: 0, sampledPlaneCount: 0 };
    }

    const planeCount = planeCountOverride !== undefined
        ? Math.max(4, Math.min(128, Math.round(planeCountOverride)))
        : Math.max(24, Math.min(72, Math.round(spanZ / 1.0)));

    const zStart = minZ + Math.min(0.25, spanZ * 0.05);
    const zEnd = maxZ - Math.min(0.25, spanZ * 0.05);
    const zStep = planeCount > 1 ? (zEnd - zStart) / (planeCount - 1) : 1;
    const invStep = zStep > 1e-6 ? 1 / zStep : 0;

    const planeZ = new Float64Array(planeCount);
    const signedArea2 = new Float64Array(planeCount);
    const occSets: Array<Set<number>> = new Array(planeCount);
    const sliceSegments: number[][] = new Array(planeCount);
    for (let k = 0; k < planeCount; k++) {
        planeZ[k] = zStart + k * zStep;
        occSets[k] = new Set<number>();
        sliceSegments[k] = [];
    }

    const index = mesh.geometry.getIndex();
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(vCount / 3);

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

        const z0 = wz[i0], z1 = wz[i1], z2 = wz[i2];
        const triMinZ = z0 < z1 ? (z0 < z2 ? z0 : z2) : (z1 < z2 ? z1 : z2);
        const triMaxZ = z0 > z1 ? (z0 > z2 ? z0 : z2) : (z1 > z2 ? z1 : z2);
        if (triMaxZ <= zStart || triMinZ >= zEnd) continue;

        const kStart = Math.max(0, Math.floor((triMinZ - zStart) * invStep) + 1);
        const kEnd = Math.min(planeCount - 1, Math.floor((triMaxZ - zStart) * invStep));
        if (kStart > kEnd) continue;

        const x0 = wx[i0], y0 = wy[i0];
        const x1 = wx[i1], y1 = wy[i1];
        const x2 = wx[i2], y2 = wy[i2];

        // World-space triangle normal XY (outward direction for Green's theorem orientation).
        const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        if (nx * nx + ny * ny < 1e-12) continue;

        for (let k = kStart; k <= kEnd; k++) {
            const z = planeZ[k];
            // Half-open straddle test (min < z <= max) guarantees each vertex is
            // cleanly on one side, producing 0 or 2 intersection points per triangle.
            const a0 = z0 >= z;
            const a1 = z1 >= z;
            const a2 = z2 >= z;
            if (a0 === a1 && a1 === a2) continue;

            let px = 0, py = 0, qx = 0, qy = 0;
            let count = 0;
            if (a0 !== a1) {
                const u = (z - z0) / (z1 - z0);
                px = x0 + (x1 - x0) * u;
                py = y0 + (y1 - y0) * u;
                count++;
            }
            if (a1 !== a2) {
                const u = (z - z1) / (z2 - z1);
                const ix = x1 + (x2 - x1) * u;
                const iy = y1 + (y2 - y1) * u;
                if (count === 0) { px = ix; py = iy; } else { qx = ix; qy = iy; }
                count++;
            }
            if (a2 !== a0 && count < 2) {
                const u = (z - z2) / (z0 - z2);
                qx = x2 + (x0 - x2) * u;
                qy = y2 + (y0 - y2) * u;
                count++;
            }
            if (count !== 2) continue;

            // Orient segment p -> q so right-hand normal (qy-py, -(qx-px)) aligns with (nx, ny).
            const crossAlign = (qy - py) * nx - (qx - px) * ny;
            if (crossAlign < 0) {
                const tx = px, ty = py;
                px = qx; py = qy;
                qx = tx; qy = ty;
            }

            signedArea2[k] += px * qy - qx * py;
            sliceSegments[k].push(px, py, qx, qy);
            const occ = occSets[k];
            const segLen = Math.hypot(qx - px, qy - py);
            const steps = Math.max(1, Math.ceil(segLen / LAYER_IOU_CELL_MM));
            for (let s = 0; s <= steps; s++) {
                const f = s / steps;
                occ.add(packCell(
                    Math.round((px + (qx - px) * f) / LAYER_IOU_CELL_MM),
                    Math.round((py + (qy - py) * f) / LAYER_IOU_CELL_MM),
                ));
            }
        }
    }

    const areas = new Float64Array(planeCount);
    let peakAreaMm2 = 0;
    for (let k = 0; k < planeCount; k++) {
        const a = Math.abs(signedArea2[k]) * 0.5;
        areas[k] = a;
        if (a > peakAreaMm2) peakAreaMm2 = a;
    }

    // Cluster consecutive coherent slices and emit the peak-area representative layer per cluster.
    const layers: RepresentativeLayer[] = [];
    let clusterBestIdx = 0;
    let clusterCount = 1;
    let prevClusterArea = 0;

    const flushCluster = () => {
        const area = areas[clusterBestIdx];
        if (area > 0.05) {
            const areaJumpRatio = prevClusterArea > 0.5 ? area / prevClusterArea : 1.0;
            const stefanField = solveStefanFieldFromSegments(sliceSegments[clusterBestIdx]);
            layers.push({
                zMm: planeZ[clusterBestIdx],
                areaMm2: area,
                areaJumpRatio,
                clusterSpanCount: clusterCount,
                stefanField,
            });
            prevClusterArea = area;
        }
    };

    for (let k = 1; k < planeCount; k++) {
        const maxA = Math.max(areas[k], areas[k - 1], 1.0);
        const relDelta = Math.abs(areas[k] - areas[k - 1]) / maxA;
        const iou = setIoU(occSets[k], occSets[k - 1]);
        const coherent = iou >= LAYER_COHERENCE_IOU_MIN && relDelta <= LAYER_COHERENCE_AREA_DELTA_MAX;
        if (coherent) {
            clusterCount++;
            if (areas[k] > areas[clusterBestIdx]) clusterBestIdx = k;
        } else {
            flushCluster();
            clusterBestIdx = k;
            clusterCount = 1;
        }
    }
    flushCluster();

    return { layers, peakAreaMm2, sampledPlaneCount: planeCount };
}

/**
 * Spatially varying dimensionless peel traction density `τ(x, y, z)` derived
 * from the solved 2D Screened Stefan suction fields `(∇² - κ²)p̃ = -1` on the
 * representative layers in the `[zMm - 0.5, zMm + 6.0]` peel window above `(x, y)`.
 *
 * Combines the adhesive peel floor (`0.55`) with the normalized harmonic-mean
 * hydraulic flow resistance `0.45 * sqrt(p̃(x,y) / p̄_ref(A_0))` plus a sudden
 * cross-section jump surcharge:
 * - Thin features (snout, blade, arrow shaft): `~0.65–0.85×` (low suction).
 * - Reference `A_0` (default `10 mm²`) circular pad: `1.00×`.
 * - Broad solid interiors: peaks smoothly up to `1.55×` (FEP peel saturation).
 */
export function stefanTractionFactorAt(
    profile: RepresentativeLayerProfile,
    x: number,
    y: number,
    zMm: number,
    refAreaMm2: number = 10.0,
): number {
    if (profile.layers.length === 0) return 1.0;

    let maxPressure = -1;
    let maxJump = 1.0;
    let foundLayer = false;

    for (const layer of profile.layers) {
        if (layer.zMm >= zMm - 0.5 && layer.zMm <= zMm + 6.0) {
            foundLayer = true;
            if (layer.areaJumpRatio > maxJump) maxJump = layer.areaJumpRatio;
            if (layer.stefanField) {
                const p = sampleStefanPressure(layer.stefanField, x, y);
                if (p > maxPressure) maxPressure = p;
            }
        }
    }
    if (!foundLayer) return 1.0;
    if (maxPressure < 0) return tractionMultiplierAtZ(profile, zMm, refAreaMm2);

    const refMeanP = referenceStefanMeanPressureMm2(refAreaMm2);
    const stefanTerm = Math.pow(Math.max(0, maxPressure) / refMeanP, 0.22);
    let tau = 0.50 + 0.50 * stefanTerm;
    if (maxJump > 1.35) {
        tau += Math.min(0.15, (maxJump - 1.35) * 0.20);
    }
    return Math.max(0.65, Math.min(1.55, tau));
}

/**
 * Layer-level peel traction multiplier at height `zMm` derived from the
 * representative layers in the `[zMm - 0.5, zMm + 6.0]` peel window.
 *
 * Uses the solved Screened Stefan mean pressure when present (normalized against
 * `referenceStefanMeanPressureMm2(refAreaMm2)`), falling back to area/jump
 * scaling when called with synthetic layers lacking a Stefan field.
 */
export function tractionMultiplierAtZ(
    profile: RepresentativeLayerProfile,
    zMm: number,
    refAreaMm2: number = 10.0,
): number {
    if (profile.layers.length === 0) return 1.0;

    let maxMeanP = -1;
    let maxArea = 0;
    let maxJump = 1.0;
    let found = false;

    for (const layer of profile.layers) {
        if (layer.zMm >= zMm - 0.5 && layer.zMm <= zMm + 6.0) {
            found = true;
            if (layer.areaMm2 > maxArea) maxArea = layer.areaMm2;
            if (layer.areaJumpRatio > maxJump) maxJump = layer.areaJumpRatio;
            if (layer.stefanField && layer.stefanField.meanPressureMm2 > maxMeanP) {
                maxMeanP = layer.stefanField.meanPressureMm2;
            }
        }
    }
    if (!found) return 1.0;

    let mul: number;
    if (maxMeanP >= 0) {
        const refMeanP = referenceStefanMeanPressureMm2(refAreaMm2);
        mul = 0.50 + 0.50 * Math.pow(maxMeanP / refMeanP, 0.22);
    } else {
        mul = 1.0;
        if (maxArea > 40) {
            mul += Math.min(0.25, Math.log2(maxArea / 40) * 0.08);
        } else if (maxArea < 12) {
            mul = 0.85;
        }
    }
    if (maxJump > 1.35) {
        mul += Math.min(0.25, (maxJump - 1.35) * 0.30);
    }
    return Math.max(0.65, Math.min(1.55, mul));
}

/**
 * Downward multi-layer load protection (Cao et al. 2025): when a broad upper
 * representative layer `L_k` exerts more total Stefan-weighted peel demand than
 * `85%` of the cumulative capacity of the contacts supporting its XY footprint
 * from below (`z_c <= z_k + 0.5`), mark those lower contacts as load-protected
 * so Passes B/C never prune anchors carrying a heavy upper cross-section.
 */
function computeDownwardLoadProtected(
    profile: RepresentativeLayerProfile,
    candidates: readonly CandidatePoint[],
    areaPerSupportMm2: number,
): Set<CandidatePoint> {
    const protectedSet = new Set<CandidatePoint>();
    if (profile.layers.length === 0 || candidates.length === 0) return protectedSet;

    const refMeanP = referenceStefanMeanPressureMm2(areaPerSupportMm2);
    for (const layer of profile.layers) {
        const field = layer.stefanField;
        if (!field || layer.areaMm2 < areaPerSupportMm2 * 1.5) continue;

        // Layer's total Stefan-weighted peel demand (mm²-equivalent).
        const layerTau = Math.max(
            0.65,
            Math.min(1.55, 0.50 + 0.50 * Math.pow(field.meanPressureMm2 / refMeanP, 0.22)),
        );
        const totalDemandMm2 = layer.areaMm2 * layerTau;
        const maxX = field.minX + field.nx * field.cellMm + 4.0;
        const maxY = field.minY + field.ny * field.cellMm + 4.0;
        const minX = field.minX - 4.0;
        const minY = field.minY - 4.0;

        const carrying: CandidatePoint[] = [];
        for (const c of candidates) {
            const p = c.tipPos;
            if (p.z > layer.zMm + 0.5) continue;
            if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
            carrying.push(c);
        }
        if (carrying.length === 0) continue;

        const cumulativeCapacityMm2 = carrying.length * areaPerSupportMm2;
        if (totalDemandMm2 > cumulativeCapacityMm2 * 0.85) {
            for (const c of carrying) protectedSet.add(c);
        }
    }
    return protectedSet;
}

interface VoronoiSeed {
    candidate: CandidatePoint;
    prunable: boolean;
}

interface VoronoiCellStats {
    /** Raw geometric footprint area of this Voronoi cell (mm²). */
    areaMm2: number;
    /** Spatially integrated Screened Stefan traction demand ∫ τ(x,y) dA (mm²-equiv). */
    tractionDemandMm2: number;
    maxDistSq: number;
    furthestX: number;
    furthestY: number;
    furthestZ: number;
    voxelCount: number;
}

/**
 * Phase 1c: Voronoi Traction-Force Contact Optimizer (Cao et al. 2025).
 *
 * Partitions each overhang region's `0.25 mm` footprint into discrete 2D Voronoi
 * cells seeded by its active contacts, weighted by the representative-layer
 * peel traction multiplier just above the region:
 * - **Add** a reinforcement contact at the furthest point of any Voronoi cell
 *   exceeding tip area capacity or angle-dependent bridge reach.
 * - **Conservatively prune** only interior `grid-` lattice contacts whose removal
 *   leaves every neighboring Voronoi cell within `80%` of capacity and `90%` of
 *   bridge reach. Never prunes perimeter corners (`fill-`), `nearBase` contacts,
 *   or primary discrete islands (`voxel`/`minima`/`intersection`).
 */
export function optimizeContactsByTraction(
    candidates: CandidatePoint[],
    overhangRegions: readonly DetectedIsland[],
    settings: AutoSupportSettings,
    mesh?: THREE.Mesh | null,
    modelId: string = '',
): TractionOptimizationResult {
    const profile = extractRepresentativeLayers(mesh);
    if (candidates.length === 0) {
        return {
            candidates,
            stats: {
                representativeLayers: profile.layers.length,
                peakCrossSectionMm2: profile.peakAreaMm2,
                added: 0,
                pruned: 0,
            },
            profile,
        };
    }

    const prunedSet = new Set<CandidatePoint>();
    const addedCandidates: CandidatePoint[] = [];
    const effectiveAreaByCandidate = new Map<CandidatePoint, number>();
    const largeRegionOwnerByCandidate = new Map<CandidatePoint, string>();
    const downwardLoadProtected = computeDownwardLoadProtected(
        profile,
        candidates,
        settings.areaPerSupportMm2,
    );

    for (const region of overhangRegions) {
        if (region.interior || region.steepFlat) continue;
        const fp = region.contactVoxels;
        if (!fp || fp.count < 4) continue;

        // Compute region XY bbox once for fast candidate association.
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < fp.count; i++) {
            const vx = footprintX(fp, i);
            const vy = footprintY(fp, i);
            if (vx < minX) minX = vx;
            if (vx > maxX) maxX = vx;
            if (vy < minY) minY = vy;
            if (vy > maxY) maxY = vy;
        }
        const regionMinZ = region.baseZ - 1.5;
        const regionMaxZ = (region.maxZ ?? region.baseZ) + 1.5;

        const seeds: VoronoiSeed[] = [];
        for (const c of candidates) {
            if (prunedSet.has(c)) continue;
            const p = c.tipPos;
            if (p.z < regionMinZ || p.z > regionMaxZ) continue;
            if (p.x < minX - 1.0 || p.x > maxX + 1.0 || p.y < minY - 1.0 || p.y > maxY + 1.0) continue;
            // Only interior lattice points (`grid-*`, not near-base, not perimeter `fill-*`,
            // not primary discrete islands) are eligible for conservative surplus pruning.
            const prunable = Boolean(
                c.gridPoint
                && !c.nearBase
                && !downwardLoadProtected.has(c)
                && c.source === 'overhang'
                && c.id.startsWith('grid-'),
            );
            seeds.push({ candidate: c, prunable });
        }
        if (seeds.length === 0) continue;

        const stride = fp.count > 1600 ? 2 : 1;
        const sampleCount = Math.ceil(fp.count / stride);
        const sx = new Float32Array(sampleCount);
        const sy = new Float32Array(sampleCount);
        const sz = new Float32Array(sampleCount);
        const sTraction = new Float32Array(sampleCount);
        let si = 0;
        for (let i = 0; i < fp.count; i += stride) {
            const vx = footprintX(fp, i);
            const vy = footprintY(fp, i);
            const vz = footprintZ(fp, i) ?? region.baseZ;
            sx[si] = vx;
            sy[si] = vy;
            sz[si] = vz;
            sTraction[si] = stefanTractionFactorAt(profile, vx, vy, vz, settings.areaPerSupportMm2);
            si++;
        }
        const cellAreaMm2 = (FOOTPRINT_VOXEL_MM * FOOTPRINT_VOXEL_MM) * (fp.count / si);

        const angleBridgeRadiusMm = bridgeRadiusForAngleDeg(region.overhangAngleDeg);
        const spacing = computeRegionSpacing(region, settings);
        // Nominal single-tip Voronoi traction budget (`spacing^2` mm²-equivalent);
        // local peel pressure variation is integrated per voxel via `sTraction[i]`.
        const tipCapacityMm2 = Math.max(2.5, spacing * spacing);
        const addRadiusSq = (angleBridgeRadiusMm * 1.05) ** 2;
        const minAddSpacingSq = MIN_TRACTION_CONTACT_SPACING_MM * MIN_TRACTION_CONTACT_SPACING_MM;

        const nearestIdx = new Int32Array(si);
        const secondIdx = new Int32Array(si);

        const computeVoronoi = (): VoronoiCellStats[] => {
            const stats: VoronoiCellStats[] = seeds.map((s) => ({
                areaMm2: 0,
                tractionDemandMm2: 0,
                maxDistSq: 0,
                furthestX: s.candidate.tipPos.x,
                furthestY: s.candidate.tipPos.y,
                furthestZ: s.candidate.tipPos.z,
                voxelCount: 0,
            }));
            for (let i = 0; i < si; i++) {
                const vx = sx[i], vy = sy[i];
                let bestI = 0, bestD2 = Infinity;
                let secI = -1, secD2 = Infinity;
                for (let j = 0; j < seeds.length; j++) {
                    const p = seeds[j].candidate.tipPos;
                    const dx = vx - p.x;
                    const dy = vy - p.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < bestD2) {
                        secD2 = bestD2;
                        secI = bestI;
                        bestD2 = d2;
                        bestI = j;
                    } else if (d2 < secD2) {
                        secD2 = d2;
                        secI = j;
                    }
                }
                nearestIdx[i] = bestI;
                secondIdx[i] = secI;
                const cell = stats[bestI];
                cell.areaMm2 += cellAreaMm2;
                cell.tractionDemandMm2 += cellAreaMm2 * sTraction[i];
                cell.voxelCount++;
                if (bestD2 > cell.maxDistSq) {
                    cell.maxDistSq = bestD2;
                    cell.furthestX = vx;
                    cell.furthestY = vy;
                    cell.furthestZ = sz[i];
                }
            }
            return stats;
        };

        // Pass A: Deficit addition — insert a contact at the furthest point of
        // the most overloaded Voronoi cell until traction & reach constraints pass.
        let addsHere = 0;
        let cellStats = computeVoronoi();
        while (addsHere < MAX_TRACTION_ADDS_PER_REGION) {
            let worstIdx = -1;
            let worstExcess = 0;
            for (let j = 0; j < seeds.length; j++) {
                const cell = cellStats[j];
                if (cell.areaMm2 < 1.5) continue;
                const areaRatio = cell.tractionDemandMm2 / (tipCapacityMm2 * 1.15);
                const reachRatio = cell.maxDistSq / addRadiusSq;
                const excess = Math.max(areaRatio, reachRatio);
                if (excess > 1.0 && excess > worstExcess) {
                    worstExcess = excess;
                    worstIdx = j;
                }
            }
            if (worstIdx < 0) break;

            const target = cellStats[worstIdx];
            // Respect UV-bleed spacing floor against all active seeds.
            let tooClose = false;
            for (const s of seeds) {
                const dx = target.furthestX - s.candidate.tipPos.x;
                const dy = target.furthestY - s.candidate.tipPos.y;
                if (dx * dx + dy * dy < minAddSpacingSq) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) break;

            const n = region.surfaceNormal ?? { x: 0, y: 0, z: -1 };
            const added: CandidatePoint = {
                id: `traction-${region.id}-${addsHere}`,
                tipPos: { x: target.furthestX, y: target.furthestY, z: target.furthestZ },
                tipNormal: { x: n.x, y: n.y, z: n.z },
                modelId: modelId || seeds[0].candidate.modelId,
                source: 'overhang',
                islandAreaMm2: settings.areaPerSupportMm2,
                zHeight: target.furthestZ,
                priority: 0.45,
                gridPoint: true,
            };
            seeds.push({ candidate: added, prunable: false });
            addedCandidates.push(added);
            addsHere++;
            cellStats = computeVoronoi();
        }

        // Pass B: Conservative surplus pruning — only remove interior `grid-`
        // points when neighbors absorb 100% of their Voronoi voxels with safety
        // headroom (<= 80% area capacity and <= 90% bridge reach).
        if (seeds.length > 2) {
            const pruneAreaCap = tipCapacityMm2 * 0.80;
            const pruneReachSqCap = (angleBridgeRadiusMm * 0.90) ** 2;

            let removedAny = true;
            while (removedAny && seeds.length > 2) {
                removedAny = false;
                // Check smallest-load prunable interior seeds first.
                const order = seeds
                    .map((s, idx) => ({ idx, load: cellStats[idx].tractionDemandMm2, prunable: s.prunable }))
                    .filter((entry) => entry.prunable)
                    .sort((a, b) => a.load - b.load);

                for (const { idx } of order) {
                    // Simulate handing idx's voxels to their 2nd-nearest seed.
                    const addedDemand = new Map<number, number>();
                    let safe = true;
                    for (let i = 0; i < si; i++) {
                        if (nearestIdx[i] !== idx) continue;
                        const alt = secondIdx[i];
                        if (alt < 0) { safe = false; break; }
                        const altPos = seeds[alt].candidate.tipPos;
                        const dx = sx[i] - altPos.x;
                        const dy = sy[i] - altPos.y;
                        if (dx * dx + dy * dy > pruneReachSqCap) {
                            safe = false;
                            break;
                        }
                        const nextDemand = (addedDemand.get(alt) ?? cellStats[alt].tractionDemandMm2) + cellAreaMm2 * sTraction[i];
                        if (nextDemand > pruneAreaCap) {
                            safe = false;
                            break;
                        }
                        addedDemand.set(alt, nextDemand);
                    }
                    if (!safe) continue;

                    prunedSet.add(seeds[idx].candidate);
                    seeds.splice(idx, 1);
                    cellStats = computeVoronoi();
                    removedAny = true;
                    break;
                }
            }
        }

        // Record each surviving seed's exact Voronoi cell area so Pass C knows
        // the true per-contact peel load (rather than the nominal 10 mm² grid stamp).
        // For large regions (>= 25 mm²), Pass B already solved exact 0.25 mm voxel
        // Voronoi coverage, so Pass C will not re-prune same-region pairs.
        const isLargeRegion = (region.areaMm2 ?? 0) >= 25.0;
        for (let j = 0; j < seeds.length; j++) {
            const c = seeds[j].candidate;
            const prev = effectiveAreaByCandidate.get(c) ?? 0;
            effectiveAreaByCandidate.set(c, Math.max(prev, cellStats[j].areaMm2));
            if (isLargeRegion) largeRegionOwnerByCandidate.set(c, region.id);
        }
    }

    // Pass C: Global Cross-Region Traction-Voronoi Pruning (Cao et al. 2025).
    // Sculpted features (noses, jaws, ears, pauldrons) frequently fragment into
    // many small neighboring overhang regions whose micro-contacts (`o*`) and
    // tight perimeter rings (`fill-*`) sit 0.8–2.2 mm apart carrying <1 mm² each
    // against an ~8–10 mm² tip budget. Evaluate one global surface neighborhood
    // across all surviving candidates:
    // - Never prune discrete islands (`voxel`/`minima`/`intersection`),
    //   stabilization/reinforcement, `nearBase` flat sole anchors, or Pass-A adds.
    // - Never chain-prune (any contact that absorbs a neighbor becomes a locked
    //   anchor so every pruned point stays strictly within reach of a survivor).
    const working = candidates.filter((c) => !prunedSet.has(c));
    working.push(...addedCandidates);
    const addedSet = new Set(addedCandidates);
    let globalPruned = 0;

    if (working.length > 1) {
        const n = working.length;
        const kept = new Uint8Array(n);
        kept.fill(1);
        const isAnchor = new Uint8Array(n);
        const accumArea = new Float64Array(n);
        const normX = new Float64Array(n);
        const normY = new Float64Array(n);
        const normZ = new Float64Array(n);

        for (let i = 0; i < n; i++) {
            const c = working[i];
            const hardProtected = c.source !== 'overhang'
                || Boolean(c.nearBase)
                || Boolean(c.interior)
                || downwardLoadProtected.has(c)
                || addedSet.has(c);
            if (hardProtected) isAnchor[i] = 1;

            const measured = effectiveAreaByCandidate.get(c);
            if (measured !== undefined) {
                accumArea[i] = measured;
            } else if (c.source === 'overhang') {
                accumArea[i] = Math.max(0.05, Math.min(c.islandAreaMm2, settings.areaPerSupportMm2));
            } else {
                accumArea[i] = Math.max(0.1, Math.min(c.islandAreaMm2, 4.0));
            }

            const tn = c.tipNormal ?? { x: 0, y: 0, z: -1 };
            const nLen = Math.hypot(tn.x, tn.y, tn.z) || 1;
            normX[i] = tn.x / nLen;
            normY[i] = tn.y / nLen;
            normZ[i] = tn.z / nLen;
        }

        // Spatial 3D bucket (3.0 mm cells) for O(N·k) neighborhood lookup.
        const bucketSize = 3.0;
        const bucketKey = (bx: number, by: number, bz: number) =>
            `${bx},${by},${bz}`;
        const buckets = new Map<string, number[]>();
        for (let i = 0; i < n; i++) {
            const p = working[i].tipPos;
            const key = bucketKey(
                Math.floor(p.x / bucketSize),
                Math.floor(p.y / bucketSize),
                Math.floor(p.z / bucketSize),
            );
            const list = buckets.get(key);
            if (list) list.push(i);
            else buckets.set(key, [i]);
        }

        // Prune smallest-load, highest-Z overhang contacts first so lower leading
        // edges and higher-area anchors naturally survive as the covering hosts.
        const order: number[] = [];
        for (let i = 0; i < n; i++) {
            if (!isAnchor[i]) order.push(i);
        }
        order.sort((a, b) =>
            accumArea[a] - accumArea[b]
            || working[b].tipPos.z - working[a].tipPos.z
            || working[a].id.localeCompare(working[b].id),
        );

        for (const i of order) {
            if (!kept[i] || isAnchor[i]) continue;
            const c = working[i];
            const p = c.tipPos;
            const absNz = Math.min(1, Math.abs(normZ[i]));
            const angleDeg = (Math.acos(absNz) * 180) / Math.PI;
            // Tighter 0.85× bridge reach ensures well-spaced flat-slab grid points
            // (spaced >=1.8 mm) stay untouched while crammed 0.8–2.5 mm nose/chin
            // overhang fragments collapse cleanly.
            const reachMm = bridgeRadiusForAngleDeg(angleDeg) * 0.85;
            const reachSq = reachMm * reachMm;

            const mul = stefanTractionFactorAt(profile, p.x, p.y, p.z, settings.areaPerSupportMm2);
            const capMm2 = Math.max(3.0, settings.areaPerSupportMm2 / mul) * 0.85;

            const bx = Math.floor(p.x / bucketSize);
            const by = Math.floor(p.y / bucketSize);
            const bz = Math.floor(p.z / bucketSize);

            let bestHost = -1;
            let bestDistSq = Infinity;

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const list = buckets.get(bucketKey(bx + dx, by + dy, bz + dz));
                        if (!list) continue;
                        for (const k of list) {
                            if (k === i || !kept[k]) continue;
                            const hk = working[k];
                            if (Boolean(hk.interior) !== Boolean(c.interior)) continue;
                            // Inside a large region (>=25 mm²), Pass B already solved
                            // exact 0.25 mm voxel Voronoi coverage — only prune cross-region
                            // overlaps or small-region clutter here.
                            const ownerI = largeRegionOwnerByCandidate.get(c);
                            if (ownerI !== undefined && ownerI === largeRegionOwnerByCandidate.get(hk)) continue;
                            // Only a same-level or slightly lower tip can cover c
                            // (lower Z prints first — never drop a leading edge for a higher tip).
                            const zDiff = p.z - hk.tipPos.z;
                            if (zDiff < -0.6 || zDiff > 2.2) continue;

                            const ddx = p.x - hk.tipPos.x;
                            const ddy = p.y - hk.tipPos.y;
                            const hDistSq = ddx * ddx + ddy * ddy;
                            if (hDistSq > reachSq) continue;
                            const dist3Sq = hDistSq + zDiff * zDiff;
                            if (dist3Sq > reachSq) continue;

                            // Must lie on the same underside surface (not opposite side of thin wall).
                            const dotN = normX[i] * normX[k] + normY[i] * normY[k] + normZ[i] * normZ[k];
                            if (dotN < 0.70) continue;

                            // Traction capacity check: host must safely carry combined local area.
                            if (accumArea[k] + accumArea[i] > capMm2) continue;

                            // Prefer already-anchored/discrete hosts, then closest distance.
                            const weightedDistSq = isAnchor[k] ? dist3Sq * 0.65 : dist3Sq;
                            if (weightedDistSq < bestDistSq) {
                                bestDistSq = weightedDistSq;
                                bestHost = k;
                            }
                        }
                    }
                }
            }

            if (bestHost >= 0) {
                kept[i] = 0;
                isAnchor[bestHost] = 1;
                accumArea[bestHost] += accumArea[i];
                globalPruned++;
            }
        }

        if (globalPruned > 0) {
            const finalCandidates: CandidatePoint[] = [];
            for (let i = 0; i < n; i++) {
                if (kept[i]) finalCandidates.push(working[i]);
            }
            return {
                candidates: finalCandidates,
                stats: {
                    representativeLayers: profile.layers.length,
                    peakCrossSectionMm2: profile.peakAreaMm2,
                    added: addedCandidates.length,
                    pruned: prunedSet.size + globalPruned,
                },
                profile,
            };
        }
    }

    if (prunedSet.size === 0 && addedCandidates.length === 0) {
        return {
            candidates,
            stats: {
                representativeLayers: profile.layers.length,
                peakCrossSectionMm2: profile.peakAreaMm2,
                added: 0,
                pruned: 0,
            },
            profile,
        };
    }

    return {
        candidates: working,
        stats: {
            representativeLayers: profile.layers.length,
            peakCrossSectionMm2: profile.peakAreaMm2,
            added: addedCandidates.length,
            pruned: prunedSet.size,
        },
        profile,
    };
}
