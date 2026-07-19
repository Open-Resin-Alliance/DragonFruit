import type { CandidatePoint, SupportPlan } from './types';
import type { AutoSupportSettings } from './settings';
import { AUTO_SUPPORT_HARD_RULES } from './settings';

/**
 * Plan a support tree from candidates.
 * Separates anchors (< 5mm Z), clusters remaining by spatial proximity,
 * selects core trunks, and fans out satellites as branches/leaves.
 */
export function planSupportTree(
    candidates: CandidatePoint[],
    settings: AutoSupportSettings,
): SupportPlan {
    const plan: SupportPlan = {
        trunks: [],
        anchors: [],
        branches: [],
        leaves: [],
        rejectedCandidates: [],
    };

    if (candidates.length === 0) return plan;

    // Separate anchors (near-plate tips get minimal anchor supports)
    const threshold = AUTO_SUPPORT_HARD_RULES.ANCHOR_HEIGHT_THRESHOLD_MM;
    const nonAnchors: CandidatePoint[] = [];
    for (const c of candidates) {
        if (c.zHeight < threshold) {
            plan.anchors.push({ candidate: c });
        } else {
            nonAnchors.push(c);
        }
    }

    if (nonAnchors.length === 0) return plan;

    // Cluster remaining candidates
    const clusters = clusterCandidates(nonAnchors, settings.clusterRadiusMm);

    for (const cluster of clusters) {
        if (cluster.length === 1) {
            // Solo candidate → standalone trunk
            plan.trunks.push({ candidate: cluster[0] });
            continue;
        }

        // Multi-candidate cluster — try tree fan-out
        if (cluster.length < AUTO_SUPPORT_HARD_RULES.MIN_GROUP_SIZE) {
            // Too small for tree — individual trunks
            for (const c of cluster) {
                plan.trunks.push({ candidate: c });
            }
            continue;
        }

        const core = selectCoreCandidate(cluster);
        const satellites = cluster.filter(c => c.id !== core.id);

        // Sort satellites by distance from core
        satellites.sort(
            (a, b) => computeCandidateDistance(core, a) - computeCandidateDistance(core, b),
        );

        // Core becomes a trunk
        plan.trunks.push({ candidate: core });

        // Fan out satellites
        for (const sat of satellites) {
            const dist = computeCandidateDistance(core, sat);
            const maxLeafSpan = AUTO_SUPPORT_HARD_RULES.MAX_LEAF_SPAN_MM;

            if (dist > settings.maxBranchReachMm) {
                // Too far — standalone mini-trunk
                plan.trunks.push({ candidate: sat });
                continue;
            }

            if (dist <= maxLeafSpan) {
                // Close enough for a leaf
                // (parentKnot placeholder — autoPlace.ts fills in via selectHighestValidAttachment)
                plan.leaves.push({
                    candidate: sat,
                    parentKnot: {
                        id: `auto-${sat.id}`,
                        parentShaftId: '',
                        pos: core.tipPos,
                    },
                    hostDiameterMm: 1.0,
                });
            } else {
                // Branch fan-out
                plan.branches.push({
                    candidate: sat,
                    parentKnot: {
                        id: `auto-${sat.id}`,
                        parentShaftId: '',
                        pos: core.tipPos,
                    },
                });
            }
        }
    }

    return plan;
}

/**
 * Cluster candidates by spatial proximity using a grid-hash approach.
 * Candidates within clusterRadiusMm of each other are grouped together.
 */
export function clusterCandidates(
    candidates: CandidatePoint[],
    clusterRadiusMm: number,
): CandidatePoint[][] {
    if (candidates.length <= 1) {
        return candidates.length === 0 ? [] : [[candidates[0]]];
    }

    const cellSize = clusterRadiusMm;
    const grid = new Map<string, CandidatePoint[]>();

    for (const c of candidates) {
        const cx = Math.round(c.tipPos.x / cellSize);
        const cy = Math.round(c.tipPos.y / cellSize);
        const key = `${cx},${cy}`;
        const bucket = grid.get(key);
        if (bucket) {
            bucket.push(c);
        } else {
            grid.set(key, [c]);
        }
    }

    // Union-find to merge touching cells
    const cellKeys = [...grid.keys()];
    const parent = new Map<string, string>();
    for (const key of cellKeys) parent.set(key, key);

    function find(k: string): string {
        const p = parent.get(k)!;
        if (p === k) return k;
        const root = find(p);
        parent.set(k, root);
        return root;
    }

    function union(a: string, b: string) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    }

    for (const key of cellKeys) {
        const [cxStr, cyStr] = key.split(',');
        const cx = parseInt(cxStr);
        const cy = parseInt(cyStr);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const neighborKey = `${cx + dx},${cy + dy}`;
                if (grid.has(neighborKey)) {
                    union(key, neighborKey);
                }
            }
        }
    }

    // Group by root
    const groups = new Map<string, CandidatePoint[]>();
    for (const [key, cellCandidates] of grid) {
        const root = find(key);
        const group = groups.get(root);
        if (group) {
            group.push(...cellCandidates);
        } else {
            groups.set(root, [...cellCandidates]);
        }
    }

    return [...groups.values()];
}

/**
 * Select the best candidate to serve as the core trunk in a cluster.
 * Scores by: 60% area + 40% Z-height (lower = better).
 * The core trunk will be thicker and carry branches/leaves.
 */
export function selectCoreCandidate(cluster: CandidatePoint[]): CandidatePoint {
    if (cluster.length === 1) return cluster[0];

    const maxArea = Math.max(...cluster.map(c => c.islandAreaMm2), 0.01);
    const maxZ = Math.max(...cluster.map(c => c.zHeight), 1);

    let best = cluster[0];
    let bestScore = -Infinity;

    for (const c of cluster) {
        const areaScore = (c.islandAreaMm2 / maxArea) * 0.6;
        const zScore = (1 - c.zHeight / maxZ) * 0.4;
        const score = areaScore + zScore;
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best;
}

/**
 * Euclidean distance between two candidates' tip positions.
 */
export function computeCandidateDistance(a: CandidatePoint, b: CandidatePoint): number {
    const dx = a.tipPos.x - b.tipPos.x;
    const dy = a.tipPos.y - b.tipPos.y;
    const dz = a.tipPos.z - b.tipPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
