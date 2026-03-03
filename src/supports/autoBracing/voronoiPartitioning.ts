import { AUTO_BRACING_HARD_RULES } from './settings';

type Vec2 = { x: number; y: number };

export type VoronoiSupportNode = {
    supportId: string;
    modelId: string;
    point: Vec2;
};

export type VoronoiPartitionSettings = {
    seedSpacingMm: number;
    seedJitterMm: number;
    maxNeighborDistanceMm: number;
};

const EPS = 0.000001;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function hashString(input: string): number {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function pseudoRandom01(a: number, b: number, seed: number): number {
    const n = Math.sin(a * 12.9898 + b * 78.233 + seed * 0.0001) * 43758.5453123;
    return n - Math.floor(n);
}

function squaredDistance(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function makeBucketKey(ix: number, iy: number): string {
    return `${ix}:${iy}`;
}

function buildAdjacency(nodes: VoronoiSupportNode[], maxNeighborDistanceMm: number): Map<string, string[]> {
    const adjacency = new Map<string, Set<string>>();
    for (const node of nodes) adjacency.set(node.supportId, new Set<string>());

    if (nodes.length === 0) return new Map<string, string[]>();

    const cellSize = Math.max(maxNeighborDistanceMm, 0.1);
    const buckets = new Map<string, VoronoiSupportNode[]>();

    for (const node of nodes) {
        const ix = Math.floor(node.point.x / cellSize);
        const iy = Math.floor(node.point.y / cellSize);
        const key = makeBucketKey(ix, iy);
        const list = buckets.get(key) ?? [];
        list.push(node);
        buckets.set(key, list);
    }

    const maxDistSq = maxNeighborDistanceMm * maxNeighborDistanceMm;

    for (const node of nodes) {
        const ix = Math.floor(node.point.x / cellSize);
        const iy = Math.floor(node.point.y / cellSize);

        for (let ox = -1; ox <= 1; ox += 1) {
            for (let oy = -1; oy <= 1; oy += 1) {
                const neighborBucket = buckets.get(makeBucketKey(ix + ox, iy + oy));
                if (!neighborBucket) continue;

                for (const other of neighborBucket) {
                    if (other.supportId <= node.supportId) continue;
                    if (squaredDistance(node.point, other.point) > maxDistSq + EPS) continue;
                    adjacency.get(node.supportId)?.add(other.supportId);
                    adjacency.get(other.supportId)?.add(node.supportId);
                }
            }
        }
    }

    const normalized = new Map<string, string[]>();
    for (const [id, neighbors] of adjacency.entries()) {
        normalized.set(id, [...neighbors].sort());
    }
    return normalized;
}

function findConnectedIslands(nodes: VoronoiSupportNode[], adjacency: Map<string, string[]>): string[][] {
    const islands: string[][] = [];
    const visited = new Set<string>();

    for (const node of nodes) {
        if (visited.has(node.supportId)) continue;

        const island: string[] = [];
        const queue: string[] = [node.supportId];
        visited.add(node.supportId);

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const currentId = queue[cursor];
            island.push(currentId);
            const neighbors = adjacency.get(currentId) ?? [];
            for (const neighborId of neighbors) {
                if (visited.has(neighborId)) continue;
                visited.add(neighborId);
                queue.push(neighborId);
            }
        }

        islands.push(island);
    }

    return islands;
}

function nearestNodeId(target: Vec2, nodes: VoronoiSupportNode[], maxDistanceMm?: number): string | null {
    let best: VoronoiSupportNode | null = null;
    let bestDistSq = Infinity;

    for (const node of nodes) {
        const distSq = squaredDistance(target, node.point);
        if (distSq < bestDistSq) {
            best = node;
            bestDistSq = distSq;
        }
    }

    if (!best) return null;
    if (typeof maxDistanceMm === 'number' && bestDistSq > maxDistanceMm * maxDistanceMm + EPS) return null;
    return best.supportId;
}

function buildSeeds(nodes: VoronoiSupportNode[], settings: VoronoiPartitionSettings): Set<string> {
    const seeds = new Set<string>();
    if (nodes.length === 0) return seeds;

    let minX = nodes[0].point.x;
    let maxX = nodes[0].point.x;
    let minY = nodes[0].point.y;
    let maxY = nodes[0].point.y;

    for (const node of nodes) {
        if (node.point.x < minX) minX = node.point.x;
        if (node.point.x > maxX) maxX = node.point.x;
        if (node.point.y < minY) minY = node.point.y;
        if (node.point.y > maxY) maxY = node.point.y;
    }

    const spacing = Math.max(settings.seedSpacingMm, 0.25);
    const jitter = clamp(settings.seedJitterMm, 0, spacing * 0.49);
    const snapRadius = Math.max(spacing * 0.75, 0.25);
    const modelSeed = hashString(nodes[0].modelId);

    let ix = 0;
    for (let gx = minX; gx <= maxX + EPS; gx += spacing, ix += 1) {
        let iy = 0;
        for (let gy = minY; gy <= maxY + EPS; gy += spacing, iy += 1) {
            const jx = (pseudoRandom01(ix, iy, modelSeed) * 2 - 1) * jitter;
            const jy = (pseudoRandom01(ix, iy, modelSeed + 7919) * 2 - 1) * jitter;
            const target = { x: gx + jx, y: gy + jy };
            const snapped = nearestNodeId(target, nodes, snapRadius);
            if (snapped) seeds.add(snapped);
        }
    }

    return seeds;
}

function applyIslandFallbackSeeds(
    islands: string[][],
    nodeById: Map<string, VoronoiSupportNode>,
    seeds: Set<string>,
): void {
    for (const island of islands) {
        const hasSeed = island.some((id) => seeds.has(id));
        if (hasSeed) continue;

        let cx = 0;
        let cy = 0;
        const islandNodes: VoronoiSupportNode[] = [];

        for (const id of island) {
            const node = nodeById.get(id);
            if (!node) continue;
            islandNodes.push(node);
            cx += node.point.x;
            cy += node.point.y;
        }

        if (islandNodes.length === 0) continue;
        cx /= islandNodes.length;
        cy /= islandNodes.length;

        const snapped = nearestNodeId({ x: cx, y: cy }, islandNodes);
        if (snapped) seeds.add(snapped);
    }
}

function multiSourceClaim(
    nodes: VoronoiSupportNode[],
    adjacency: Map<string, string[]>,
    seeds: Set<string>,
): Map<string, string> {
    const claimedBySupportId = new Map<string, string>();
    const queue: Array<{ supportId: string; centerId: string }> = [];

    const sortedSeeds = [...seeds].sort();
    for (const centerId of sortedSeeds) {
        claimedBySupportId.set(centerId, centerId);
        queue.push({ supportId: centerId, centerId });
    }

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const { supportId, centerId } = queue[cursor];
        const neighbors = adjacency.get(supportId) ?? [];
        for (const neighborId of neighbors) {
            if (claimedBySupportId.has(neighborId)) continue;
            claimedBySupportId.set(neighborId, centerId);
            queue.push({ supportId: neighborId, centerId });
        }
    }

    if (claimedBySupportId.size === nodes.length) return claimedBySupportId;

    const claimedNodes = nodes.filter((node) => claimedBySupportId.has(node.supportId));
    for (const node of nodes) {
        if (claimedBySupportId.has(node.supportId)) continue;
        const nearestClaimed = nearestNodeId(node.point, claimedNodes);
        if (nearestClaimed) {
            const centerId = claimedBySupportId.get(nearestClaimed);
            if (centerId) {
                claimedBySupportId.set(node.supportId, centerId);
                continue;
            }
        }
        claimedBySupportId.set(node.supportId, node.supportId);
    }

    return claimedBySupportId;
}

function mergeSmallGroups(
    groups: string[][],
    nodeById: Map<string, VoronoiSupportNode>,
    minGroupSize: number,
): string[][] {
    if (groups.length <= 1) return groups;

    const finalGroups = groups.map((g) => [...g]);

    for (let i = 0; i < finalGroups.length; i += 1) {
        const group = finalGroups[i];
        if (group.length >= minGroupSize) continue;
        if (group.length === 0) continue;

        let bestGroupIndex = -1;
        let bestDistSq = Infinity;

        for (let j = 0; j < finalGroups.length; j += 1) {
            if (i === j) continue;
            const other = finalGroups[j];
            if (other.length === 0) continue;

            for (const idA of group) {
                const nodeA = nodeById.get(idA);
                if (!nodeA) continue;
                for (const idB of other) {
                    const nodeB = nodeById.get(idB);
                    if (!nodeB) continue;
                    const distSq = squaredDistance(nodeA.point, nodeB.point);
                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        bestGroupIndex = j;
                    }
                }
            }
        }

        if (bestGroupIndex === -1) continue;
        finalGroups[bestGroupIndex].push(...group);
        finalGroups[i] = [];
    }

    return finalGroups.filter((group) => group.length >= minGroupSize);
}

export function partitionSupportsWithVoronoi(
    supports: VoronoiSupportNode[],
    settings: VoronoiPartitionSettings,
): string[][] {
    if (supports.length === 0) return [];

    const minGroupSize = AUTO_BRACING_HARD_RULES.minGroupSize;
    const byModel = new Map<string, VoronoiSupportNode[]>();
    for (const support of supports) {
        const list = byModel.get(support.modelId) ?? [];
        list.push(support);
        byModel.set(support.modelId, list);
    }

    const groupsAcrossModels: string[][] = [];

    for (const modelSupports of byModel.values()) {
        if (modelSupports.length < minGroupSize) continue;

        const nodeById = new Map(modelSupports.map((node) => [node.supportId, node]));
        const adjacency = buildAdjacency(modelSupports, settings.maxNeighborDistanceMm);
        const islands = findConnectedIslands(modelSupports, adjacency);

        const seeds = buildSeeds(modelSupports, settings);
        applyIslandFallbackSeeds(islands, nodeById, seeds);

        if (seeds.size === 0 && modelSupports.length > 0) {
            seeds.add(modelSupports[0].supportId);
        }

        const claimedBySupportId = multiSourceClaim(modelSupports, adjacency, seeds);

        const groupsByCenter = new Map<string, string[]>();
        for (const support of modelSupports) {
            const centerId = claimedBySupportId.get(support.supportId);
            if (!centerId) continue;
            const list = groupsByCenter.get(centerId) ?? [];
            list.push(support.supportId);
            groupsByCenter.set(centerId, list);
        }

        const merged = mergeSmallGroups([...groupsByCenter.values()], nodeById, minGroupSize);
        for (const group of merged) {
            groupsAcrossModels.push(group.sort());
        }
    }

    return groupsAcrossModels;
}
