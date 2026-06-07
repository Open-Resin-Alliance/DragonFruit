type GridSettings = { enabled: boolean; spacingMm: number };

export type TrunkCoverageProbe = {
    trunkId: string;
    modelId: string;
    rootX: number;
    rootY: number;
    topZ: number;
};

export type HeightCoverageAnalysis = {
    hasReachableNeighbor: boolean;
    hasTopCoverageGap: boolean;
    bestReachableAnchorZ: number | null;
    requiredAnchorZ: number;
};

const EPS = 0.000001;
const TOP_COVERAGE_MARGIN_MIN_MM = 6;
const ANCHOR_SAFETY_MARGIN_MM = 0.1;

function isCardinalDelta(dx: number, dy: number, spacingMm: number): boolean {
    const axisToleranceMm = Math.max(0.1, spacingMm * 0.05);
    return Math.abs(dx) <= axisToleranceMm || Math.abs(dy) <= axisToleranceMm;
}

export function analyzeTrunkHeightCoverage(
    trunk: TrunkCoverageProbe,
    neighbors: TrunkCoverageProbe[],
    options: {
        maxBraceLengthMm: number;
        patternIntervalMm: number;
        grid: GridSettings;
    },
): HeightCoverageAnalysis {
    const maxHorizontalRun = options.maxBraceLengthMm;
    const requiredTopCoverageBandMm = Math.max(options.patternIntervalMm, TOP_COVERAGE_MARGIN_MIN_MM);
    const requiredAnchorZ = trunk.topZ - requiredTopCoverageBandMm;

    let hasReachableNeighbor = false;
    let bestReachableAnchorZ: number | null = null;

    for (const neighbor of neighbors) {
        if (neighbor.modelId !== trunk.modelId || neighbor.trunkId === trunk.trunkId) continue;

        const dx = neighbor.rootX - trunk.rootX;
        const dy = neighbor.rootY - trunk.rootY;

        if (options.grid.enabled && options.grid.spacingMm > 0) {
            if (!isCardinalDelta(dx, dy, options.grid.spacingMm)) {
                continue;
            }
        }

        const hDist = Math.sqrt(dx * dx + dy * dy);
        if (hDist > maxHorizontalRun + EPS) continue;

        hasReachableNeighbor = true;

        const maxAnchorZFromNeighbor = Math.min(trunk.topZ, neighbor.topZ) - hDist - ANCHOR_SAFETY_MARGIN_MM;
        if (bestReachableAnchorZ === null || maxAnchorZFromNeighbor > bestReachableAnchorZ) {
            bestReachableAnchorZ = maxAnchorZFromNeighbor;
        }
    }

    const hasTopCoverageGap = !hasReachableNeighbor || bestReachableAnchorZ === null || bestReachableAnchorZ < requiredAnchorZ;

    return {
        hasReachableNeighbor,
        hasTopCoverageGap,
        bestReachableAnchorZ,
        requiredAnchorZ,
    };
}
