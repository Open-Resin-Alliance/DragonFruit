/**
 * The force budget: the peel each placed support carries, in newtons, against
 * the load that support can hold, in newtons.
 *
 * Why it exists. `loadBudget` and the Phase 1c Voronoi pass both budget in
 * **mm²**: demand is area times a unitless traction multiplier, and capacity is
 * the density knob's own spacing rescaled. Neither can see the two quantities
 * that decide whether a support breaks — the newtons the layer puts on it, and
 * the newtons its contact (or its own shaft) can hold. This module evaluates
 * the forest we actually placed:
 *
 * - **Demand** is the representative layer's peel force — the same
 *   `computeLayerPeelForceAndCop` the frame solver uses — split across that
 *   layer's Stefan pressure mask and charged cell by cell to the nearest active
 *   tip in plan (the nearest-support / Voronoi assumption Cao et al. 2025 use).
 * - **Capacity** is `strength × min(contact area, thinnest section of the tip's
 *   own entity)`. The strength is the support break strength the frame solver
 *   divides by, so a budget reading and a stress reading cannot disagree.
 *
 * That makes this the capacity-constrained covering test for the tips we placed:
 * a row above 100% is a contact that would pull off before the layer releases.
 * Each over-budget row carries the farthest cell point it serves and the nearest
 * down-facing surface point to it, which is where an added contact removes the
 * most load per millimetre of new support.
 *
 * What it is not: a replacement for the frame solve. This is a local,
 * nearest-support allocation (each cell is one support's job); the frame solve
 * is the global redistribution (how the cured layer as a diaphragm shares the
 * same layer force across every tip and every brace). Both readings are kept
 * because they fail differently: a local cell can exceed a contact's strength
 * while the global frame still balances, and a member can overload under the
 * frame while every local cell sits inside its support's share.
 */

import {
    footprintBounds,
    footprintX,
    footprintY,
    footprintZ,
} from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import type { Vec3 } from '../types';
import { MAX_SIDE_WALL_CONTACT_LEAN_DEG } from '@/supports/PlacementLogic/ConeAxisPolicy';
import { DEFAULT_SUPPORT_BREAK_STRENGTH_MPA } from './greenMaterialCalibration';
import {
    computeLayerPeelForceAndCop,
    type SupportGraph,
} from './supportGraphStress';
import { NOMINAL_PEEL_PRESSURE_MPA } from './treeSynthesis';
import type { RepresentativeLayerProfile } from './tractionOptimization';
import type { ForceBudgetReport, ForceBudgetTipRow } from './types';

/** Critical layers evaluated per call, highest layer force first. */
export const FORCE_BUDGET_MAX_LAYERS = 3;
/** How far in plan an added contact may move from its over-budget cell's far point. */
const ADD_SNAP_MM = 3.0;
/** Down-facing surfaces this far below the layer can still take an added contact. */
const ISLAND_WINDOW_BELOW_MM = 8.0;
/** ...and this far above it (a contact at the layer's own base). */
const ISLAND_WINDOW_ABOVE_MM = 1.0;
/** Plan bucket size for the nearest-tip lookup (mm). */
const TIP_BUCKET_MM = 2.0;
/** Ring cap for the nearest-tip lookup; beyond this the layer is treated as unserved. */
const MAX_BUCKET_RINGS = 512;
/** Contact diameters below this are treated as the smallest printable tip. */
const MIN_CONTACT_DIAMETER_MM = 0.1;

/** Reports carry rounded values: two runs of the same plan (main thread and
 *  worker, or two identical runs) must serialize identically, and the last
 *  bits of a Float32-derived pressure are noise, not physics. */
function roundTo(value: number, decimals: number): number {
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

export interface ForceBudgetTipInput {
    entityId?: string;
    pos: Vec3;
    contactDiameterMm: number;
    /** Narrowest member section on the tip's own entity (mm), when the graph knows one. */
    memberDiameterMm?: number;
}

export interface ForceBudgetInput {
    tips: readonly ForceBudgetTipInput[];
    profile: RepresentativeLayerProfile | undefined;
    /** Down-facing surfaces an added contact may land on. */
    islands: readonly DetectedIsland[];
    /** Support break strength (MPa), already derated from the datasheet. */
    strengthMpa?: number;
    maxLayers?: number;
}

function bucketCell(x: number, y: number): number {
    const cx = Math.floor(x / TIP_BUCKET_MM);
    const cy = Math.floor(y / TIP_BUCKET_MM);
    return (cx + 32768) * 65536 + (cy + 32768);
}

/** Bucketed nearest-tip lookup, exact for ties broken by the lower tip index. */
class TipPlanIndex {
    private readonly buckets = new Map<number, number[]>();
    private readonly tips: readonly ForceBudgetTipInput[];

    constructor(tips: readonly ForceBudgetTipInput[], active: readonly number[]) {
        this.tips = tips;
        for (const index of active) {
            const tip = tips[index];
            const key = bucketCell(tip.pos.x, tip.pos.y);
            const list = this.buckets.get(key);
            if (list) list.push(index);
            else this.buckets.set(key, [index]);
        }
    }

    nearest(x: number, y: number): number {
        let bestD2 = Infinity;
        let bestIndex = -1;
        const cx = Math.floor(x / TIP_BUCKET_MM);
        const cy = Math.floor(y / TIP_BUCKET_MM);
        for (let ring = 0; ring <= MAX_BUCKET_RINGS; ring++) {
            for (let dx = -ring; dx <= ring; dx++) {
                for (let dy = -ring; dy <= ring; dy++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const list = this.buckets.get((cx + dx + 32768) * 65536 + (cy + dy + 32768));
                    if (!list) continue;
                    for (const index of list) {
                        const tip = this.tips[index];
                        const d2 = (tip.pos.x - x) ** 2 + (tip.pos.y - y) ** 2;
                        if (d2 < bestD2 || (d2 === bestD2 && index < bestIndex)) {
                            bestD2 = d2;
                            bestIndex = index;
                        }
                    }
                }
            }
            if (bestIndex >= 0 && bestD2 <= (ring * TIP_BUCKET_MM) ** 2) break;
            if (bestD2 === 0) break;
        }
        return bestIndex;
    }
}

interface IslandSurface {
    island: DetectedIsland;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    /** Highest surface voxel Z (mm). A steep flat spans many mm and its
     *  `baseZ` alone cannot tell whether the face is at a layer. */
    maxZMm: number;
    voxelCount: number;
}

function downFacingSurfaces(islands: readonly DetectedIsland[]): IslandSurface[] {
    const out: IslandSurface[] = [];
    for (const island of islands) {
        if (island.source !== 'overhang' || island.interior) continue;
        const footprint = island.contactVoxels;
        if (!footprint || footprint.count === 0) continue;
        const bounds = footprintBounds(footprint);
        if (!bounds) continue;
        let maxZMm = island.baseZ;
        for (let index = 0; index < footprint.count; index++) {
            const z = footprintZ(footprint, index) ?? island.baseZ;
            if (z > maxZMm) maxZMm = z;
        }
        out.push({ island, ...bounds, maxZMm, voxelCount: footprint.count });
    }
    return out;
}

/** Distance from a plan point to an axis-aligned box, in plan (mm). */
function planDistanceToBox(x: number, y: number, box: IslandSurface): number {
    const dx = x < box.minX ? box.minX - x : x > box.maxX ? x - box.maxX : 0;
    const dy = y < box.minY ? box.minY - y : y > box.maxY ? y - box.maxY : 0;
    return Math.hypot(dx, dy);
}

/**
 * The surfaces an added force-budget contact may land on: the covered
 * formation overhangs plus class-2 force-augmented steep flats. A steep flat
 * forms on its own, so it is never a formation target; it becomes an add
 * target only when an over-budget cell has no closer formation surface. Flats
 * past the side-wall contact bound are dropped because their cone would be
 * refused at placement; interiors are excluded for the same reason.
 */
export function collectForceBudgetSurfaces(
    islands: readonly DetectedIsland[],
    formationIslands: readonly DetectedIsland[],
): DetectedIsland[] {
    const byId = new Map<string, DetectedIsland>();
    for (const island of formationIslands) byId.set(island.id, island);
    for (const island of islands) {
        if (island.source !== 'overhang' || !island.steepFlat || island.interior) continue;
        if ((island.overhangAngleDeg ?? 0) > MAX_SIDE_WALL_CONTACT_LEAN_DEG) continue;
        const footprint = island.contactVoxels;
        if (!footprint || footprint.count === 0) continue;
        byId.set(island.id, island);
    }
    return [...byId.values()];
}

/** Nearest down-facing surface voxel to an over-budget cell's far point, within
 *  the snap radius and the layer's own island window. */
function nearestSurfacePoint(
    surfaces: readonly IslandSurface[],
    targetX: number,
    targetY: number,
    layerZMm: number,
): { island: DetectedIsland; pos: Vec3; snapMm: number } | null {
    let bestD2 = ADD_SNAP_MM * ADD_SNAP_MM;
    let best: { island: DetectedIsland; pos: Vec3 } | null = null;
    for (const surface of surfaces) {
        const island = surface.island;
        if (island.baseZ > layerZMm + ISLAND_WINDOW_ABOVE_MM) continue;
        // A steep flat spans many millimetres in Z; its baseZ can sit far
        // below the layer while the face itself is at the layer. Window on the
        // surface's own Z span, then filter each voxel by Z below.
        if (surface.maxZMm < layerZMm - ISLAND_WINDOW_BELOW_MM) continue;
        if (planDistanceToBox(targetX, targetY, surface) > Math.sqrt(bestD2)) continue;
        const footprint = island.contactVoxels;
        if (!footprint) continue;
        for (let index = 0; index < footprint.count; index++) {
            const vx = footprintX(footprint, index);
            const vy = footprintY(footprint, index);
            const d2 = (vx - targetX) ** 2 + (vy - targetY) ** 2;
            if (d2 > bestD2) continue;
            const vz = footprintZ(footprint, index) ?? island.baseZ;
            if (vz > layerZMm + 0.5) continue;
            if (vz < layerZMm - ISLAND_WINDOW_BELOW_MM) continue;
            bestD2 = d2;
            best = { island, pos: { x: vx, y: vy, z: vz } };
        }
    }
    if (!best) return null;
    return { ...best, snapMm: Math.sqrt(bestD2) };
}

/** Break load of one placed tip: the weaker of its contact and its own shaft. */
function tipCapacityN(tip: ForceBudgetTipInput, strengthMpa: number): number {
    const contactDiameter = Math.max(MIN_CONTACT_DIAMETER_MM, tip.contactDiameterMm);
    const contactArea = Math.PI * 0.25 * contactDiameter * contactDiameter;
    const memberArea = tip.memberDiameterMm !== undefined && tip.memberDiameterMm > 0
        ? Math.PI * 0.25 * tip.memberDiameterMm ** 2
        : Infinity;
    return strengthMpa * Math.min(contactArea, memberArea);
}

/**
 * Evaluate the placed forest against the representative-layer peel field.
 * Rows are ordered worst-utilization first; every over-budget row carries an
 * `addPoint` when a down-facing surface is in reach.
 */
export function computeForceBudget(input: ForceBudgetInput): ForceBudgetReport {
    const tips = input.tips;
    const strengthMpa = Math.max(0.01, input.strengthMpa ?? DEFAULT_SUPPORT_BREAK_STRENGTH_MPA);
    const maxLayers = Math.max(1, input.maxLayers ?? FORCE_BUDGET_MAX_LAYERS);
    const layers = input.profile?.layers ?? [];

    const peakDemandN = new Float64Array(tips.length);
    const tipPeakLayerZMm = new Float64Array(tips.length);
    const peakCellX = new Float64Array(tips.length);
    const peakCellY = new Float64Array(tips.length);
    const peakDistanceMm = new Float64Array(tips.length);

    const layerOrder = layers
        .filter((layer) => layer.stefanField && layer.stefanField.maskAreaMm2 > 0)
        .map((layer) => ({ layer, forceN: computeLayerPeelForceAndCop(layer, layer.areaMm2).forceN }))
        .filter((entry) => entry.forceN > 0)
        .sort((a, b) => b.forceN - a.forceN || a.layer.zMm - b.layer.zMm)
        .slice(0, maxLayers);

    let unattributedN = 0;
    let layersEvaluated = 0;
    const peakLayerZMm = layerOrder.length > 0 ? layerOrder[0].layer.zMm : 0;

    for (const { layer, forceN } of layerOrder) {
        const field = layer.stefanField;
        if (!field) continue;
        const active: number[] = [];
        for (let index = 0; index < tips.length; index++) {
            if (tips[index].pos.z <= layer.zMm + 0.5) active.push(index);
        }
        if (active.length === 0) {
            unattributedN = Math.max(unattributedN, forceN);
            continue;
        }
        let weightSum = 0;
        for (let index = 0; index < field.pressure.length; index++) {
            const pressure = field.pressure[index];
            if (pressure > 0) weightSum += pressure;
        }
        if (!(weightSum > 0)) {
            unattributedN = Math.max(unattributedN, forceN);
            continue;
        }

        layersEvaluated++;
        const shareN = forceN / weightSum;
        const nearest = new TipPlanIndex(tips, active);
        const layerDemandN = new Float64Array(tips.length);
        const layerDistanceMm = new Float64Array(tips.length);
        const layerCellX = new Float64Array(tips.length);
        const layerCellY = new Float64Array(tips.length);
        let cellAreaUnattributedN = 0;

        for (let row = 0; row < field.ny; row++) {
            const y = field.minY + (row + 0.5) * field.cellMm;
            for (let column = 0; column < field.nx; column++) {
                const pressure = field.pressure[row * field.nx + column];
                if (pressure <= 0) continue;
                const x = field.minX + (column + 0.5) * field.cellMm;
                const tipIndex = nearest.nearest(x, y);
                const demandN = pressure * shareN;
                if (tipIndex < 0) {
                    cellAreaUnattributedN += demandN;
                    continue;
                }
                layerDemandN[tipIndex] += demandN;
                const distanceMm = Math.hypot(tips[tipIndex].pos.x - x, tips[tipIndex].pos.y - y);
                if (distanceMm > layerDistanceMm[tipIndex]) {
                    layerDistanceMm[tipIndex] = distanceMm;
                    layerCellX[tipIndex] = x;
                    layerCellY[tipIndex] = y;
                }
            }
        }
        unattributedN = Math.max(unattributedN, cellAreaUnattributedN);

        for (let index = 0; index < tips.length; index++) {
            if (layerDemandN[index] <= peakDemandN[index]) continue;
            peakDemandN[index] = layerDemandN[index];
            tipPeakLayerZMm[index] = layer.zMm;
            peakCellX[index] = layerCellX[index];
            peakCellY[index] = layerCellY[index];
            peakDistanceMm[index] = layerDistanceMm[index];
        }
    }

    const surfaces = downFacingSurfaces(input.islands);
    const rows: ForceBudgetTipRow[] = [];
    let skippedNoSurface = 0;

    for (let index = 0; index < tips.length; index++) {
        const tip = tips[index];
        const capacityN = tipCapacityN(tip, strengthMpa);
        const demandN = peakDemandN[index];
        const deficitN = Math.max(0, demandN - capacityN);
        const utilizationPct = capacityN > 0 ? (100 * demandN) / capacityN : 0;

        let addPoint: ForceBudgetTipRow['addPoint'];
        if (deficitN > 0) {
            const surface = nearestSurfacePoint(surfaces, peakCellX[index], peakCellY[index], tipPeakLayerZMm[index]);
            if (surface) {
                addPoint = {
                    islandId: surface.island.id,
                    steepFlat: Boolean(surface.island.steepFlat),
                    pos: {
                        x: roundTo(surface.pos.x, 4),
                        y: roundTo(surface.pos.y, 4),
                        z: roundTo(surface.pos.z, 4),
                    },
                    normal: {
                        x: roundTo(surface.island.surfaceNormal?.x ?? 0, 4),
                        y: roundTo(surface.island.surfaceNormal?.y ?? 0, 4),
                        z: roundTo(surface.island.surfaceNormal?.z ?? -1, 4),
                    },
                    snapMm: roundTo(surface.snapMm, 3),
                };
            } else {
                skippedNoSurface++;
            }
        }

        rows.push({
            entityId: tip.entityId,
            pos: {
                x: roundTo(tip.pos.x, 4),
                y: roundTo(tip.pos.y, 4),
                z: roundTo(tip.pos.z, 4),
            },
            contactDiameterMm: roundTo(tip.contactDiameterMm, 4),
            memberDiameterMm: tip.memberDiameterMm === undefined ? undefined : roundTo(tip.memberDiameterMm, 4),
            capacityN: roundTo(capacityN, 6),
            demandN: roundTo(demandN, 6),
            utilizationPct: roundTo(utilizationPct, 2),
            deficitN: roundTo(deficitN, 6),
            layerZMm: roundTo(tipPeakLayerZMm[index], 3),
            maxCellDistanceMm: roundTo(peakDistanceMm[index], 3),
            addPoint,
        });
    }

    rows.sort((a, b) =>
        b.utilizationPct - a.utilizationPct
        || b.demandN - a.demandN
        || a.pos.z - b.pos.z
        || a.pos.x - b.pos.x
        || a.pos.y - b.pos.y
        || (a.entityId ?? '').localeCompare(b.entityId ?? ''));

    let totalDemandN = 0;
    let totalCapacityN = 0;
    let overloadedTips = 0;
    for (const row of rows) {
        totalDemandN += row.demandN;
        totalCapacityN += row.capacityN;
        if (row.utilizationPct > 100) overloadedTips++;
    }

    return {
        rows,
        layersEvaluated,
        peakLayerZMm: roundTo(peakLayerZMm, 3),
        totalDemandN: roundTo(totalDemandN, 6),
        totalCapacityN: roundTo(totalCapacityN, 6),
        overloadedTips,
        unattributedN: roundTo(unattributedN, 6),
        skippedNoSurface,
        strengthMpa,
        referencePressureMpa: NOMINAL_PEEL_PRESSURE_MPA,
        worst: rows[0] ?? null,
    };
}

/**
 * The same budget built from a `SupportGraph`: tip nodes supply the contact
 * diameters, and each tip's own entity supplies its narrowest member section.
 * Shared host shafts are deliberately not charged here — the frame solve owns
 * the load path through them.
 */
export function computeForceBudgetFromGraph(
    graph: SupportGraph,
    profile: RepresentativeLayerProfile | undefined,
    islands: readonly DetectedIsland[],
    strengthMpa: number = DEFAULT_SUPPORT_BREAK_STRENGTH_MPA,
    maxLayers?: number,
): ForceBudgetReport {
    const narrowestByEntity = new Map<string, number>();
    for (const member of graph.members) {
        const previous = narrowestByEntity.get(member.entityId);
        if (previous === undefined || member.diameterMm < previous) {
            narrowestByEntity.set(member.entityId, member.diameterMm);
        }
    }
    const tips: ForceBudgetTipInput[] = [];
    for (const node of graph.nodes) {
        if (node.kind !== 'tip' || !node.entityId) continue;
        tips.push({
            entityId: node.entityId,
            pos: node.pos,
            contactDiameterMm: node.tipContactDiameterMm ?? 0.28,
            memberDiameterMm: narrowestByEntity.get(node.entityId),
        });
    }
    return computeForceBudget({ tips, profile, islands, strengthMpa, maxLayers });
}
