/**
 * The load budget: how much surface each island's contacts are responsible for,
 * against what they can carry, as a report only.
 *
 * Why it exists. Today the plan decides how many supports exist by area (the
 * density knob modulates spacing), then chases an area-coverage target, then
 * dedupes and consolidates. None of those steps can say *which* region is short
 * and which has capacity to spare, so a change to density is a global bet. A
 * deficit budget is the field's answer (PrusaSlicer's SLA generator allocates
 * contacts from a per-island force deficit inherited down an island graph), and
 * this module computes that deficit for us **without changing any placement**:
 * the run reports what a budget would add and what it would cull, and nothing
 * moves until those numbers have been read.
 *
 * Units are mm² of unsupported surface, on both sides of the subtraction:
 *
 * - **Demand** is the island's own footprint area, plus a share of the demand of
 *   the islands it sits under (the load path: what hangs above it), plus, when
 *   the pose needs topple coverage, a share of the forest's demand proportional
 *   to the drag moment the patch carries.
 * - **Capacity** credits each placed support with the area the run's own density
 *   knob already assigns one support (`areaPerSupportMm2`), scaled by its band's
 *   cross-section relative to the structure band. So a region the current density
 *   serves evenly reads near zero, and a deficit reads as "this many mm² of this
 *   region are carried by nothing".
 *
 * That choice of unit is deliberate: it makes the model comparable to the density
 * we ship today, so the first reading of it is a measurement of our own model
 * rather than of PrusaSlicer's arbitrary constants. A calibrated capacity (a
 * printed matrix: what a 0.22 mm tip and a 1 mm shaft actually hold) replaces the
 * knob later, and only then does the budget become a count we can defend rather
 * than a redistribution of the supports we already place.
 *
 * What it is not: a simulation. No peel force, no weight of print, no FEA. The
 * demand is a share of a quantity the plan already computes, and the capacity is
 * a knob, which is why this reports instead of placing.
 */

import { footprintX, footprintY } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import type { Vec3 } from '../types';
import { resolveSizingBand } from './parameterSizing';
import type { SizingPreset } from './settings';
import type { LoadBudgetIsland, LoadBudgetReport } from './types';

/** Footprint cells are the detector's own 0.25 mm grid, as `voxelFootprint` defines it. */
const FOOTPRINT_CELL_MM = 0.25;
/** Rise above another island below which two islands are treated as one level. */
const LEVEL_EPSILON_MM = 0.05;
/** Within this plan distance of a footprint, a contact counts as serving it. */
const CONTACT_ASSIGNMENT_MM = 1;

export interface PlacedContact {
    tip: Vec3;
    /** The tier the support's island falls in, for capacity. */
    preset: SizingPreset;
}

export interface LoadBudgetInput {
    islands: DetectedIsland[];
    contacts: PlacedContact[];
    /** From the settings the run used: the area one support is expected to cover. */
    areaPerSupportMm2: number;
    /** The pose's total drag moment (mm³), when the scan reported one. */
    poseDragMomentMm3?: number;
    /** Whether the pose's verdict asked for anti-topple coverage at all. */
    toppleCoverageNeeded: boolean;
}

/** Index of the footprint cells one island occupies, or null when it carries none. */
function footprintCells(island: DetectedIsland): Set<number> | null {
    const footprint = island.contactVoxels;
    if (!footprint || footprint.count === 0) return null;
    const cells = new Set<number>();
    for (let i = 0; i < footprint.count; i++) {
        const cx = Math.round(footprintX(footprint, i) / FOOTPRINT_CELL_MM);
        const cy = Math.round(footprintY(footprint, i) / FOOTPRINT_CELL_MM);
        cells.add((cx + 32768) * 65536 + (cy + 32768));
    }
    return cells;
}

function cellOf(x: number, y: number): number {
    return (Math.round(x / FOOTPRINT_CELL_MM) + 32768) * 65536 + (Math.round(y / FOOTPRINT_CELL_MM) + 32768);
}

/** How many of `cells` fall inside `other`, as a fraction of `cells`. */
function overlapFraction(cells: Set<number>, other: Set<number>): number {
    if (cells.size === 0) return 0;
    let shared = 0;
    for (const cell of cells) if (other.has(cell)) shared++;
    return shared / cells.size;
}

/** A support's capacity: the area one support is expected to cover, credited by
 *  the cross-section of the tier its island falls in. This is a RELATIVE weight
 *  for the report, not the band the run sized with — that one is resolved from
 *  the Support Studio preset the settings name, the same for every support of a
 *  run. Both bands resolve through the same path, so an edited manual preset
 *  moves the weighting with the sizing. */
function capacityFor(tier: SizingPreset, areaPerSupportMm2: number): number {
    const baseline = resolveSizingBand('structure').shaftDiameterMm;
    const band = resolveSizingBand(tier).shaftDiameterMm;
    return areaPerSupportMm2 * (band / baseline) ** 2;
}

/**
 * Areas and the load path are stated per island, and every island keeps its own
 * row even when it ends up balanced: the report's value is in which regions sit
 * at the edges, not in the forest total.
 */
export function computeLoadBudget(input: LoadBudgetInput): LoadBudgetReport {
    const { islands, contacts, areaPerSupportMm2, poseDragMomentMm3, toppleCoverageNeeded } = input;

    const withArea = islands.filter((island) => (island.areaMm2 ?? 0) > 0);
    const islandsWithoutArea = islands.length - withArea.length;
    const forestDemandMm2 = withArea.reduce((sum, island) => sum + (island.areaMm2 ?? 0), 0);

    // Demand, top down: an island's own area plus the share of what sits above it
    // that lands on its footprint. Height-descending order makes this one pass,
    // since nothing can be charged by something lower than itself.
    const demandById = new Map<string, number>();
    for (const island of withArea) demandById.set(island.id, island.areaMm2 ?? 0);

    const cellsById = new Map<string, Set<number> | null>();
    for (const island of withArea) cellsById.set(island.id, footprintCells(island));
    const withCells = withArea.filter((island) => cellsById.get(island.id) !== null);
    const descending = [...withCells].sort((a, b) => b.baseZ - a.baseZ);
    for (const upper of descending) {
        if (upper.baseZ <= LEVEL_EPSILON_MM) continue;
        const upperCells = cellsById.get(upper.id)!;
        const carried = demandById.get(upper.id) ?? 0;
        for (const lower of withCells) {
            if (lower.id === upper.id) continue;
            if (lower.baseZ >= upper.baseZ - LEVEL_EPSILON_MM) continue;
            const fraction = overlapFraction(upperCells, cellsById.get(lower.id)!);
            if (fraction <= 0) continue;
            demandById.set(lower.id, (demandById.get(lower.id) ?? 0) + carried * fraction);
        }
    }

    // Topple channel: a patch that carries drag is charged a share of the forest's
    // demand, and only when the pose's verdict asked for coverage at all.
    if (toppleCoverageNeeded && poseDragMomentMm3 && poseDragMomentMm3 > 0) {
        for (const island of withArea) {
            const drag = island.dragMomentMm3 ?? 0;
            if (drag <= 0) continue;
            const share = Math.min(1, drag / poseDragMomentMm3);
            demandById.set(island.id, (demandById.get(island.id) ?? 0) + forestDemandMm2 * share);
        }
    }

    // Capacity: each placed contact is credited to the island whose footprint it
    // landed on (rarely, to the nearest one within a contact radius).
    const capacityById = new Map<string, number>(withArea.map((island) => [island.id, 0]));
    for (const contact of contacts) {
        const cell = cellOf(contact.tip.x, contact.tip.y);
        let owner: DetectedIsland | null = null;
        let bestScoreMm = Infinity;
        for (const island of withArea) {
            const cells = cellsById.get(island.id);
            if (!cells) continue;
            const distanceMm = cells.has(cell) ? 0 : nearestCellDistanceMm(cells, cell);
            if (distanceMm > CONTACT_ASSIGNMENT_MM) continue;
            // A contact belongs to the surface it landed on, not to the platform
            // under it: plan distance decides, and the island whose own height
            // matches the tip decides the tie.
            const heightMm = Math.abs(island.baseZ - contact.tip.z);
            const score = distanceMm + heightMm;
            if (score < bestScoreMm) {
                bestScoreMm = score;
                owner = island;
            }
        }
        if (!owner) continue;
        capacityById.set(owner.id, (capacityById.get(owner.id) ?? 0) + capacityFor(contact.preset, areaPerSupportMm2));
    }

    const structureCapacity = capacityFor('structure', areaPerSupportMm2);
    const rows: LoadBudgetIsland[] = withArea.map((island) => {
        const demandMm2 = demandById.get(island.id) ?? 0;
        const capacityMm2 = capacityById.get(island.id) ?? 0;
        return { islandId: island.id, demandMm2, capacityMm2, deficitMm2: demandMm2 - capacityMm2 };
    });

    const inDeficit = rows.filter((row) => row.deficitMm2 > structureCapacity * 0.5);
    const inSurplus = rows.filter((row) => row.deficitMm2 < -structureCapacity * 0.5);
    const worst = inDeficit.reduce<LoadBudgetIsland | null>(
        (current, row) => (current === null || row.deficitMm2 > current.deficitMm2 ? row : current),
        null,
    );

    return {
        rows,
        totalDemandMm2: rows.reduce((sum, row) => sum + row.demandMm2, 0),
        totalCapacityMm2: rows.reduce((sum, row) => sum + row.capacityMm2, 0),
        wouldAdd: inDeficit.reduce((sum, row) => sum + Math.ceil(row.deficitMm2 / structureCapacity), 0),
        wouldCull: inSurplus.reduce((sum, row) => sum + Math.floor(-row.deficitMm2 / structureCapacity), 0),
        islandsInDeficit: inDeficit.length,
        islandsInSurplus: inSurplus.length,
        islandsWithoutArea,
        worst,
    };
}

/** Chebyshev distance in mm from a cell to the nearest cell of a set, capped early. */
function nearestCellDistanceMm(cells: Set<number>, cell: number): number {
    const x = Math.floor(cell / 65536) - 32768;
    const y = (cell % 65536) - 32768;
    let best = Infinity;
    for (const other of cells) {
        const ox = Math.floor(other / 65536) - 32768;
        const oy = (other % 65536) - 32768;
        const distance = Math.max(Math.abs(ox - x), Math.abs(oy - y)) * FOOTPRINT_CELL_MM;
        if (distance < best) best = distance;
        if (best === 0) break;
    }
    return best;
}
