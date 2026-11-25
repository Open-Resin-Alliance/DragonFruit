/**
 * Live printability: is every part of this model supported well enough to print
 * right now?
 *
 * The support-frame solver (`supportGraphStress.ts`) answers the other half of
 * that question — "do the supports hold?" — from the graph of members that
 * exist. It cannot see demand that nothing is attached to: delete half the
 * supports and the beam solve simply has less to carry. This module evaluates
 * the demand side in the same live refresh path, from the island scan's own
 * overhang footprints:
 *
 * - **Geometric sufficiency** — each overhang footprint's coverage by the tips
 *   actually placed (`computeRegionCoverage`), and the uncovered area that no
 *   disc reaches.
 * - **Budget context** — the same deficit the placement run reports
 *   (`computeLoadBudget`): demand mm² against the capacity the placed shafts
 *   are credited with. It is reported per region but is not a verdict term: a
 *   fully covered region whose own row has no assigned capacity is not a
 *   coverage failure.
 * - **Unsupported span** — plan distance from each footprint cell to the
 *   nearest holding tip below it, capped at `MAX_FREE_SPAN_MM`. This is the
 *   Tier 1 cantilever proxy: a long unbraced extension keeps its moment no
 *   matter how well-covered a point at one end is.
 *
 * What it is not: a force balance. Peel demand per region needs the 2D Stefan
 * field of *that region's* slice, which the representative-layer profile only
 * retains for a handful of global layers; until the per-layer XY texture lands
 * the frame report owns tip-load sufficiency. The profile's peak peel force and
 * peak area-jump are reported as context, not folded into the verdict.
 *
 * Everything here is pure: same inputs, same report, no allocation per voxel
 * beyond the counters.
 */

import type * as THREE from 'three';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { freeSpanForRegion, HoldingTipIndex, MAX_FREE_SPAN_MM, HIGH_LEVERAGE_SPAN_MM } from './supportSpan';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { ContactDisk, Segment, SupportState, Vec3 } from '../types';
import {
    REGION_COVERAGE_TARGET,
    computeRegionCoverage,
    coverageRadiusForRegion,
} from './coverage';
import { computeLoadBudget, type PlacedContact } from './loadBudget';
import type { LoadBudgetReport } from './types';
import type { RepresentativeLayerProfile } from './tractionOptimization';
import { computePeelLayerSamples, type LayerPeelPoint } from './supportGraphStress';

/** Footprint cells are the detector's 0.25 mm grid. */
const FOOTPRINT_CELL_AREA_MM2 = 0.25 * 0.25;
/** Contact Z at or below this is a plate contact, which needs no support. */
const PLATE_EPSILON_MM = 0.5;
/** Longest span we distinguish; beyond this the exact number stops mattering. */
export { MAX_FREE_SPAN_MM, HIGH_LEVERAGE_SPAN_MM } from './supportSpan';
/** Uncovered fraction of the scan's footprint area that reads as critical. */
const CRITICAL_UNCOVERED_FRACTION = 0.25;
/** An uncovered footprint at least this large is a hole, not a cosmetic rim. */
const CRITICAL_UNCOVERED_AREA_MM2 = 8;
/** Below this uncovered area a rim is cosmetic when its free span is short;
 *  0.25 mm² on a 331 mm² footprint must not make the whole model unsupported. */
export const MIN_MATERIAL_UNCOVERED_MM2 = 0.5;
/** Smallest peel texel: one texel per 0.5 mm of plan surface. */
const OVERLAY_MIN_CELL_MM = 0.5;
/** Hard cap on an overlay side, so a large model cannot allocate a giant texture. */
const OVERLAY_MAX_SIDE = 1024;
/** Full-intensity byte of the peel channel. */
const PEEL_FULL = 255;

export type PrintabilityVerdict = 'ready' | 'underSupported' | 'overloaded' | 'critical';
export type PrintabilitySeverity = 'ok' | 'warn' | 'critical';

export interface PrintabilityRegion {
    islandId: string;
    source: DetectedIsland['source'];
    contact: Vec3;
    baseZ: number;
    /** Detector footprint area (mm²) at the contact layer. */
    footprintAreaMm2: number;
    /** Fraction of the footprint within a placed tip's disc (0–1). */
    coverage: number;
    /** Effective disc radius the coverage test used (mm). */
    coverageRadiusMm: number;
    /** Footprint area no tip reaches (mm²). */
    uncoveredAreaMm2: number;
    /** Plan distance from the furthest footprint cell to a holding tip, capped. */
    freeSpanMm: number;
    /** Demand row from the load budget (mm²), when the island carries area. */
    demandMm2: number;
    capacityMm2: number;
    deficitMm2: number;
    severity: PrintabilitySeverity;
}

/**
 * Plan-resolution paint target for the model shader: the Screened Stefan
 * adhesion pressure, max-projected over the representative layers.
 */
export interface PeelOverlay {
    minX: number;
    minY: number;
    cellMm: number;
    nx: number;
    ny: number;
    /** Peak peel pressure over the representative layers, 0–255. */
    peel: Uint8Array;
}

export interface PrintabilityReport {
    verdict: PrintabilityVerdict;
    regions: PrintabilityRegion[];
    uncoveredRegions: number;
    deficientRegions: number;
    criticalRegions: number;
    totalFootprintAreaMm2: number;
    uncoveredAreaMm2: number;
    uncoveredFraction: number;
    worst: PrintabilityRegion | null;
    loadBudget: LoadBudgetReport;
    /** Peel force per sampled layer; utilization is zero until a frame is solved. */
    peelCurve: LayerPeelPoint[];
    /** Peak peel force across the sampled layers (N). */
    peakPeelForceN: number;
    peakPeelLayerZMm: number;
    /** Largest cross-section expansion shock in the profile (unitless, 1 = none). */
    peakAreaJumpRatio: number;
    /** Worst free span across all regions (mm, capped at `MAX_FREE_SPAN_MM`). */
    maxFreeSpanMm: number;
    /** Frame utilization supplied by the caller, when the solver has run. */
    frameMaxUtilizationPct: number;
    /** Stefan adhesion paint for the model shader; absent without sampled peel fields. */
    peelOverlay?: PeelOverlay;
}

export interface PrintabilityInput {
    /** Overhang/voxel islands from the live scan (`filteredIslands` or `structuralIslands`). */
    islands: readonly DetectedIsland[];
    /** Live support state; tips and shaft sizes are read from it. */
    snapshot: SupportState;
    modelId?: string;
    /** The density knob the run used: one support's share of surface (mm²). */
    areaPerSupportMm2: number;
    profile?: RepresentativeLayerProfile;
    poseDragMomentMm3?: number;
    poseTotalDragMomentMm3?: number;
    toppleCoverageNeeded?: boolean;
    /** Frame solver result, when one exists for the same edit. */
    frame?: { maxTipUtilizationPct: number; maxMemberUtilizationPct: number };
    /** Optional occluding mesh for the coverage test; omitted on the live path for speed. */
    mesh?: THREE.Mesh;
}

interface HoldingTip {
    tip: Vec3;
    contactDiameterMm: number;
}

/** A tip's own contact width, which is what its pull-off limit scales with. */
function coneContact(cone: ContactCone | undefined): { pos: Vec3; contactDiameterMm: number; bodyDiameterMm?: number } | null {
    if (!cone?.pos) return null;
    return {
        pos: cone.pos,
        contactDiameterMm: cone.profile?.contactDiameterMm ?? 0.28,
        bodyDiameterMm: cone.profile?.bodyDiameterMm,
    };
}

function diskContact(disk: ContactDisk | undefined): { pos: Vec3; contactDiameterMm: number } | null {
    if (!disk?.pos) return null;
    return { pos: disk.pos, contactDiameterMm: disk.contactDiameterMm ?? 0.28 };
}

function lastSegmentDiameter(segments: Segment[] | undefined): number | undefined {
    return segments?.[segments.length - 1]?.diameter;
}

/**
 * Tips and the shaft width behind each one, read from the snapshot's typed
 * collections. Mirrors the contact set the auto-place run builds for its own
 * load budget: trunks, branches, stumps and leaves carry a cone, sticks and
 * twigs bridge with two; braces and kickstands carry no model contact.
 */
function collectHoldingTips(snapshot: SupportState, modelId?: string): { tips: HoldingTip[]; contacts: PlacedContact[] } {
    const tips: HoldingTip[] = [];
    const contacts: PlacedContact[] = [];
    const add = (contact: { pos: Vec3; contactDiameterMm: number; bodyDiameterMm?: number } | null, shaftDiameterMm?: number): void => {
        if (!contact) return;
        tips.push({ tip: contact.pos, contactDiameterMm: contact.contactDiameterMm });
        contacts.push({ tip: contact.pos, preset: 'structure', shaftDiameterMm: shaftDiameterMm ?? contact.bodyDiameterMm });
    };

    for (const trunk of Object.values(snapshot.trunks ?? {})) {
        if (modelId !== undefined && trunk.modelId !== modelId) continue;
        add(coneContact(trunk.contactCone), lastSegmentDiameter(trunk.segments));
    }
    for (const branch of Object.values(snapshot.branches ?? {})) {
        if (modelId !== undefined && branch.modelId !== modelId) continue;
        add(coneContact(branch.contactCone), lastSegmentDiameter(branch.segments));
    }
    for (const leaf of Object.values(snapshot.leaves ?? {})) {
        if (modelId !== undefined && leaf.modelId !== modelId) continue;
        add(coneContact(leaf.contactCone));
    }
    for (const stump of Object.values(snapshot.stumps ?? {})) {
        if (modelId !== undefined && stump.modelId !== modelId) continue;
        add(coneContact(stump.contactCone), lastSegmentDiameter(stump.segments));
    }
    for (const stick of Object.values(snapshot.sticks ?? {})) {
        if (modelId !== undefined && stick.modelId !== modelId) continue;
        const a = coneContact(stick.contactConeA);
        const b = coneContact(stick.contactConeB);
        add(a && b ? (b.pos.z > a.pos.z ? b : a) : (a ?? b), lastSegmentDiameter(stick.segments));
    }
    for (const twig of Object.values(snapshot.twigs ?? {})) {
        if (modelId !== undefined && twig.modelId !== modelId) continue;
        const a = diskContact(twig.contactDiskA);
        const b = diskContact(twig.contactDiskB);
        add(a && b ? (b.pos.z > a.pos.z ? b : a) : (a ?? b), lastSegmentDiameter(twig.segments));
    }
    return { tips, contacts };
}

/**
 * Peel force per sampled layer, plus the peaks the panel and shader read. This
 * is the curve that exists with no supports at all: the demand side never needs
 * a solved frame, so adhesion is available on a freshly imported model.
 * Utilization fields are zero because no tip is being loaded here; the panel
 * only shows them when a solved report exists.
 */
function buildPeelCurve(profile: RepresentativeLayerProfile | undefined): {
    curve: LayerPeelPoint[];
    peakPeelForceN: number;
    peakPeelLayerZMm: number;
    peakAreaJumpRatio: number;
} {
    if (!profile || profile.layers.length === 0) {
        return { curve: [], peakPeelForceN: 0, peakPeelLayerZMm: 0, peakAreaJumpRatio: 1 };
    }
    const fallbackAreaMm2 = Math.max(1, profile.peakAreaMm2);
    const samples = profile.samples ?? profile.layers.map((layer) => ({ zMm: layer.zMm, areaMm2: layer.areaMm2 }));
    const sampled = computePeelLayerSamples(samples, profile.layers, fallbackAreaMm2);

    const points: Array<{ zMm: number; areaMm2: number; peelForceN: number }> = [];
    let peakPeelForceN = 0;
    let peakPeelLayerZMm = 0;
    for (const sample of sampled) {
        const zMm = Math.round(sample.zMm * 1000) / 1000;
        points.push({
            zMm,
            areaMm2: Math.round(sample.areaMm2 * 100) / 100,
            peelForceN: Math.round(sample.forceN * 1000) / 1000,
        });
        if (sample.forceN > peakPeelForceN) {
            peakPeelForceN = sample.forceN;
            peakPeelLayerZMm = zMm;
        }
    }

    let peakAreaJumpRatio = 1;
    for (const layer of profile.layers) {
        if (layer.areaJumpRatio > peakAreaJumpRatio) peakAreaJumpRatio = layer.areaJumpRatio;
    }
    const curve: LayerPeelPoint[] = points.map((point) => ({
        ...point,
        maxTipUtilPct: 0,
        maxMemberUtilPct: 0,
        critical: Math.abs(point.zMm - peakPeelLayerZMm) < 1e-6,
    }));
    return { curve, peakPeelForceN, peakPeelLayerZMm, peakAreaJumpRatio };
}

function severityFor(region: PrintabilityRegion): PrintabilitySeverity {
    // A hole is critical only when it is both large and beyond the bridgeable
    // span. An 8 mm² rim with a 3.9 mm span is a warning: the hand-supported
    // Puck print has a 13.3 mm² uncovered patch at 3.9 mm and prints.
    if (
        region.uncoveredAreaMm2 >= CRITICAL_UNCOVERED_AREA_MM2
        && region.freeSpanMm >= HIGH_LEVERAGE_SPAN_MM
    ) return 'critical';
    if (region.freeSpanMm < HIGH_LEVERAGE_SPAN_MM
        && (region.coverage >= REGION_COVERAGE_TARGET
            || region.uncoveredAreaMm2 < MIN_MATERIAL_UNCOVERED_MM2)) {
        return 'ok';
    }
    return 'warn';
}

/**
 * Rasterize the Screened Stefan adhesion pressure into a plan overlay. The field
 * exists per representative layer, so this is a max projection normalized to the
 * model's own hottest cell: it answers "where does the part peel", not "at which
 * Z" (the peak/hover rings still carry Z). No fields → no overlay.
 */
function buildPeelOverlay(profile: RepresentativeLayerProfile | undefined): PeelOverlay | undefined {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let peelPeak = 0;
    for (const layer of profile?.layers ?? []) {
        const field = layer.stefanField;
        if (!field) continue;
        minX = Math.min(minX, field.minX);
        minY = Math.min(minY, field.minY);
        maxX = Math.max(maxX, field.minX + field.cellMm * Math.max(0, field.nx - 1));
        maxY = Math.max(maxY, field.minY + field.cellMm * Math.max(0, field.ny - 1));
        if (field.peakPressureMm2 > peelPeak) peelPeak = field.peakPressureMm2;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || peelPeak <= 0) return undefined;

    const cellMm = Math.max(OVERLAY_MIN_CELL_MM, Math.max(maxX - minX, maxY - minY) / OVERLAY_MAX_SIDE);
    const nx = Math.floor((maxX - minX) / cellMm) + 1;
    const ny = Math.floor((maxY - minY) / cellMm) + 1;
    const peel = new Uint8Array(nx * ny);
    let painted = false;

    // Sample the solved field at every texel instead of stamping one texel per
    // field cell: the field grid (~0.75 mm) is coarser than the overlay (0.5 mm),
    // and stamping left the in-between texels at zero, which rendered as a dot
    // lattice. Bilinear keeps the pressure continuous.
    const scale = PEEL_FULL / peelPeak;
    const layersWithFields = (profile?.layers ?? []).filter((layer) => layer.stefanField);
    for (let iy = 0; iy < ny; iy++) {
        const y = minY + iy * cellMm;
        for (let ix = 0; ix < nx; ix++) {
            const x = minX + ix * cellMm;
            let best = 0;
            for (const layer of layersWithFields) {
                const field = layer.stefanField!;
                const fx = (x - field.minX) / field.cellMm - 0.5;
                const fy = (y - field.minY) / field.cellMm - 0.5;
                if (fx < -1 || fy < -1 || fx > field.nx || fy > field.ny) continue;
                const x0 = Math.floor(fx);
                const y0 = Math.floor(fy);
                const tx = fx - x0;
                const ty = fy - y0;
                const x1 = Math.min(field.nx - 1, Math.max(0, x0 + 1));
                const y1 = Math.min(field.ny - 1, Math.max(0, y0 + 1));
                const cx0 = Math.min(field.nx - 1, Math.max(0, x0));
                const cy0 = Math.min(field.ny - 1, Math.max(0, y0));
                const p00 = field.pressure[cy0 * field.nx + cx0];
                const p10 = field.pressure[cy0 * field.nx + x1];
                const p01 = field.pressure[y1 * field.nx + cx0];
                const p11 = field.pressure[y1 * field.nx + x1];
                const value = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
                if (value > best) best = value;
            }
            if (best <= 0) continue;
            const value = Math.min(PEEL_FULL, Math.round(best * scale));
            if (value > 0) {
                peel[iy * nx + ix] = value;
                painted = true;
            }
        }
    }

    return painted ? { minX, minY, cellMm, nx, ny, peel } : undefined;
}

/**
 * Build the live printability report for one model. Call after every support
 * edit, in the same debounce as the frame solve.
 */
export function evaluatePrintability(input: PrintabilityInput): PrintabilityReport {
    const { islands, snapshot, modelId, areaPerSupportMm2 } = input;
    const { tips, contacts } = collectHoldingTips(snapshot, modelId);
    const tipIndex = new HoldingTipIndex(tips.map((t) => t.tip));
    const coverageTips = tips.map((t) => t.tip);

    const loadBudget = computeLoadBudget({
        islands: [...islands],
        contacts,
        areaPerSupportMm2,
        poseDragMomentMm3: input.poseDragMomentMm3,
        poseTotalDragMomentMm3: input.poseTotalDragMomentMm3,
        toppleCoverageNeeded: input.toppleCoverageNeeded ?? false,
    });
    const budgetByIsland = new Map(loadBudget.rows.map((row) => [row.islandId, row]));

    const regions: PrintabilityRegion[] = [];
    for (const island of islands) {
        const voxels = island.contactVoxels;
        if (!voxels || voxels.count === 0) continue;
        if (island.grounded || island.baseZ <= PLATE_EPSILON_MM) continue;
        // The detector's own area, not `count × 0.25²`: overhang footprints are
        // sampled at the scan's `pxMm` (0.05 mm by default), so counting them at
        // the voxel detector's cell size inflated a 30 mm plate to 21,746 mm².
        const areaMm2 = island.areaMm2 && island.areaMm2 > 0
            ? island.areaMm2
            : voxels.count * FOOTPRINT_CELL_AREA_MM2;
        if (!(areaMm2 > 0)) continue;

        const radiusMm = coverageRadiusForRegion(island);
        // Nothing placed below the region: every cell is bare and at the cap, and
        // the cell visits would only rediscover that. This is the common live state.
        const coverage = tips.length === 0
            ? 0
            : computeRegionCoverage(island, coverageTips, radiusMm, input.mesh);
        const uncoveredAreaMm2 = areaMm2 * (1 - coverage);
        const freeSpanMm = tips.length === 0
            ? MAX_FREE_SPAN_MM
            : freeSpanForRegion(island, tipIndex, island.baseZ);
        const row = budgetByIsland.get(island.id);
        const region: PrintabilityRegion = {
            islandId: island.id,
            source: island.source,
            contact: { x: island.contact.x, y: island.contact.y, z: island.contact.z },
            baseZ: island.baseZ,
            footprintAreaMm2: areaMm2,
            coverage,
            coverageRadiusMm: radiusMm,
            uncoveredAreaMm2,
            freeSpanMm,
            demandMm2: row?.demandMm2 ?? areaMm2,
            capacityMm2: row?.capacityMm2 ?? 0,
            deficitMm2: row?.deficitMm2 ?? areaMm2,
            severity: 'ok',
        };
        region.severity = severityFor(region);
        regions.push(region);
    }

    let totalFootprintAreaMm2 = 0;
    let uncoveredAreaMm2 = 0;
    let uncoveredRegions = 0;
    let deficientRegions = 0;
    let criticalRegions = 0;
    let maxFreeSpanMm = 0;
    let worst: PrintabilityRegion | null = null;
    for (const region of regions) {
        totalFootprintAreaMm2 += region.footprintAreaMm2;
        uncoveredAreaMm2 += region.uncoveredAreaMm2;
        if (region.uncoveredAreaMm2 >= MIN_MATERIAL_UNCOVERED_MM2) uncoveredRegions++;
        if (region.severity === 'warn') deficientRegions++;
        if (region.severity === 'critical') criticalRegions++;
        if (region.freeSpanMm > maxFreeSpanMm) maxFreeSpanMm = region.freeSpanMm;
        if (
            worst === null
            || region.uncoveredAreaMm2 > worst.uncoveredAreaMm2 + 1e-6
            || (Math.abs(region.uncoveredAreaMm2 - worst.uncoveredAreaMm2) <= 1e-6 && region.deficitMm2 > worst.deficitMm2)
        ) {
            worst = region;
        }
    }

    const uncoveredFraction = totalFootprintAreaMm2 > 0 ? uncoveredAreaMm2 / totalFootprintAreaMm2 : 0;
    const frameMaxUtilizationPct = Math.max(
        input.frame?.maxTipUtilizationPct ?? 0,
        input.frame?.maxMemberUtilizationPct ?? 0,
    );
    // The per-island load budget is a report: a fully covered region whose own
    // row has no assigned capacity is not a coverage failure. Only a material
    // uncovered/warn region decides the verdict.
    const underSupported = uncoveredRegions > 0 || deficientRegions > 0;
    const overloaded = frameMaxUtilizationPct > 100;
    const structuralllyHollow = uncoveredFraction >= CRITICAL_UNCOVERED_FRACTION
        && uncoveredAreaMm2 >= CRITICAL_UNCOVERED_AREA_MM2;

    let verdict: PrintabilityVerdict;
    if ((underSupported && overloaded) || structuralllyHollow) {
        verdict = 'critical';
    } else if (overloaded) {
        verdict = 'overloaded';
    } else if (underSupported) {
        verdict = 'underSupported';
    } else {
        verdict = 'ready';
    }

    const peel = buildPeelCurve(input.profile);
    return {
        verdict,
        regions,
        uncoveredRegions,
        deficientRegions,
        criticalRegions,
        totalFootprintAreaMm2,
        uncoveredAreaMm2,
        uncoveredFraction,
        worst,
        loadBudget,
        peelCurve: peel.curve,
        peakPeelForceN: peel.peakPeelForceN,
        peakPeelLayerZMm: peel.peakPeelLayerZMm,
        peakAreaJumpRatio: peel.peakAreaJumpRatio,
        maxFreeSpanMm,
        frameMaxUtilizationPct,
        peelOverlay: buildPeelOverlay(input.profile),
    };
}
