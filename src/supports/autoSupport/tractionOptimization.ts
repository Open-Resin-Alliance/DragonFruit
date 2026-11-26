import * as THREE from 'three';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { footprintX, footprintY, footprintZ } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';
import { bridgeRadiusForAngleDeg } from './constants';
import { DEFAULT_SUPPORT_BREAK_STRENGTH_MPA } from './greenMaterialCalibration';
import { resolveSizingBand } from './parameterSizing';
import { NOMINAL_PEEL_PRESSURE_MPA } from './treeSynthesis';

/** Coarse occupancy cell size (mm) for cross-sectional layer IoU clustering. */
const LAYER_IOU_CELL_MM = 2.0;
/** Adjacent layers with IoU >= this and relative area change <= threshold belong to one cluster. */
const LAYER_COHERENCE_IOU_MIN = 0.85;
const LAYER_COHERENCE_AREA_DELTA_MAX = 0.20;
/** Bound the extra Stefan solves spent picking a cluster's peak-load layer. */
const MAX_CLUSTER_LOAD_CANDIDATES = 4;
/** Hard cap on sampled planes when slicing at the print layer height (a 200 mm part at 50 µm). */
const MAX_SAMPLED_PLANES = 1024;
/** Plan cell of the per-layer growth masks (mm); coarser only for very large parts. */
const GROWTH_CELL_MM = 0.5;
const GROWTH_MAX_SIDE = 1024;
/** Added area below this is a layer step on a thin rim, not a new surface. */
const GROWTH_MIN_ADDED_MM2 = 0.1;
/** Most growth layers retained per profile, largest addition first. */
const MAX_GROWTH_LAYERS = 128;
/** Cap on retained added-cell indices across the profile (≈ 8 MB). */
const MAX_GROWTH_CELLS = 2_000_000;
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
    /**
     * Every sampled slice at the requested step (the print profile's layer
     * height when the caller supplies it), for the peel curve and force ladder.
     * `layers` stays the PDE-clustered subset; this is the resolution the user
     * sees and the layer-by-layer areas the curve is built from. Absent on
     * hand-built profiles, which fall back to `layers`.
     */
    samples?: LayerAreaSample[];
    /** Layers that added area over the layer below, largest first-capped. */
    growth?: LayerGrowth[];
    /** The plan grid `growth[].addedCells` index into. */
    growthGrid?: LayerGrowthGrid;
    /** Peak cross-sectional area across the entire model (mm²). */
    peakAreaMm2: number;
    /** Total raw Z planes sampled before clustering. */
    sampledPlaneCount: number;
}

/** One sampled plane: the peel curve's own resolution. */
export interface LayerAreaSample {
    zMm: number;
    areaMm2: number;
}

/** Plan grid shared by every growth mask in a profile. */
export interface LayerGrowthGrid {
    minX: number;
    minY: number;
    cellMm: number;
    nx: number;
    ny: number;
}

/**
 * A layer that adds solid area over the one below it: the raw material for
 * consecutive-layer overhang detection. `addedCells` are row-major indices into
 * the profile's `growthGrid` for the cells solid here and not below, so a
 * consumer can ask *where* the new surface is without re-slicing.
 */
export interface LayerGrowth {
    zMm: number;
    /** Green's-theorem area difference from the layer below (mm²). */
    addedAreaMm2: number;
    /** `area[k] / area[k-1]` (1 = no growth). */
    growthRatio: number;
    addedCells: Uint32Array;
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
 * Rasterize one plane's closed contour segments into a plan occupancy mask by
 * the even-odd rule. Segments are the same directed p→q pairs the area integral
 * uses; only their geometry matters here.
 */
function fillPlaneMask(segments: readonly number[], grid: LayerGrowthGrid): Uint8Array {
    const mask = new Uint8Array(grid.nx * grid.ny);
    const crossings: number[][] = Array.from({ length: grid.ny }, () => []);
    for (let s = 0; s + 3 < segments.length; s += 4) {
        const px = segments[s];
        const py = segments[s + 1];
        const qx = segments[s + 2];
        const qy = segments[s + 3];
        if (py === qy) continue;
        const yLo = Math.min(py, qy);
        const yHi = Math.max(py, qy);
        const jStart = Math.max(0, Math.ceil((yLo - grid.minY) / grid.cellMm - 0.5));
        const jEnd = Math.min(grid.ny - 1, Math.floor((yHi - grid.minY) / grid.cellMm - 0.5));
        for (let j = jStart; j <= jEnd; j++) {
            const y = grid.minY + (j + 0.5) * grid.cellMm;
            crossings[j].push(px + ((qx - px) * (y - py)) / (qy - py));
        }
    }
    for (let j = 0; j < grid.ny; j++) {
        const xs = crossings[j];
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            const iStart = Math.max(0, Math.ceil((xs[i] - grid.minX) / grid.cellMm - 0.5));
            const iEnd = Math.min(grid.nx - 1, Math.floor((xs[i + 1] - grid.minX) / grid.cellMm - 0.5));
            const row = j * grid.nx;
            for (let ix = iStart; ix <= iEnd; ix++) mask[row + ix] = 1;
        }
    }
    return mask;
}

/**
 * Consecutive-layer growth: every plane that added area over the one below,
 * with the added cells retained. Capped by count and total cells, largest
 * addition first, then returned in Z order for deterministic consumers.
 */
function buildLayerGrowth(
    planeZ: Float64Array,
    areas: Float64Array,
    sliceSegments: readonly number[][],
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { growth: LayerGrowth[]; grid: LayerGrowthGrid } {
    const spanX = Math.max(1e-3, bounds.maxX - bounds.minX);
    const spanY = Math.max(1e-3, bounds.maxY - bounds.minY);
    const cellMm = Math.max(GROWTH_CELL_MM, Math.max(spanX, spanY) / GROWTH_MAX_SIDE);
    const grid: LayerGrowthGrid = {
        minX: bounds.minX,
        minY: bounds.minY,
        cellMm,
        nx: Math.floor(spanX / cellMm) + 1,
        ny: Math.floor(spanY / cellMm) + 1,
    };

    const candidates: Array<{ index: number; previousIndex: number; addedMm2: number; ratio: number }> = [];
    for (let k = 1; k < planeZ.length; k++) {
        // A plane exactly at a feature boundary can cut no triangles and read as
        // zero area; measure against the last plane that actually had material
        // below instead of treating the gap as a birth.
        let previousIndex = k - 1;
        while (previousIndex >= 0 && areas[previousIndex] <= 0.05) previousIndex--;
        if (previousIndex < 0) continue;
        const addedMm2 = areas[k] - areas[previousIndex];
        if (addedMm2 < GROWTH_MIN_ADDED_MM2) continue;
        candidates.push({
            index: k,
            previousIndex,
            addedMm2,
            ratio: areas[previousIndex] > 0.5 ? areas[k] / areas[previousIndex] : 1,
        });
    }
    candidates.sort((a, b) => b.addedMm2 - a.addedMm2 || a.index - b.index);

    const growth: LayerGrowth[] = [];
    let cellBudget = MAX_GROWTH_CELLS;
    for (const candidate of candidates) {
        if (growth.length >= MAX_GROWTH_LAYERS || cellBudget <= 0) break;
        const current = fillPlaneMask(sliceSegments[candidate.index], grid);
        const previous = fillPlaneMask(sliceSegments[candidate.previousIndex], grid);
        const addedCells: number[] = [];
        for (let i = 0; i < current.length; i++) {
            if (current[i] === 1 && previous[i] === 0) addedCells.push(i);
        }
        if (addedCells.length === 0) continue;
        cellBudget -= addedCells.length;
        growth.push({
            zMm: planeZ[candidate.index],
            addedAreaMm2: candidate.addedMm2,
            growthRatio: candidate.ratio,
            addedCells: Uint32Array.from(addedCells),
        });
    }
    growth.sort((a, b) => a.zMm - b.zMm);
    return { growth, grid };
}

/**
 * Fast single-pass representative-layer slicer (Cao et al. 2025, Algorithm 1).
 *
 * Samples horizontal planes through the world-frame mesh — at the print
 * profile's layer height when `options.layerHeightMm` is given, otherwise one
 * plane per millimetre (24–72 planes) — computes exact closed cross-section
 * area per slice via Green's theorem on triangle-plane intersections, and
 * clusters consecutive coherent slices by coarse 2D IoU and relative area
 * delta. Emits the peak-load representative layer per cluster for the Stefan
 * PDE solve, plus every sampled plane as `samples` for the per-layer curve.
 */
export function extractRepresentativeLayers(
    mesh: THREE.Mesh | undefined | null,
    planeCountOverride?: number,
    options?: { layerHeightMm?: number },
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
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < vCount; i++) {
        const lx = posAttr.getX(i);
        const ly = posAttr.getY(i);
        const lz = posAttr.getZ(i);
        const x = m0 * lx + m4 * ly + m8 * lz + m12;
        const y = m1 * lx + m5 * ly + m9 * lz + m13;
        wx[i] = x;
        wy[i] = y;
        const z = m2 * lx + m6 * ly + m10 * lz + m14;
        wz[i] = z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }

    const spanZ = maxZ - minZ;
    if (!Number.isFinite(spanZ) || spanZ < 0.5) {
        return { layers: [], peakAreaMm2: 0, sampledPlaneCount: 0 };
    }

    const layerHeightMm = options?.layerHeightMm && options.layerHeightMm > 0 ? options.layerHeightMm : null;
    const planeCount = planeCountOverride !== undefined
        ? Math.max(4, Math.min(128, Math.round(planeCountOverride)))
        : layerHeightMm !== null
            ? Math.max(2, Math.min(MAX_SAMPLED_PLANES, Math.round(spanZ / layerHeightMm)))
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
    const samples: LayerAreaSample[] = new Array(planeCount);
    for (let k = 0; k < planeCount; k++) {
        const a = Math.abs(signedArea2[k]) * 0.5;
        areas[k] = a;
        samples[k] = { zMm: planeZ[k], areaMm2: a };
        if (a > peakAreaMm2) peakAreaMm2 = a;
    }

    // Cluster consecutive coherent slices and emit the MAX-LOAD representative
    // layer per cluster. The paper picks the layer that maximises separation
    // force; our 2D Screened Stefan solve is that force model, so the load is
    // the field's integrated force. Candidate layers are the cluster's area
    // maxima (the force scale is area first); at most four fields are solved,
    // so a coherent run still costs roughly one solve per cluster.
    const layers: RepresentativeLayer[] = [];
    let clusterStart = 0;
    let prevClusterArea = 0;

    const peakLoadLayerInCluster = (start: number, end: number): { index: number; field: StefanPressureField } | null => {
        const candidates = new Set<number>();
        let areaPeak = start;
        for (let k = start; k <= end; k++) {
            if (areas[k] > areas[areaPeak]) areaPeak = k;
        }
        candidates.add(areaPeak);
        for (let k = start + 1; k < end; k++) {
            if (areas[k] > areas[k - 1] && areas[k] >= areas[k + 1]) candidates.add(k);
        }
        const ordered = [...candidates]
            .sort((a, b) => areas[b] - areas[a] || a - b)
            .slice(0, MAX_CLUSTER_LOAD_CANDIDATES);
        let best: { index: number; field: StefanPressureField } | null = null;
        for (const index of ordered) {
            if (areas[index] <= 0.05) continue;
            const field = solveStefanFieldFromSegments(sliceSegments[index]);
            if (!field) continue;
            if (!best || field.integratedForceMm4 > best.field.integratedForceMm4) {
                best = { index, field };
            }
        }
        return best;
    };

    const flushCluster = (end: number) => {
        const best = peakLoadLayerInCluster(clusterStart, end);
        if (!best) return;
        const area = areas[best.index];
        const areaJumpRatio = prevClusterArea > 0.5 ? area / prevClusterArea : 1.0;
        layers.push({
            zMm: planeZ[best.index],
            areaMm2: area,
            areaJumpRatio,
            clusterSpanCount: end - clusterStart + 1,
            stefanField: best.field,
        });
        prevClusterArea = area;
    };

    for (let k = 1; k < planeCount; k++) {
        const maxA = Math.max(areas[k], areas[k - 1], 1.0);
        const relDelta = Math.abs(areas[k] - areas[k - 1]) / maxA;
        const iou = setIoU(occSets[k], occSets[k - 1]);
        const coherent = iou >= LAYER_COHERENCE_IOU_MIN && relDelta <= LAYER_COHERENCE_AREA_DELTA_MAX;
        if (!coherent) {
            flushCluster(k - 1);
            clusterStart = k;
        }
    }
    flushCluster(planeCount - 1);

    const growthResult = buildLayerGrowth(planeZ, areas, sliceSegments, { minX, minY, maxX, maxY });
    return growthResult.growth.length > 0
        ? {
            layers,
            samples,
            growth: growthResult.growth,
            growthGrid: growthResult.grid,
            peakAreaMm2,
            sampledPlaneCount: planeCount,
        }
        : { layers, samples, peakAreaMm2, sampledPlaneCount: planeCount };
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

export interface CvtSamplePoint {
    x: number;
    y: number;
    z: number;
    weight: number;
}

/**
 * One CVT/Lloyd repositioning step of the paper's `E_f` term on a discrete
 * footprint. Each sample cell is assigned to its nearest support point in plan;
 * a movable point moves toward the weight centroid of its cell, but only to a
 * footprint sample (so the contact stays on the surface) and at most
 * `maxStepMm` per iteration. Fixed points still own cells and constrain the
 * partition.
 */
export function cvtRepositionPoints(
    points: ReadonlyArray<{ x: number; y: number; z: number }>,
    samples: ReadonlyArray<CvtSamplePoint>,
    iterations = 3,
    maxStepMm = 2,
    movable?: ReadonlyArray<boolean>,
    /** Coverage disc; when a cell extends past it the move is blended toward
     *  that cell's furthest sample (the paper's E_o term) instead of pure
     *  density centroid. */
    coverageRadiusMm?: number,
): Array<{ x: number; y: number; z: number }> {
    const next = points.map((p) => ({ ...p }));
    if (points.length === 0 || samples.length === 0 || iterations <= 0) return next;
    for (let iter = 0; iter < iterations; iter++) {
        const count = next.length;
        const sumW = new Float64Array(count);
        const sumX = new Float64Array(count);
        const sumY = new Float64Array(count);
        const cells: number[][] = Array.from({ length: count }, () => []);
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            let best = 0;
            let bestD2 = Infinity;
            for (let j = 0; j < count; j++) {
                const dx = sample.x - next[j].x;
                const dy = sample.y - next[j].y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = j;
                }
            }
            const weight = Math.max(0.05, sample.weight);
            cells[best].push(i);
            sumW[best] += weight;
            sumX[best] += weight * sample.x;
            sumY[best] += weight * sample.y;
        }
        const updated = next.map((p, j) => {
            if (movable && !movable[j]) return p;
            if (cells[j].length === 0 || sumW[j] <= 0) return p;
            const cx = sumX[j] / sumW[j];
            const cy = sumY[j] / sumW[j];
            // Move to the continuous weighted centroid; the cell sample
            // nearest it supplies the surface Z. Snapping the XY to a cell
            // centroid quantizes the step and leaves grid-aligned points
            // exactly where they started.
            let nearestZ = p.z;
            let bestD2 = Infinity;
            let furthestIndex = cells[j][0] ?? -1;
            let furthestD2 = -1;
            for (const index of cells[j]) {
                const sample = samples[index];
                const dToCentroid = (sample.x - cx) ** 2 + (sample.y - cy) ** 2;
                if (dToCentroid < bestD2) {
                    bestD2 = dToCentroid;
                    nearestZ = sample.z;
                }
                const dToPoint = (sample.x - p.x) ** 2 + (sample.y - p.y) ** 2;
                if (dToPoint > furthestD2) {
                    furthestD2 = dToPoint;
                    furthestIndex = index;
                }
            }
            let target = { x: cx, y: cy, z: nearestZ };
            if (coverageRadiusMm !== undefined && furthestIndex >= 0 && furthestD2 > coverageRadiusMm * coverageRadiusMm) {
                const furthest = samples[furthestIndex];
                target = {
                    x: cx * 0.5 + furthest.x * 0.5,
                    y: cy * 0.5 + furthest.y * 0.5,
                    z: furthest.z,
                };
            }
            const dx = target.x - p.x;
            const dy = target.y - p.y;
            const dist = Math.hypot(dx, dy);
            const scale = dist > maxStepMm && dist > 1e-9 ? maxStepMm / dist : 1;
            return { x: p.x + dx * scale, y: p.y + dy * scale, z: target.z };
        });
        next.splice(0, next.length, ...updated);
    }
    // Land on an actual footprint sample at the end: an off-surface centroid
    // can miss the region's triangle on a rotated/irregular face and be
    // rejected at placement.
    for (let j = 0; j < next.length; j++) {
        if (movable && !movable[j]) continue;
        let best = -1;
        let bestD2 = Infinity;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            const d2 = (sample.x - next[j].x) ** 2 + (sample.y - next[j].y) ** 2;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = i;
            }
        }
        if (best >= 0) next[j] = { x: samples[best].x, y: samples[best].y, z: samples[best].z };
    }
    return next;
}

interface VoronoiSeed {
    candidate: CandidatePoint;
    prunable: boolean;
}

interface VoronoiCellStats {
    /** Raw geometric footprint area of this Voronoi cell (mm²). */
    areaMm2: number;
    /** Spatially integrated Screened Stefan traction demand ∫ τ(x,y) dA
     *  (mm² × traction factor; multiply by the nominal pressure for N). */
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
 * peel traction multiplier just above the region. Demand is integrated in
 * "demand units" (mm² × traction factor); multiplying by
 * `NOMINAL_PEEL_PRESSURE_MPA` gives newtons, and each contact's capacity is its
 * break load (`supportStrengthMpa × π/4 × tip diameter²`) expressed in those
 * same units, so the test is a real force comparison rather than a rescaled
 * spacing knob. A candidate without its own `tipDiameterMm` is costed at the
 * run's sizing-band tip; the post-placement force budget re-checks the real
 * placed diameters.
 * - **Add** a reinforcement contact at the furthest point of any Voronoi cell
 *   whose demand exceeds its own tip's break load or whose reach exceeds the
 *   angle-dependent bridge radius.
 * - **Conservatively prune** only interior `grid-` lattice contacts whose removal
 *   leaves every neighboring Voronoi cell under `80%` of *its* break load and
 *   `90%` of bridge reach. Never prunes perimeter corners (`fill-`), `nearBase`
 *   contacts, or primary discrete islands (`voxel`/`minima`/`intersection`).
 */
export function optimizeContactsByTraction(
    candidates: CandidatePoint[],
    overhangRegions: readonly DetectedIsland[],
    settings: AutoSupportSettings,
    mesh?: THREE.Mesh | null,
    modelId: string = '',
    /** The print profile's layer height; without it the slicer samples ~1 mm,
     *  which is also the peel curve the run's stress report would carry. */
    options?: {
        layerHeightMm?: number;
        profile?: RepresentativeLayerProfile;
        /** Support break strength (MPa), already derated from the datasheet. */
        supportStrengthMpa?: number;
    },
): TractionOptimizationResult {
    const profile = options?.profile ?? extractRepresentativeLayers(mesh, undefined, { layerHeightMm: options?.layerHeightMm });
    const supportStrengthMpa = Math.max(
        0.01,
        options?.supportStrengthMpa ?? DEFAULT_SUPPORT_BREAK_STRENGTH_MPA,
    );
    const bandTipDiameterMm = Math.max(0.1, resolveSizingBand(settings.sizingPreset).tipContactDiameterMm);
    const capacityByCandidate = new Map<CandidatePoint, number>();
    /** A contact's break load in the demand units above: N / (N/mm²). */
    const capacityDemandFor = (candidate: CandidatePoint): number => {
        const cached = capacityByCandidate.get(candidate);
        if (cached !== undefined) return cached;
        const diameterMm = Math.max(0.1, candidate.tipDiameterMm ?? bandTipDiameterMm);
        const capacityN = supportStrengthMpa * Math.PI * 0.25 * diameterMm * diameterMm;
        const demand = capacityN / NOMINAL_PEEL_PRESSURE_MPA;
        capacityByCandidate.set(candidate, demand);
        return demand;
    };
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
        // Capacity follows each seed's own tip area (`capacityDemandFor`), not the
        // region's spacing: the break load of a 0.22 mm contact and a 0.5 mm one
        // are different constraints on the same cell.
        const addRadiusSq = (angleBridgeRadiusMm * 1.05) ** 2;
        const minAddSpacingSq = MIN_TRACTION_CONTACT_SPACING_MM * MIN_TRACTION_CONTACT_SPACING_MM;

        // CVT repositioning (paper E_f): move the organic, non-grid points
        // toward the traction-weighted centroid of their Voronoi cells before
        // adding/pruning. Grid points stay on their lattice; starts are moved
        // here too, but the start closure later restores their recipe count.
        const cvtSamples: CvtSamplePoint[] = new Array(si);
        for (let i = 0; i < si; i++) {
            cvtSamples[i] = { x: sx[i], y: sy[i], z: sz[i], weight: Math.max(0.05, sTraction[i]) };
        }
        // The lattice (`grid-*`) stays on its nodes. Organic coverage and
        // fill points (`fill-`, `perim-`, `gap-`, `start-`, `island-`, `span-`)
        // are the paper's free support points and are the ones CVT moves.
        const organicId = (id: string): boolean => id.startsWith('fill-')
            || id.startsWith('perim-')
            || id.startsWith('gap-')
            || id.startsWith('start-')
            || id.startsWith('island-')
            || id.startsWith('span-');
        // Only large overhangs have enough footprint cells for a Lloyd step
        // to preserve edge coverage; a small region loses its perimeter when a
        // handful of points move to a density centroid. Large flats are where
        // the paper's E_f term pays off.
        const cvTRegion = (region.areaMm2 ?? 0) >= 50 && (region.overhangAngleDeg ?? 0) <= 15;
        const cvtMovable = cvTRegion
            ? seeds.map((seed) => organicId(seed.candidate.id) && !seed.candidate.nearBase)
            : [];
        if (cvtMovable.some(Boolean)) {
            const moved = cvtRepositionPoints(
                seeds.map((seed) => seed.candidate.tipPos),
                cvtSamples,
                3,
                2,
                cvtMovable,
                angleBridgeRadiusMm,
            );
            for (let j = 0; j < seeds.length; j++) {
                if (!cvtMovable[j]) continue;
                const p = moved[j];
                seeds[j].candidate.tipPos = { x: p.x, y: p.y, z: p.z };
                seeds[j].candidate.zHeight = p.z;
            }
        }

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
                const areaRatio = cell.tractionDemandMm2 / (capacityDemandFor(seeds[j].candidate) * 1.15);
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
        // headroom (<= 80% of the absorbing tip's break load and <= 90% of
        // bridge reach).
        if (seeds.length > 2) {
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
                        if (nextDemand > capacityDemandFor(seeds[alt].candidate) * 0.80) {
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
        const accumDemand = new Float64Array(n);
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
            accumDemand[i] = accumArea[i]
                * stefanTractionFactorAt(profile, c.tipPos.x, c.tipPos.y, c.tipPos.z, settings.areaPerSupportMm2);

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
            accumDemand[a] - accumDemand[b]
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

                            // Capacity check: host and absorbed cell must stay under
                            // the host contact's break load (85 % headroom).
                            if (accumDemand[k] + accumDemand[i] > capacityDemandFor(working[k]) * 0.85) continue;

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
                accumDemand[bestHost] += accumDemand[i];
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
