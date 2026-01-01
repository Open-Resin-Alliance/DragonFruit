import { Kingdom, TerritoryLayerResult } from './types';
import { Island } from '../IslandScan/types';
import { RleLabels } from '../IslandScan/rle';

// Helper for distance check (squared to avoid sqrt)
// Z scale factor assumes approx 1:1 aspect ratio between pixels and layers for now
function distSq3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number {
    const dz = z1 - z2;
    return (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2) + (dz * dz);
}

export class TerritoryTracker {
    private kingdoms: Map<number, Kingdom> = new Map();
    // Helper to map Fragment IDs -> Parent IDs
    private parentMap: Map<number, number> = new Map();

    constructor(islands: Island[]) {
        // Initialize maps
        for (const island of islands) {
            // Map fragments to parents if they exist
            if (island.parentId !== undefined) {
                this.parentMap.set(island.id, island.parentId);
            }

            // Filter noise: NONE.
            if (island.centroid) {
                // Determine Reference Centroid
                // For distance fields, we perform better using the "Terminal Centroid" (Top of the island)
                // rather than the Volume Centroid (Center of Mass), especially for "Heavy Boot" shapes.
                const refCentroid = island.lastLayerCentroid || island.centroid;

                this.kingdoms.set(island.id, {
                    id: island.id,
                    color: Math.floor(Math.random() * 0xFFFFFF),
                    centroid: { x: refCentroid.x, y: refCentroid.y, z: refCentroid.z },
                    lastLayer: island.lastLayer,
                    totalArea: island.totalAreaMm2,
                    parentId: island.parentId
                });
            }
        }
    }

    /**
     * Helper to resolve the true "Entity" ID.
     */
    private resolveId(id: number): number {
        let current = id;
        while (this.parentMap.has(current)) {
            current = this.parentMap.get(current)!;
        }
        return current;
    }

    /**
     * Process a layer using Global Identity + Connectivity.
     */
    processLayer(
        islandLabels: RleLabels,
        width: number,
        height: number,
        layerIndex: number,
        prevLabelMap: RleLabels | null | any
    ): TerritoryLayerResult {
        const { rows } = islandLabels;
        const newRows: Int32Array[] = new Array(height);
        const currentKingdoms = new Map<number, Kingdom>();

        for (let y = 0; y < height; y++) {
            const row = rows[y];
            const newRow: number[] = [];

            // Get previous layer row for vertical connectivity
            const prevRow = prevLabelMap ? prevLabelMap.rows[y] : null;
            let prevRowIdx = 0;

            // Iterate RLE Runs in Current Layer
            for (let i = 0; i < row.length; i += 3) {
                const start = row[i];
                const len = row[i + 1];
                const localId = row[i + 2];
                const end = start + len;

                if (localId === 0) continue;

                // --- 1. RESOLVE IDENTITY ---
                const globalId = this.resolveId(localId);
                const globalEntity = this.kingdoms.get(globalId);

                if (!globalEntity) continue;


                // --- 2. IDENTIFY CANDIDATES ---
                const candidates = new Set<number>();

                // Candidate A: The Native Owner (The Global Entity for this slice)
                candidates.add(globalId);

                // Candidate B: Vertical Invaders (From Below)
                if (prevRow) {
                    while (prevRowIdx < prevRow.length && (prevRow[prevRowIdx] + prevRow[prevRowIdx + 1]) <= start) {
                        prevRowIdx += 3;
                    }

                    let tempIdx = prevRowIdx;
                    while (tempIdx < prevRow.length) {
                        const pStart = prevRow[tempIdx];
                        const pLen = prevRow[tempIdx + 1];
                        const pId = prevRow[tempIdx + 2];
                        if (pStart >= end) break;

                        if (pId !== 0) {
                            candidates.add(pId);
                        }
                        tempIdx += 3;
                    }
                }

                // Candidate C: Horizontal Invaders (Neighbors)
                if (newRow.length > 0) {
                    const leftId = newRow[newRow.length - 1];
                    const leftEnd = newRow[newRow.length - 3] + newRow[newRow.length - 2];
                    if (leftEnd === start && leftId !== 0) {
                        candidates.add(leftId);
                    }
                }

                // --- 3. ARBITRATION (DISTANCE FIELD) ---
                if (candidates.size === 1) {
                    // Optimized Path
                    const winnerId = globalId;

                    if (newRow.length > 0 && newRow[newRow.length - 1] === winnerId && newRow[newRow.length - 2] + newRow[newRow.length - 3] === start) {
                        newRow[newRow.length - 2] += len;
                    } else {
                        newRow.push(start, len, winnerId);
                    }
                    if (!currentKingdoms.has(winnerId)) currentKingdoms.set(winnerId, globalEntity);
                } else {
                    // Battle Path
                    const candidatesArray = Array.from(candidates);

                    for (let j = 0; j < len; j++) {
                        const absX = start + j;
                        let bestId = globalId;
                        let minDist = Infinity;

                        for (const candId of candidatesArray) {
                            const cand = this.kingdoms.get(candId);
                            if (cand) {
                                // Distance to that Kingdom's TERMINAL Centroid (set in constructor)
                                const d = distSq3D(absX, y, layerIndex, cand.centroid.x, cand.centroid.y, cand.centroid.z);
                                if (d < minDist) {
                                    minDist = d;
                                    bestId = candId;
                                }
                            }
                        }

                        // RLE Re-encoding
                        if (newRow.length > 0 && newRow[newRow.length - 1] === bestId && newRow[newRow.length - 2] + newRow[newRow.length - 3] === absX) {
                            newRow[newRow.length - 2]++;
                        } else {
                            newRow.push(absX, 1, bestId);
                        }

                        if (!currentKingdoms.has(bestId)) {
                            const k = this.kingdoms.get(bestId);
                            if (k) currentKingdoms.set(bestId, k);
                        }
                    }
                }
            }
            newRows[y] = new Int32Array(newRow);
        }

        return {
            kingdoms: Array.from(currentKingdoms.values()),
            labelMap: { rows: newRows, width, height }
        };
    }
}
