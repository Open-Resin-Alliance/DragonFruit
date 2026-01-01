import { type Island, type ComponentInfo } from './types';
import { type RleMask, type RleLabels, type RleRow } from './rle';

// Import the RLE component labeling utility
import { rleLabelComponents } from './rle';

/**
 * IslandTracker manages cross-layer island ID propagation.
 * Implements "Body Dominant" / "Stool Leg" logic.
 * - ID 1: The Main Body (Background/Merged/Base).
 * - IDs > 1: Distinct Islands (Overhangs/Legs).
 * - Rule: Islands grow upwards. If they merge (with each other or Body), they STOP logic and become Body.
 */
export class IslandTracker {
    private islands: Map<number, Island> = new Map();
    // Start at 2. ID 1 is strictly the "Body".
    private nextId: number = 2;
    private px_mm: number;
    private readonly BODY_ID = 1;

    constructor(px_mm: number) {
        this.px_mm = px_mm;
        // Initialize the Body Island (ID 1)
        this.islands.set(this.BODY_ID, {
            id: this.BODY_ID,
            firstLayer: 0,
            lastLayer: -1,
            status: 'active',
            totalAreaMm2: 0,
            perLayerAreaMm2: new Map(),
            childIds: [],
            maxAreaMm2: 0,
            maxAreaLayer: 0,
            centroidSumX: 0,
            centroidSumY: 0,
            centroidSumZ: 0,
            centroidCount: 0
        });
    }

    /**
     * Process a new layer's components and propagate/merge island IDs.
     */
    processLayer(
        layerIndex: number,
        currentLabels: RleLabels,
        currentComponents: ComponentInfo[],
        prevIslandLabels: RleLabels | null,
        solidMask: RleMask
    ): RleLabels {
        const { width, height } = currentLabels;
        const islandLabelRows: Int32Array[] = new Array(height);

        // 1. First Layer Logic
        if (!prevIslandLabels) {
            // First layer components are all "Starts".
            // Since they are at the bottom, they are effectively "Body" or foundational?
            // User said: "New ID starts with the lowest point of the island with the overhang that's not connected..."
            // If the mesh sits flat on the floor (Layer 0), is it an island?
            // Usually, "Island" implies support requirement. Layer 0 is supported by build plate.
            // HOWEVER, for "Body Analysis", we might want to track legs even if they touch the floor.
            // Let's assume everything on Layer 0 starts a new ID (Legs), unless we want Layer 0 to be Body?
            // Let's stick to the "New ID" rule for disjoint parts. Body (ID 1) is the "concept" of merged things.
            // Actually, if we have 4 legs on the floor, they are 4 disjoint IDs. 

            const componentIdToIslandId = new Map<number, number>();

            for (const comp of currentComponents) {
                const areaMm2 = comp.area_px * this.px_mm * this.px_mm;
                const assignedId = this.createNewIsland(layerIndex, areaMm2, comp);
                componentIdToIslandId.set(comp.id, assignedId);
            }

            // Map component labels to island labels
            for (let y = 0; y < height; y++) {
                const row = currentLabels.rows[y];
                const newRow: number[] = [];
                for (let i = 0; i < row.length; i += 3) {
                    const start = row[i];
                    const len = row[i + 1];
                    const compId = row[i + 2];
                    const islandId = componentIdToIslandId.get(compId) || this.BODY_ID;
                    newRow.push(start, len, islandId);
                }
                islandLabelRows[y] = new Int32Array(newRow);
            }

        } else {
            // 2. Subsequent Layers
            // Identify ALL solid components and see what they overlap with.

            // We use the imported utility correctly this time
            const { labels: solidLabels, components: solidComps } = rleLabelComponents(solidMask, 4);
            const solidCompIdToIslandId = new Map<number, number>();

            // OPTIMIZATION: Single pass to find all overlaps
            // Instead of scanning the grid for every component (O(K*H)), we scan once (O(Layers*Rows))
            const compToPrevIds = new Map<number, Set<number>>();

            for (let y = 0; y < height; y++) {
                const row = solidLabels.rows[y];
                const prevRow = prevIslandLabels.rows[y];
                if (row.length === 0 || prevRow.length === 0) continue;

                let pIdx = 0; // Sliding pointer for prevRow

                for (let i = 0; i < row.length; i += 3) {
                    const start = row[i];
                    const len = row[i + 1];
                    const compId = row[i + 2];
                    const end = start + len;

                    // Check overlaps with prevRow
                    // Advance pIdx
                    while (pIdx < prevRow.length) {
                        const pStart = prevRow[pIdx];
                        const pLen = prevRow[pIdx + 1];
                        const pEnd = pStart + pLen;
                        if (pEnd <= start) { // Strictly less than start (no overlap)
                            pIdx += 3;
                        } else {
                            break;
                        }
                    }

                    // Scan overlaps
                    let tempIdx = pIdx;
                    while (tempIdx < prevRow.length) {
                        const pStart = prevRow[tempIdx];
                        const pLen = prevRow[tempIdx + 1];
                        const pEnd = pStart + pLen;
                        const pId = prevRow[tempIdx + 2];

                        if (pStart >= end) break; // Passed

                        // Overlap found
                        // (pEnd > start) && (pStart < end) is guaranteed by logic
                        if (pId > 0) {
                            let set = compToPrevIds.get(compId);
                            if (!set) {
                                set = new Set();
                                compToPrevIds.set(compId, set);
                            }
                            set.add(pId);
                        }

                        tempIdx += 3;
                    }
                }
            }

            for (const component of solidComps) {
                // Find which previous island IDs this component overlaps with
                const prevIds = compToPrevIds.get(component.id) || new Set<number>();

                const areaMm2 = component.area_px * this.px_mm * this.px_mm;
                let assignedId: number;

                // --- STOOL LEG LOGIC (Body Dominant) ---

                if (prevIds.size === 0) {
                    // 1. No Connection below -> New ID (Start of new Island/Overhang)
                    assignedId = this.createNewIsland(layerIndex, areaMm2, component);
                } else if (prevIds.has(this.BODY_ID)) {
                    // 2. Connected to Body -> Becomes Body
                    // The island(s) that merged into this effectively stop growing here.
                    // We mark them as complete.
                    assignedId = this.BODY_ID;
                    this.closeIslands(prevIds, layerIndex);
                    this.updateIsland(this.BODY_ID, layerIndex, areaMm2, component);
                } else if (prevIds.size > 1) {
                    // 3. Connected to Multiple Distinct Islands (Merge) -> Becomes Body
                    // This is the "Seat" of the stool where legs join.
                    // The legs stop here. The seat is Body.
                    assignedId = this.BODY_ID;
                    this.closeIslands(prevIds, layerIndex);
                    this.updateIsland(this.BODY_ID, layerIndex, areaMm2, component);
                } else {
                    // 4. Connected to Exactly One Island (and it's not Body) -> Propagate
                    assignedId = prevIds.values().next().value;
                    this.updateIsland(assignedId, layerIndex, areaMm2, component);
                }

                solidCompIdToIslandId.set(component.id, assignedId);
            }

            // Build output RLE labels
            for (let y = 0; y < height; y++) {
                const row = solidLabels.rows[y];
                const newRow: number[] = [];
                for (let i = 0; i < row.length; i += 3) {
                    const start = row[i];
                    const len = row[i + 1];
                    const compId = row[i + 2];
                    const islandId = solidCompIdToIslandId.get(compId) || this.BODY_ID;
                    // Only record solid runs
                    if (islandId > 0) { // Should always be true as BODY_ID=1
                        newRow.push(start, len, islandId);
                    }
                }
                islandLabelRows[y] = new Int32Array(newRow);
            }
        }

        return { rows: islandLabelRows, width, height };
    }

    // --- HELPER METHODS ---

    /** Helper to close islands that have merged into the Body or other islands */
    private closeIslands(ids: Set<number>, layerIndex: number) {
        for (const id of ids) {
            if (id === this.BODY_ID) continue;
            const island = this.islands.get(id);
            if (island && island.status === 'active') {
                island.status = 'complete';
                island.lastLayer = layerIndex - 1; // It stopped at the previous layer
            }
        }
    }

    private createNewIsland(layerIndex: number, areaMm2: number, comp?: ComponentInfo): number {
        const id = this.nextId++;
        const island: Island = {
            id,
            firstLayer: layerIndex,
            lastLayer: layerIndex,
            status: 'active',
            totalAreaMm2: areaMm2,
            perLayerAreaMm2: new Map([[layerIndex, areaMm2]]),
            childIds: [], // No longer using child tracking for merges, but structure exists

            // Bounds/Centroid Helpers
            maxAreaMm2: areaMm2,
            maxAreaLayer: layerIndex,
            centroidSumX: (comp && typeof comp.centroidSumX === 'number') ? comp.centroidSumX : 0,
            centroidSumY: (comp && typeof comp.centroidSumY === 'number') ? comp.centroidSumY : 0,
            centroidSumZ: comp ? comp.size * layerIndex : 0,
            centroidCount: comp ? comp.size : 0,
            lastLayerCentroid: (comp && typeof comp.centroidSumX === 'number' && comp.size > 0) ? {
                x: comp.centroidSumX / comp.size,
                y: comp.centroidSumY / comp.size,
                z: layerIndex
            } : undefined
        };
        this.islands.set(id, island);
        return id;
    }

    private updateIsland(id: number, layerIndex: number, areaMm2: number, comp?: ComponentInfo): void {
        const island = this.islands.get(id);
        if (!island) return;

        island.lastLayer = layerIndex;
        island.totalAreaMm2 += areaMm2;
        island.perLayerAreaMm2.set(layerIndex, areaMm2);

        if (!island.maxAreaMm2 || areaMm2 > island.maxAreaMm2) {
            island.maxAreaMm2 = areaMm2;
            island.maxAreaLayer = layerIndex;
        }

        if (comp) {
            if (typeof comp.centroidSumX === 'number') {
                island.centroidSumX += comp.centroidSumX;
                island.centroidSumY += comp.centroidSumY;
                island.centroidSumZ += comp.size * layerIndex;
                island.centroidCount += comp.size;

                if (comp.size > 0) {
                    island.lastLayerCentroid = {
                        x: comp.centroidSumX / comp.size,
                        y: comp.centroidSumY / comp.size,
                        z: layerIndex
                    };
                }
            }
        }
    }

    private findOverlappingIslandIdsRle(
        compId: number,
        solidLabels: RleLabels,
        prevIslandLabels: RleLabels
    ): Set<number> {
        const prevIds = new Set<number>();
        const { height } = solidLabels;

        for (let y = 0; y < height; y++) {
            const solidRow = solidLabels.rows[y];
            const prevRow = prevIslandLabels.rows[y];

            if (solidRow.length === 0 || prevRow.length === 0) continue;

            for (let i = 0; i < solidRow.length; i += 3) {
                if (solidRow[i + 2] === compId) {
                    const start = solidRow[i];
                    const len = solidRow[i + 1];
                    const end = start + len;

                    const searchStart = start; // Strict vertical overlap? Island logic usually uses dilation.
                    // Step 1 logic used 3x3 kernel (dy -1 to 1). 
                    // Let's replicate exact overlap first (vertical), but usually we want connectivity.
                    // The standard scanLayer logic used dilation. 
                    // HERE we are comparing solid-to-solid. Direct vertical overlap is usually sufficient for "Stool Legs".
                    // But if it slopes, we might miss it without expansion.
                    // Let's use simple vertical overlap for robustness + slight tolerance if needed.
                    // Actually, let's keep it simple: Overlap of ranges.

                    const searchEnd = end;

                    for (let j = 0; j < prevRow.length; j += 3) {
                        const pStart = prevRow[j];
                        const pLen = prevRow[j + 1];
                        const pId = prevRow[j + 2];
                        const pEnd = pStart + pLen;

                        // Check intersection
                        if (Math.max(start, pStart) < Math.min(end, pEnd)) {
                            if (pId > 0) prevIds.add(pId);
                        }
                    }
                }
            }
        }
        return prevIds;
    }

    public getIslands(): Island[] {
        return Array.from(this.islands.values());
    }

    public finalizeIslands(finalLayer: number): void {
        // No-op for this logic
    }
}
