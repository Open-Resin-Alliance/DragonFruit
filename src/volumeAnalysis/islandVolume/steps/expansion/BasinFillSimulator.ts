import * as THREE from 'three';
import { type ScanResults } from '../voxelization/ScanOrchestrator';

// Voxel State
export const STATE_UNASSIGNED = 0;
export const STATE_SEED = -1; // Temp marker for initialization if needed

export interface ExpansionState {
    voxelId: number; // Index in the flat list of solid voxels
    islandId: number;
    distance: number;
}

/**
 * Manages the iterative "Basin Fill" expansion of island territories.
 * Uses a flat list of "Solid Voxels" to avoid processing empty space.
 * Uses a Sparse Hash Map to handle neighbor lookups without allocating massive grids.
 * Tracks Modified Indices for efficient visualization updates.
 */
export class BasinFillSimulator {
    public solidVoxelCount: number = 0;

    // Arrays indexed by [SolidVoxelIndex]
    public labels: Int32Array; // Island ID per solid voxel
    public parentSources: Int32Array; // Which island center "claimed" this voxel
    public surfaceVoxelIndices: Int32Array | null = null;
    public surfaceCount: number = 0;


    // Position data for all solid voxels (for distance calc)
    public positions: Float32Array; // x, y, z packed
    public gridIndices: Int32Array; // Grid Index for each solid voxel

    // Queue for BFS
    private queue: number[] = [];

    // Modification Tracking
    public changedVoxelIndices: number[] = [];

    // Sparse Hash Map for GlobalIndex -> SolidVoxelIndex
    // Keys: GlobalIndex, Values: SolidVoxelIndex
    public mapKeys: Int32Array;
    public mapValues: Int32Array;
    public mapCapacity: number;
    public mapMask: number;

    public gridWidth: number;
    public gridHeight: number;
    public gridDepth: number;
    public layerHeightMm: number;
    public pxMm: number;

    private islandCenters: Map<number, THREE.Vector3>;
    public seedIndices: Set<number>;

    public isComplete = false;
    public iterationCount = 0;

    constructor(
        results: ScanResults,
        layerHeightMm: number,
        worldMinZ: number
    ) {
        this.pxMm = results.grid.px_mm;
        this.layerHeightMm = layerHeightMm;
        this.gridWidth = results.grid.width;
        this.gridHeight = results.grid.height;
        this.gridDepth = results.layers.length;

        // 1. Count Solid Voxels First to allocate exactly
        let solidCount = 0;
        for (let z = 0; z < this.gridDepth; z++) {
            const mask = results.layers[z].islandMaskRle;
            if (!mask) continue;
            for (let y = 0; y < mask.height; y++) {
                const row = mask.rows[y];
                for (let i = 0; i < row.length; i += 2) {
                    solidCount += row[i + 1];
                }
            }
        }

        this.solidVoxelCount = solidCount;

        // 2. Initialize Sparse Map
        // Load Factor 0.5 for speed (Capacity = nextPowerOf2(SolidCount * 2))
        let cap = 1;
        while (cap < solidCount * 2) cap *= 2;
        this.mapCapacity = cap;
        this.mapMask = cap - 1;
        this.mapKeys = new Int32Array(cap).fill(-1);
        this.mapValues = new Int32Array(cap).fill(-1);

        console.log(`[BasinFillSimulator] Grid: ${this.gridWidth}x${this.gridHeight}x${this.gridDepth}. Solids: ${solidCount}. MapCap: ${cap}`);

        // 3. Initialize Arrays
        this.labels = new Int32Array(solidCount).fill(0);
        this.parentSources = new Int32Array(solidCount).fill(0);

        this.positions = new Float32Array(solidCount * 3);
        this.gridIndices = new Int32Array(solidCount);

        // 4. Populate Data & Map
        this.islandCenters = new Map();
        results.islands.forEach(island => {
            if (island.internalCenter) {
                this.islandCenters.set(island.id, island.internalCenter);
            }
        });

        this.seedIndices = new Set();

        let currentIdx = 0;
        const originX = results.grid.originX;
        const originZ = results.grid.originZ;

        for (let z = 0; z < this.gridDepth; z++) {
            const layer = results.layers[z];
            const mask = layer.islandMaskRle;
            if (!mask) continue;

            for (let y = 0; y < mask.height; y++) {
                const row = mask.rows[y];
                for (let i = 0; i < row.length; i += 2) {
                    const startX = row[i];
                    const len = row[i + 1];
                    for (let x = startX; x < startX + len; x++) {
                        const gridIdx = x + (y * this.gridWidth) + (z * this.gridWidth * this.gridHeight);

                        this.gridIndices[currentIdx] = gridIdx;

                        // Insert into Sparse Map (Open Addressing, Linear Probing)
                        let slot = gridIdx & this.mapMask;
                        while (this.mapKeys[slot] !== -1) {
                            slot = (slot + 1) & this.mapMask;
                        }
                        this.mapKeys[slot] = gridIdx;
                        this.mapValues[slot] = currentIdx;

                        // World Pos
                        // Grid Logic: gridY increases -> WorldY decreases.
                        // originZ corresponds to -MaxY (Top-Left corner logic in image space).
                        // worldY = -(originZ + y*px + offset)
                        const wx = originX + (x * this.pxMm) + (this.pxMm * 0.5);
                        const wy = -(originZ + (y * this.pxMm) + (this.pxMm * 0.5));
                        const wz = worldMinZ + (z * this.layerHeightMm) + (this.layerHeightMm * 0.5);

                        this.positions[currentIdx * 3] = wx;
                        this.positions[currentIdx * 3 + 1] = wy;
                        this.positions[currentIdx * 3 + 2] = wz;

                        currentIdx++;
                    }
                }
            }
        }

        // 5. Initialize Seeds based on Internal Centers
        // Find which solid voxel contains the center point.
        console.log(`[BasinFillSimulator] Centers to Map: ${this.islandCenters.size}`);
        console.log(`[BasinFillSimulator] Grid Info: OriginX=${originX}, OriginZ=${originZ}, PxMm=${this.pxMm}, MinZ=${worldMinZ}, LayerH=${this.layerHeightMm}`);

        let successCount = 0;
        let failCount = 0;

        this.islandCenters.forEach((center, islandId) => {
            // Convert World Center -> Grid Coords
            const gx = Math.floor((center.x - originX) / this.pxMm);
            // Y Conversion (Inverted):
            // worldY = -(originZ + gy*px)
            // -worldY = originZ + gy*px
            // gy = (-worldY - originZ) / px
            const gy = Math.floor((-center.y - originZ) / this.pxMm);
            const gz = Math.floor((center.z - worldMinZ) / this.layerHeightMm);

            if (gx >= 0 && gx < this.gridWidth &&
                gy >= 0 && gy < this.gridHeight &&
                gz >= 0 && gz < this.gridDepth) {

                const gridIdx = gx + (gy * this.gridWidth) + (gz * this.gridWidth * this.gridHeight);

                // Lookup in Sparse Map
                const solidIdx = this.lookup(gridIdx);

                if (solidIdx !== -1) {
                    // Found the seed voxel!
                    this.labels[solidIdx] = islandId;
                    this.parentSources[solidIdx] = islandId;

                    this.queue.push(solidIdx);
                    this.seedIndices.add(solidIdx);
                    this.changedVoxelIndices.push(solidIdx);
                    successCount++;
                } else {
                    if (failCount < 5) {
                        console.warn(`[BasinFillSimulator] Seed FAIL Island ${islandId}: World(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}) -> Grid(${gx}, ${gy}, ${gz}) -> Idx ${gridIdx}. Not in Solid Map.`);
                    }
                    failCount++;
                }
            } else {
                if (failCount < 5) {
                    console.warn(`[BasinFillSimulator] Seed OOB Island ${islandId}: World(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}) -> Grid(${gx}, ${gy}, ${gz}). GridDims: ${this.gridWidth}x${this.gridHeight}x${this.gridDepth}`);
                }
                failCount++;
            }
        });

        // 6. Calculate Surface Voxels
        // Filter out internal voxels to reduce rendering load
        const surfaceIndicesTemp: number[] = [];
        const strideY = this.gridWidth;
        const strideZ = this.gridWidth * this.gridHeight;
        const offsets = [1, -1, strideY, -strideY, strideZ, -strideZ];
        const mapKeys = this.mapKeys;
        const mapMask = this.mapMask;
        const mapValues = this.mapValues;

        for (let i = 0; i < solidCount; i++) {
            const currentGridIdx = this.gridIndices[i];
            let isSurface = false;

            for (let j = 0; j < 6; j++) {
                const neighborIdx = currentGridIdx + offsets[j];

                // Optimized Lookup (Inline)
                let found = false;
                let slot = neighborIdx & mapMask;
                while (true) {
                    const key = mapKeys[slot];
                    if (key === -1) {
                        // Empty neighbor found! This is a surface voxel.
                        found = false;
                        break;
                    }
                    if (key === neighborIdx) {
                        found = true;
                        break;
                    }
                    slot = (slot + 1) & mapMask;
                }

                if (!found) {
                    isSurface = true;
                    break;
                }
            }

            if (isSurface) {
                surfaceIndicesTemp.push(i);
            }
        }

        this.surfaceCount = surfaceIndicesTemp.length;
        this.surfaceVoxelIndices = new Int32Array(surfaceIndicesTemp);

        console.log(`[BasinFillSimulator] Initialized with ${successCount} seeds. Failed: ${failCount}. Surface Voxels: ${this.surfaceCount}/${solidCount} (${((this.surfaceCount / solidCount) * 100).toFixed(1)}%)`);
    }

    public lookup(gridIdx: number): number {
        let slot = gridIdx & this.mapMask;
        while (true) {
            const key = this.mapKeys[slot];
            if (key === -1) return -1; // Not found
            if (key === gridIdx) return this.mapValues[slot];
            slot = (slot + 1) & this.mapMask;
        }
    }

    public tick(steps: number = 1000): void {
        if (this.queue.length === 0) {
            this.isComplete = true;
            return;
        }

        let processed = 0;
        const strideY = this.gridWidth;
        const strideZ = this.gridWidth * this.gridHeight;

        const offsets = [
            1, -1,              // +/- X
            strideY, -strideY,  // +/- Y
            strideZ, -strideZ   // +/- Z
        ];

        // Cache map properties for loop speed
        const mapKeys = this.mapKeys;
        const mapValues = this.mapValues;
        const mapMask = this.mapMask;

        while (processed < steps && this.queue.length > 0) {
            const currentIdx = this.queue.shift()!; // FIFO
            processed++;

            const currentLabel = this.labels[currentIdx];
            // No center lookups needed for pure flood fill

            const currentGridIdx = this.gridIndices[currentIdx];

            // Neighbors
            for (let i = 0; i < 6; i++) {
                const neighborGridIdx = currentGridIdx + offsets[i];

                // Optimized Sparse Lookup Inline
                let neighborSolidIdx = -1;
                let slot = neighborGridIdx & mapMask;

                // Linear probe lookup
                while (true) {
                    const key = mapKeys[slot];
                    if (key === -1) break; // Not found
                    if (key === neighborGridIdx) {
                        neighborSolidIdx = mapValues[slot];
                        break;
                    }
                    slot = (slot + 1) & mapMask;
                }

                if (neighborSolidIdx === -1) continue; // Not solid / Not found

                // First-to-Claim Logic (Multi-Source BFS)
                // If the neighbor is unassigned (0), we claim it.
                // We do NOT check distances. The first wave to reach it wins.
                if (this.labels[neighborSolidIdx] === 0) {
                    this.labels[neighborSolidIdx] = currentLabel;
                    this.parentSources[neighborSolidIdx] = currentLabel;

                    this.queue.push(neighborSolidIdx);
                    this.changedVoxelIndices.push(neighborSolidIdx); // Track Change
                }
            }
        }

        this.iterationCount += processed;

        if (this.queue.length === 0) {
            this.isComplete = true;
            console.log('Basin Fill Complete', processed);
        }
    }

    // Helper to retrieve and clear modifications
    public flushChanges(): number[] {
        if (this.changedVoxelIndices.length === 0) return [];
        const changes = this.changedVoxelIndices;
        this.changedVoxelIndices = [];
        return changes;
    }

    public terminate(): void {
        // No-op for direct simulation
    }
}
