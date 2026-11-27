import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import type { SupportState, Vec3 } from '../types';
import type {
    AngularDeviationSummary,
    DiskThicknessDistribution,
    LeafCapRegimeSummary,
    LeafCapSplitMetrics,
    NormalSynthesisMetrics,
    NormalSynthesisSupportKind,
    PlacementNormalSynthesisMode,
    SurfaceLeanBuckets,
} from './types';

interface ConeCapAnchorLike {
    nMean: Vec3;
    baseNormal: Vec3;
    thetaSpreadRad: number;
    thetaCapRad: number;
    isConcave: boolean;
}

interface CapRegimeAccumulator {
    count: number;
    flushCount: number;
    angleDrivenCount: number;
    collisionDrivenCount: number;
    capReachableCount: number;
    orbitedCount: number;
    concaveCount: number;
    orbitShiftSumDeg: number;
    maxOrbitShiftDeg: number;
}

interface ClassifiedDiskCone {
    sn: Vec3;
    cn: Vec3;
    effective: number;
    isCollisionDriven: boolean;
    isAngleDriven: boolean;
}

export interface ComputeNormalSynthesisMetricsOptions {
    mode?: PlacementNormalSynthesisMode;
    leafCapOrbit?: boolean;
    edgeSafeguards?: boolean;
    concaveFloorCount?: number;
    consolidationLeafIds?: ReadonlySet<string>;
    consolidationCandidates?: number;
    consolidationConvertedLeaves?: number;
    consolidationConvertedBranches?: number;
    consolidationBlockedCount?: number;
}

interface ThicknessAccumulator {
    values: number[];
    sum: number;
    flushCount: number;
    angleDrivenCount: number;
    collisionDrivenCount: number;
    extendedOver025Count: number;
    maxClamped035Count: number;
}

const SUPPORT_KINDS: readonly NormalSynthesisSupportKind[] = [
    'trunk',
    'branch',
    'leaf',
    'consolidationLeaf',
    'stump',
    'stick',
];

function createAccumulator(): ThicknessAccumulator {
    return {
        values: [],
        sum: 0,
        flushCount: 0,
        angleDrivenCount: 0,
        collisionDrivenCount: 0,
        extendedOver025Count: 0,
        maxClamped035Count: 0,
    };
}

function round6(value: number): number {
    const rounded = Math.round(value * 1e6) / 1e6;
    return Object.is(rounded, -0) ? 0 : rounded;
}

/** Type-7 (R-7) linear-interpolated quantile over a pre-sorted ascending array. */
function quantileR7(sorted: readonly number[], p: number): number {
    const n = sorted.length;
    if (n === 0) return 0;
    const h = (n - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function finalizeDistribution(acc: ThicknessAccumulator): DiskThicknessDistribution {
    const count = acc.values.length;
    if (count === 0) {
        return {
            count: 0,
            minMm: 0,
            p50Mm: 0,
            p90Mm: 0,
            p99Mm: 0,
            maxMm: 0,
            meanMm: 0,
            flushCount: 0,
            angleDrivenCount: 0,
            collisionDrivenCount: 0,
            extendedOver025Count: 0,
            maxClamped035Count: 0,
        };
    }
    const sorted = [...acc.values].sort((a, b) => a - b);
    return {
        count,
        minMm: round6(sorted[0]),
        p50Mm: round6(quantileR7(sorted, 0.5)),
        p90Mm: round6(quantileR7(sorted, 0.9)),
        p99Mm: round6(quantileR7(sorted, 0.99)),
        maxMm: round6(sorted[count - 1]),
        meanMm: round6(acc.sum / count),
        flushCount: acc.flushCount,
        angleDrivenCount: acc.angleDrivenCount,
        collisionDrivenCount: acc.collisionDrivenCount,
        extendedOver025Count: acc.extendedOver025Count,
        maxClamped035Count: acc.maxClamped035Count,
    };
}

function finalizeDeviationSummary(values: readonly number[], sum: number): AngularDeviationSummary {
    const count = values.length;
    if (count === 0) {
        return { count: 0, p50Deg: 0, p90Deg: 0, p99Deg: 0, maxDeg: 0, meanDeg: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count,
        p50Deg: round6(quantileR7(sorted, 0.5)),
        p90Deg: round6(quantileR7(sorted, 0.9)),
        p99Deg: round6(quantileR7(sorted, 0.99)),
        maxDeg: round6(sorted[count - 1]),
        meanDeg: round6(sum / count),
    };
}

function angleBetweenDeg(a: Vec3, b: Vec3): number {
    const lenA = Math.hypot(a.x, a.y, a.z);
    const lenB = Math.hypot(b.x, b.y, b.z);
    if (lenA <= 1e-12 || lenB <= 1e-12) return 0;
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (lenA * lenB);
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

function leanFromDownDeg(sn: Vec3): number {
    const len = Math.hypot(sn.x, sn.y, sn.z);
    if (len <= 1e-12) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, -(sn.z / len)))) * 180) / Math.PI;
}

function createCapRegimeAccumulator(): CapRegimeAccumulator {
    return {
        count: 0,
        flushCount: 0,
        angleDrivenCount: 0,
        collisionDrivenCount: 0,
        capReachableCount: 0,
        orbitedCount: 0,
        concaveCount: 0,
        orbitShiftSumDeg: 0,
        maxOrbitShiftDeg: 0,
    };
}

function finalizeCapRegime(acc: CapRegimeAccumulator): LeafCapRegimeSummary {
    return {
        count: acc.count,
        flushCount: acc.flushCount,
        angleDrivenCount: acc.angleDrivenCount,
        collisionDrivenCount: acc.collisionDrivenCount,
        capReachableCount: acc.capReachableCount,
        orbitedCount: acc.orbitedCount,
        concaveCount: acc.concaveCount,
        meanOrbitShiftDeg: acc.count > 0 ? round6(acc.orbitShiftSumDeg / acc.count) : 0,
        maxOrbitShiftDeg: round6(acc.maxOrbitShiftDeg),
    };
}

function classifyDiskCone(cone: ContactCone): ClassifiedDiskCone | null {
    if (cone.profile?.type !== 'disk') return null;
    const sn = cone.surfaceNormal ?? cone.normal;
    const cn = cone.normal;
    const minThickness = calculateDiskThickness(sn, sn, cone.profile);
    const angleThickness = calculateDiskThickness(sn, cn, cone.profile);
    const effective = cone.diskLengthOverride ?? angleThickness;
    const isCollisionDriven =
        cone.diskLengthOverride !== undefined && cone.diskLengthOverride > angleThickness + 1e-5;
    const isAngleDriven = !isCollisionDriven && angleThickness > minThickness + 1e-5;
    return { sn, cn, effective, isCollisionDriven, isAngleDriven };
}

/**
 * Compute pre-constraint normal-synthesis and disk-thickness telemetry (H1-H4)
 * strictly for entities belonging to `modelId` (excluding disk-only twigs).
 */
export function computeNormalSynthesisMetrics(
    draft: SupportState,
    modelId: string,
    options?: ComputeNormalSynthesisMetricsOptions,
): NormalSynthesisMetrics {
    const overallAcc = createAccumulator();
    const byKindAcc: Record<NormalSynthesisSupportKind, ThicknessAccumulator> = {
        trunk: createAccumulator(),
        branch: createAccumulator(),
        leaf: createAccumulator(),
        consolidationLeaf: createAccumulator(),
        stump: createAccumulator(),
        stick: createAccumulator(),
    };
    const deviations: number[] = [];
    let deviationSum = 0;
    const leanBuckets: SurfaceLeanBuckets = {
        downward0To30Count: 0,
        oblique30To60Count: 0,
        steep60To90Count: 0,
        upwardOver90Count: 0,
    };
    const flatOrSmoothAcc = createCapRegimeAccumulator();
    const ridgeOrCornerAcc = createCapRegimeAccumulator();
    let hasLeafCapAnchor = false;
    let thinWallClampedCount = 0;
    let autoConcaveFloor = 0;

    const recordCone = (cone: ContactCone | undefined, kind: NormalSynthesisSupportKind): ClassifiedDiskCone | null => {
        if (!cone) return null;
        const classified = classifyDiskCone(cone);
        if (!classified) return null;
        const { sn, cn, effective, isCollisionDriven, isAngleDriven } = classified;
        if (typeof cone.profile?.maxSafePenetrationMm === 'number') {
            thinWallClampedCount++;
        }
        const capAnchor = (cone as { capAnchor?: ConeCapAnchorLike }).capAnchor;
        if (capAnchor?.isConcave) {
            const thetaSpreadDeg = (capAnchor.thetaSpreadRad * 180) / Math.PI;
            if (thetaSpreadDeg >= 15 - 1e-9) {
                const rContact = Math.max(0.001, (cone.profile.contactDiameterMm ?? 0) / 2);
                const floor = Math.min(0.35, rContact / Math.max(0.5, Math.cos(capAnchor.thetaSpreadRad)));
                if (effective >= floor - 1e-5) {
                    autoConcaveFloor++;
                }
            }
        }
        const isOver025 = effective > 0.25 + 1e-6;
        const isClamped035 = effective >= 0.35 - 1e-4;

        for (const acc of [overallAcc, byKindAcc[kind]]) {
            acc.values.push(effective);
            acc.sum += effective;
            if (isCollisionDriven) acc.collisionDrivenCount++;
            else if (isAngleDriven) acc.angleDrivenCount++;
            else acc.flushCount++;
            if (isOver025) acc.extendedOver025Count++;
            if (isClamped035) acc.maxClamped035Count++;
        }

        const deviation = angleBetweenDeg(sn, cn);
        deviations.push(deviation);
        deviationSum += deviation;

        const lean = leanFromDownDeg(sn);
        if (lean < 30) leanBuckets.downward0To30Count++;
        else if (lean < 60) leanBuckets.oblique30To60Count++;
        else if (lean <= 90) leanBuckets.steep60To90Count++;
        else leanBuckets.upwardOver90Count++;

        return classified;
    };

    const recordLeafCap = (cone: ContactCone | undefined, classified: ClassifiedDiskCone | null): void => {
        const capAnchor = (cone as { capAnchor?: ConeCapAnchorLike } | undefined)?.capAnchor;
        if (capAnchor !== undefined) hasLeafCapAnchor = true;
        if (!classified) return;
        const { sn, cn, isCollisionDriven, isAngleDriven } = classified;
        const thetaSpreadDeg = capAnchor ? (capAnchor.thetaSpreadRad * 180) / Math.PI : 0;
        const acc = thetaSpreadDeg >= 15 - 1e-9 ? ridgeOrCornerAcc : flatOrSmoothAcc;
        acc.count++;
        if (isCollisionDriven) acc.collisionDrivenCount++;
        else if (isAngleDriven) acc.angleDrivenCount++;
        else acc.flushCount++;

        if (capAnchor) {
            if (capAnchor.isConcave) acc.concaveCount++;
            const orbitShiftDeg = angleBetweenDeg(capAnchor.baseNormal, sn);
            if (orbitShiftDeg > 0.5) acc.orbitedCount++;
            acc.orbitShiftSumDeg += orbitShiftDeg;
            if (orbitShiftDeg > acc.maxOrbitShiftDeg) acc.maxOrbitShiftDeg = orbitShiftDeg;
            const maxCapAngleDeg = 45 + (capAnchor.thetaCapRad * 180) / Math.PI + 1e-6;
            if (angleBetweenDeg(capAnchor.nMean, cn) <= maxCapAngleDeg) {
                acc.capReachableCount++;
            }
        }
    };

    for (const trunk of Object.values(draft.trunks ?? {})) {
        if (trunk.modelId === modelId) recordCone(trunk.contactCone, 'trunk');
    }
    for (const branch of Object.values(draft.branches ?? {})) {
        if (branch.modelId === modelId) recordCone(branch.contactCone, 'branch');
    }
    for (const leaf of Object.values(draft.leaves ?? {})) {
        if (leaf.modelId === modelId) {
            const kind: NormalSynthesisSupportKind = options?.consolidationLeafIds?.has(leaf.id)
                ? 'consolidationLeaf'
                : 'leaf';
            const classified = recordCone(leaf.contactCone, kind);
            recordLeafCap(leaf.contactCone, classified);
        }
    }
    for (const stump of Object.values(draft.stumps ?? {})) {
        if (stump.modelId === modelId) recordCone(stump.contactCone, 'stump');
    }
    for (const stick of Object.values(draft.sticks ?? {})) {
        if (stick.modelId === modelId) {
            recordCone(stick.contactConeA, 'stick');
            recordCone(stick.contactConeB, 'stick');
        }
    }

    const byKind = Object.fromEntries(
        SUPPORT_KINDS.map((kind) => [kind, finalizeDistribution(byKindAcc[kind])]),
    ) as Record<NormalSynthesisSupportKind, DiskThicknessDistribution>;

    const shouldIncludeCapSplit = options?.leafCapOrbit === true || hasLeafCapAnchor;
    const capSplit: LeafCapSplitMetrics = {
        flatOrSmooth: finalizeCapRegime(flatOrSmoothAcc),
        ridgeOrCorner: finalizeCapRegime(ridgeOrCornerAcc),
    };

    return {
        mode: options?.mode ?? 'raw',
        leafCapOrbit: options?.leafCapOrbit ?? false,
        overall: finalizeDistribution(overallAcc),
        byKind,
        coneDeviationFromSurfaceDeg: finalizeDeviationSummary(deviations, deviationSum),
        surfaceLeanFromDownDeg: leanBuckets,
        consolidationCandidates: options?.consolidationCandidates ?? 0,
        consolidationConvertedLeaves: options?.consolidationConvertedLeaves ?? 0,
        consolidationConvertedBranches: options?.consolidationConvertedBranches ?? 0,
        consolidationBlockedCount: options?.consolidationBlockedCount ?? 0,
        ...(shouldIncludeCapSplit ? { capSplit } : {}),
        ...(options?.edgeSafeguards === true
            ? {
                thinWallClampedCount,
                concaveFloorCount: options.concaveFloorCount ?? autoConcaveFloor,
            }
            : {}),
    };
}
