/**
 * Topple risk from the solved demand side.
 *
 * The pose report (`poseStability.ts` / the Rust `StabilityReport`) answers the
 * topple question geometrically: a drag moment summed from face areas at a
 * nominal peel pressure, against gravity's lever. The solved Screened Stefan
 * field replaces that nominal moment with the actual one — per sampled layer,
 * its peel force at its own centre of pressure — measured about the pose's
 * worst bearing edge, and the plate pressure the pose would need to lift.
 *
 * The output is a pressure, not a verdict, and deliberately so: plate adhesion
 * `σ` is a material constant that is not calibrated yet. `requiredAdhesionMpa`
 * is directly comparable to the 10–50 kPa peel band and to a measured pull-off,
 * so the number means something before `σ` exists.
 *
 * `complianceMm` is the frame solve's max tip deflection under the same peel:
 * a pose that rocks more than `ROCKING_THRESHOLD_MM` fails dimensionally even
 * when the contact never lifts.
 */

import { computeLayerPeelForceAndCop, computePeelLayerSamples } from './supportGraphStress';
import type { RepresentativeLayerProfile, RepresentativeLayer } from './tractionOptimization';

/** A tip displacement above this reads as rocking / layer-line shift. */
export const ROCKING_THRESHOLD_MM = 0.15;
/** Conservative plate adhesion ceiling (MPa = 300 kPa; NOMINAL_PEEL_PRESSURE_MPA / CONSERVATIVE_P_SIGMA). */
export const TOPPLE_ADHESION_THRESHOLD_MPA = 0.3;

export interface ToppleEdge {
    /** A point on the bearing edge line, world XY (mm). */
    point: { x: number; y: number };
    /** Outward unit normal of that edge, world XY. */
    normal: { x: number; y: number };
}

export interface ToppleRiskInput {
    profile?: RepresentativeLayerProfile;
    /** World-space centre of mass (XY is all the edge test needs). */
    centroid: { x: number; y: number };
    edge: ToppleEdge;
    /** XY area of the bearing patch (mm²). */
    bearingAreaMm2: number;
    /** How far the bearing patch's own centroid sits inside the edge (mm). */
    contactDepthMm: number;
    /** Frame rocking: the differential (max−min) contact displacement along the
     *  drag direction under the same peel (mm), from `SupportFrameStressReport.maxTipRockingMm`. */
    frameRockingMm?: number;
}

export type ToppleOutcome = 'pastEdge' | 'rocking' | 'adhesionBound';

export interface ToppleRiskReport {
    /** How far the centre of mass sits inside the edge (mm); negative = past it. */
    comDepthMm: number;
    /** Solved Stefan peel moment about the edge (N·mm). */
    peelMomentNmm: number;
    /** Peel force of the single layer that governs `peelMomentNmm` (N). Layers
     *  peel one at a time, so the moment is the worst layer's, not a sum. */
    peakLayerForceN: number;
    /** Plate pressure that would lift the contact patch (MPa). */
    requiredAdhesionMpa: number;
    /** Rocking displacement (mm): the frame's contact differential, not a single
     *  tip's elastic sag; 0 when no frame was solved. */
    complianceMm: number;
    outcome: ToppleOutcome;
}

/** The verdict from the two margins: COM depth and frame compliance. Exported
 *  so the panel can re-classify with a fresher deflection after support edits. */
export function classifyToppleRisk(comDepthMm: number, complianceMm: number): ToppleOutcome {
    if (comDepthMm <= 0) return 'pastEdge';
    if (complianceMm > ROCKING_THRESHOLD_MM) return 'rocking';
    return 'adhesionBound';
}

/** True when solved Stefan topple risk indicates the pose needs anti-topple support coverage. */
export function toppleRiskNeedsCoverage(report: ToppleRiskReport): boolean {
    return report.outcome !== 'adhesionBound' || report.requiredAdhesionMpa >= TOPPLE_ADHESION_THRESHOLD_MPA;
}

/** Inward depth of a plan point from the edge line; negative = outside. */
function edgeDepth(point: { x: number; y: number }, edge: ToppleEdge): number {
    return (edge.point.x - point.x) * edge.normal.x + (edge.point.y - point.y) * edge.normal.y;
}

/**
 * Evaluate topple risk for one pose from the solved peel field. Call after a
 * frame solve (for `complianceMm`) and with the pose's worst edge.
 */
export function evaluateToppleRisk(input: ToppleRiskInput): ToppleRiskReport {
    const { profile, edge } = input;
    const comDepthMm = edgeDepth(input.centroid, edge);

    const fallbackAreaMm2 = Math.max(1, profile?.peakAreaMm2 ?? input.bearingAreaMm2);
    const samples = profile?.samples
        ?? profile?.layers.map((layer) => ({ zMm: layer.zMm, areaMm2: layer.areaMm2 }))
        ?? [];
    const sampled = profile ? computePeelLayerSamples(samples, profile.layers, fallbackAreaMm2) : [];

    // Centres of pressure exist only on the solved representative layers; the
    // layers between them take the nearest anchor's CoP, so the force curve and
    // the lever stay in step instead of falling back to one global lever.
    const anchors = (profile?.layers ?? [])
        .filter((layer): layer is RepresentativeLayer & { stefanField: NonNullable<RepresentativeLayer['stefanField']> } =>
            Boolean(layer.stefanField))
        .map((layer) => {
            const cop = computeLayerPeelForceAndCop(layer, fallbackAreaMm2);
            return { zMm: layer.zMm, copX: cop.copX, copY: cop.copY };
        })
        .sort((a, b) => a.zMm - b.zMm);

    let peelMomentNmm = 0;
    let peakLayerForceN = 0;
    for (const sample of sampled) {
        let anchor = anchors[0];
        for (const candidate of anchors) {
            if (Math.abs(candidate.zMm - sample.zMm) <= Math.abs(anchor.zMm - sample.zMm)) anchor = candidate;
        }
        // No solved field: the whole demand behaves as one load at the bearing
        // patch's centroid, which is exactly the geometric ratio's lever.
        const leverMm = anchor
            ? Math.abs(edgeDepth({ x: anchor.copX, y: anchor.copY }, edge))
            : Math.max(0.01, input.contactDepthMm);
        const layerMomentNmm = sample.forceN * leverMm;
        if (layerMomentNmm > peelMomentNmm || (layerMomentNmm === peelMomentNmm && sample.forceN > peakLayerForceN)) {
            peelMomentNmm = layerMomentNmm;
            peakLayerForceN = sample.forceN;
        }
    }

    const momentLeverMm = Math.max(0.01, input.contactDepthMm);
    const requiredAdhesionMpa = input.bearingAreaMm2 > 0
        ? peelMomentNmm / (input.bearingAreaMm2 * momentLeverMm)
        : (peelMomentNmm > 0 ? Infinity : 0);

    const complianceMm = input.frameRockingMm ?? 0;
    const outcome = classifyToppleRisk(comDepthMm, complianceMm);

    return {
        comDepthMm,
        peelMomentNmm,
        peakLayerForceN,
        requiredAdhesionMpa,
        complianceMm,
        outcome,
    };
}
