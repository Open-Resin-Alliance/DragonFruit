type Vec2 = { x: number; y: number };

export type VoronoiSupportNode = {
    supportId: string;
    modelId: string;
    point: Vec2;
    debugPoint?: Vec2;
};

export type VoronoiPartitionSettings = {
    seedSpacingMm: number;
    seedJitterMm: number;
    maxNeighborDistanceMm: number;
};

export type VoronoiSeedMarker = {
    supportId: string;
    modelId: string;
    point: Vec2;
};

export type VoronoiSeedDebugMarker = {
    id: string;
    modelId: string;
    pos: { x: number; y: number; z: number };
};

let lastVoronoiSeedMarkers: VoronoiSeedMarker[] = [];

export function getLastVoronoiSeedMarkers(): VoronoiSeedMarker[] {
    return lastVoronoiSeedMarkers;
}

export function getVoronoiSeedDebugMarkers(): VoronoiSeedDebugMarker[] {
    return lastVoronoiSeedMarkers.map((seed) => ({
        id: `${seed.modelId}:${seed.supportId}`,
        modelId: seed.modelId,
        pos: {
            x: seed.point.x,
            y: seed.point.y,
            z: -0.35,
        },
    }));
}

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

type SpatialNodeBuckets = {
    cellSize: number;
    buckets: Map<string, VoronoiSupportNode[]>;
};

function buildSpatialNodeBuckets(nodes: VoronoiSupportNode[], cellSize: number): SpatialNodeBuckets {
    const safeCellSize = Math.max(cellSize, 0.1);
    const buckets = new Map<string, VoronoiSupportNode[]>();

    for (const node of nodes) {
        const ix = Math.floor(node.point.x / safeCellSize);
        const iy = Math.floor(node.point.y / safeCellSize);
        const key = makeBucketKey(ix, iy);
        const list = buckets.get(key) ?? [];
        list.push(node);
        buckets.set(key, list);
    }

    return {
        cellSize: safeCellSize,
        buckets,
    };
}

function nearestNodeIdFromBuckets(
    target: Vec2,
    spatial: SpatialNodeBuckets,
    maxDistanceMm: number,
): string | null {
    const maxDistSq = maxDistanceMm * maxDistanceMm;
    const ix = Math.floor(target.x / spatial.cellSize);
    const iy = Math.floor(target.y / spatial.cellSize);
    const bucketRadius = Math.max(1, Math.ceil(maxDistanceMm / spatial.cellSize));

    let best: VoronoiSupportNode | null = null;
    let bestDistSq = maxDistSq + EPS;

    for (let ox = -bucketRadius; ox <= bucketRadius; ox += 1) {
        for (let oy = -bucketRadius; oy <= bucketRadius; oy += 1) {
            const bucket = spatial.buckets.get(makeBucketKey(ix + ox, iy + oy));
            if (!bucket) continue;

            for (const node of bucket) {
                const distSq = squaredDistance(target, node.point);
                if (distSq > maxDistSq + EPS) continue;
                if (distSq >= bestDistSq) continue;
                best = node;
                bestDistSq = distSq;
            }
        }
    }

    return best?.supportId ?? null;
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
    const spatial = buildSpatialNodeBuckets(nodes, snapRadius);
    const modelSeed = hashString(nodes[0].modelId);

    let ix = 0;
    for (let gx = minX; gx <= maxX + EPS; gx += spacing, ix += 1) {
        let iy = 0;
        for (let gy = minY; gy <= maxY + EPS; gy += spacing, iy += 1) {
            const jx = (pseudoRandom01(ix, iy, modelSeed) * 2 - 1) * jitter;
            const jy = (pseudoRandom01(ix, iy, modelSeed + 7919) * 2 - 1) * jitter;
            const target = { x: gx + jx, y: gy + jy };
            const snapped = nearestNodeIdFromBuckets(target, spatial, snapRadius);
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

    const stranded = new Set<string>();
    for (const node of nodes) {
        if (!claimedBySupportId.has(node.supportId)) stranded.add(node.supportId);
    }

    let progress = true;
    while (progress && stranded.size > 0) {
        progress = false;
        for (const supportId of [...stranded]) {
            const neighbors = adjacency.get(supportId) ?? [];
            let attachedCenter: string | null = null;
            for (const neighborId of neighbors) {
                const center = claimedBySupportId.get(neighborId);
                if (center) {
                    attachedCenter = center;
                    break;
                }
            }

            if (!attachedCenter) continue;
            claimedBySupportId.set(supportId, attachedCenter);
            stranded.delete(supportId);
            progress = true;
        }
    }

    for (const supportId of stranded) {
        claimedBySupportId.set(supportId, supportId);
    }

    return claimedBySupportId;
}

export function partitionSupportsWithVoronoi(
    supports: VoronoiSupportNode[],
    settings: VoronoiPartitionSettings,
): string[][] {
    lastVoronoiSeedMarkers = [];
    if (supports.length === 0) return [];

    const byModel = new Map<string, VoronoiSupportNode[]>();
    for (const support of supports) {
        const list = byModel.get(support.modelId) ?? [];
        list.push(support);
        byModel.set(support.modelId, list);
    }

    const groupsAcrossModels: string[][] = [];

    for (const modelSupports of byModel.values()) {
        const adjacency = buildAdjacency(modelSupports, settings.maxNeighborDistanceMm);
        const nodeById = new Map(modelSupports.map((node) => [node.supportId, node]));
        const islands = findConnectedIslands(modelSupports, adjacency);

        const seeds = buildSeeds(modelSupports, settings);
        applyIslandFallbackSeeds(islands, nodeById, seeds);

        for (const island of islands) {
            if (island.length === 0) continue;
            const hasSeed = island.some((id) => seeds.has(id));
            if (hasSeed) continue;
            seeds.add(island[0]);
        }

        if (seeds.size === 0 && modelSupports.length > 0) {
            seeds.add(modelSupports[0].supportId);
        }

        for (const seedId of seeds) {
            const node = nodeById.get(seedId);
            if (!node) continue;
            const markerPoint = node.debugPoint ?? node.point;
            lastVoronoiSeedMarkers.push({
                supportId: node.supportId,
                modelId: node.modelId,
                point: { x: markerPoint.x, y: markerPoint.y },
            });
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

        for (const group of groupsByCenter.values()) {
            groupsAcrossModels.push(group.sort());
        }
    }

    return groupsAcrossModels;
}
