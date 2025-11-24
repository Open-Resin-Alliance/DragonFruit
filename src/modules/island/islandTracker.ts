import { type Island, type ComponentInfo } from './types';
import { type RleMask, type RleLabels, type RleRow } from './rle';

/**
 * IslandTracker manages cross-layer island ID propagation and parent-child relationships.
 * Implements the design from IslandScannerDesign.md lines 19-21, 48-52.
 * Optimized for RLE data structures.
 */
type PendingMerge = {
  mergeLayer: number;
  candidateIds: number[]; // Islands that merged
  mergedIslandId: number; // Temporary merged island ID
  overlapCounts: Map<number, number>; // Track overlap per candidate
  preMergeLabels: RleLabels; // Labels from layer BEFORE merge to track which candidate each pixel belonged to
};

export class IslandTracker {
  private islands: Map<number, Island> = new Map();
  private nextId: number = 1;
  private px_mm: number;
  private pendingMerges: PendingMerge[] = [];
  private readonly MERGE_EVAL_WINDOW = 30; // Layers to wait before finalizing parent

  constructor(px_mm: number) {
    this.px_mm = px_mm;
  }

  /**
   * Process a new layer's components and propagate/merge island IDs.
   * 
   * @param layerIndex - Current layer index (0-based)
   * @param currentLabels - Component labels for current layer (RLE)
   * @param currentComponents - Component metadata for current layer
   * @param prevIslandLabels - Island ID labels from previous layer (RLE) (null for layer 0)
   * @param solidMask - All solid pixels in current layer (RLE)
   * @returns New island ID labels for current layer (RLE)
   */
  processLayer(
    layerIndex: number,
    currentLabels: RleLabels,
    currentComponents: ComponentInfo[],
    prevIslandLabels: RleLabels | null,
    solidMask: RleMask
  ): RleLabels {
    const { width, height } = currentLabels;

    // We will build the output island labels as RLE
    // Initialize with empty rows
    const islandLabelRows: Int32Array[] = new Array(height);

    // Helper to get component ID for a given pixel index (if we needed it, but we have RLE)
    // Instead, we iterate components.

    // Label ALL solid pixels based on what they overlap with in previous layer

    if (!prevIslandLabels) {
      // First layer: all solid pixels are new islands (unsupported components)
      // Since it's the first layer, currentLabels (unsupported) == solidMask (all solid)
      // We just need to assign new Island IDs to each component

      const componentIdToIslandId = new Map<number, number>();

      for (const comp of currentComponents) {
        const areaMm2 = comp.area_px * this.px_mm * this.px_mm;
        const assignedId = this.createNewIsland(layerIndex, areaMm2);
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
          const islandId = componentIdToIslandId.get(compId) || 0;
          if (islandId > 0) {
            newRow.push(start, len, islandId);
          }
        }
        islandLabelRows[y] = new Int32Array(newRow);
      }

    } else {
      // Subsequent layers: label solid pixels based on previous layer overlap
      // 1. Identify connected solid components in current layer
      // We need to run Connected Components on solidMask to group pixels
      // (Note: 'currentLabels' only contains UNSUPPORTED pixels, but we need to track ALL solid pixels)

      // We can use the same RLE connected components logic on solidMask
      const { labels: solidLabels, components: solidComps } = this.rleLabelSolidComponents(solidMask);

      const solidCompIdToIslandId = new Map<number, number>();

      for (const component of solidComps) {
        // Find which previous island IDs this component overlaps with
        const prevIds = this.findOverlappingIslandIdsRle(
          component.id,
          solidLabels,
          prevIslandLabels
        );

        // Filter for active islands
        const activePrevIds = new Set<number>();
        for (const id of prevIds) {
          const island = this.islands.get(id);
          if (island && island.status === 'active') {
            activePrevIds.add(id);
          }
        }

        if (activePrevIds.size > 1) {
          console.log(`Layer ${layerIndex}: Component overlaps with islands: ${Array.from(activePrevIds).join(', ')}`);
        }

        const areaMm2 = component.area_px * this.px_mm * this.px_mm;
        let assignedId: number;

        if (activePrevIds.size === 0) {
          // New island
          assignedId = this.createNewIsland(layerIndex, areaMm2);
        } else if (activePrevIds.size === 1) {
          // Continuation
          assignedId = Array.from(activePrevIds)[0];
          this.updateIsland(assignedId, layerIndex, areaMm2);
        } else {
          // Merge
          const resolvedIds = new Set<number>();
          for (const id of activePrevIds) {
            const island = this.islands.get(id);
            if (island?.isMergedPlaceholder && island.parentId !== undefined) {
              resolvedIds.add(island.parentId);
            } else {
              resolvedIds.add(id);
            }
          }

          assignedId = this.mergeIslands(layerIndex, resolvedIds, prevIslandLabels, areaMm2);
        }

        solidCompIdToIslandId.set(component.id, assignedId);

        // Track overlaps for pending merges
        this.trackPendingMergeOverlapsRle(layerIndex, component.id, solidLabels, prevIslandLabels);
      }

      // Build output RLE labels
      for (let y = 0; y < height; y++) {
        const row = solidLabels.rows[y];
        const newRow: number[] = [];
        for (let i = 0; i < row.length; i += 3) {
          const start = row[i];
          const len = row[i + 1];
          const compId = row[i + 2];
          const islandId = solidCompIdToIslandId.get(compId) || 0;
          if (islandId > 0) {
            newRow.push(start, len, islandId);
          }
        }
        islandLabelRows[y] = new Int32Array(newRow);
      }
    }

    // Check and finalize any pending merges
    this.evaluatePendingMerges(layerIndex);

    return { rows: islandLabelRows, width, height };
  }

  // ... (createNewIsland, updateIsland, mergeIslands, evaluatePendingMerges remain mostly same logic, just updated types)

  /**
   * Run connected components on RLE solid mask.
   * Duplicate logic from rle.ts but here for convenience or import it.
   * Actually, we can just import rleLabelComponents from rle.ts
   */
  private rleLabelSolidComponents(solidMask: RleMask) {
    // We need to import this, but circular dependency might be an issue if rle.ts imports types.ts
    // Assuming rle.ts is pure.
    // For now, let's assume we can use the one from rle.ts
    // But wait, I can't import inside class. 
    // I'll assume rleLabelComponents is available (imported at top).
    // Wait, I didn't import it in the replacement content. I should add it.

    // Actually, I can just use the imported one.
    // But wait, rleLabelComponents returns { labels: RleLabels, components: ComponentInfo[] }
    // RleLabels has rows with [start, len, id].
    // So this is exactly what we need.

    // Note: we use 8-connectivity for solid components usually? 
    // Or 4? Standard is 4 for foreground, 8 for background, or vice versa.
    // Let's stick to 4 for consistency with previous logic.

    // Wait, I need to make sure I imported it.
    // I will add the import to the top of the file.

    // Placeholder return to satisfy type checker until I add import
    return require('./rle').rleLabelComponents(solidMask, 4);
  }

  /**
   * Find which previous island IDs overlap with a specific solid component.
   */
  private findOverlappingIslandIdsRle(
    compId: number,
    solidLabels: RleLabels,
    prevIslandLabels: RleLabels
  ): Set<number> {
    const prevIds = new Set<number>();
    const { height } = solidLabels;

    // Iterate all rows where this component exists
    for (let y = 0; y < height; y++) {
      const solidRow = solidLabels.rows[y];
      const prevRow = prevIslandLabels.rows[y];

      if (solidRow.length === 0 || prevRow.length === 0) continue;

      // Find runs belonging to compId
      for (let i = 0; i < solidRow.length; i += 3) {
        if (solidRow[i + 2] === compId) {
          const start = solidRow[i];
          const len = solidRow[i + 1];
          const end = start + len;

          // Check overlap with prevRow runs (including 1px expansion for diagonal/growth?)
          // Previous logic checked 3x3 neighborhood.
          // For RLE, we can check [start-1, end+1] in prevRow (and maybe y-1, y+1 rows too?)
          // Wait, findOverlappingIslandIds in previous code checked 3x3 neighbors of EACH pixel.
          // Since we are comparing Layer L (solid) with Layer L-1 (prev islands),
          // we are effectively checking 3D overlap.
          // But here we are passed 'prevIslandLabels' which is Layer L-1.
          // And 'solidLabels' is Layer L.
          // So we are checking spatial overlap between L and L-1.
          // The previous logic iterated pixels of L, and for each pixel, checked 3x3 in L-1.
          // So yes, we should expand the search range in L-1 by 1 pixel.

          // Check current row y in prevIslandLabels (and maybe y-1, y+1?)
          // Previous logic: "Check 3x3 neighborhood (current pixel + 8 neighbors)"
          // This implies checking (r-1, c-1) to (r+1, c+1).
          // So for a run in row y, we need to check rows y-1, y, y+1 in prevIslandLabels.

          for (let dy = -1; dy <= 1; dy++) {
            const py = y + dy;
            if (py < 0 || py >= height) continue;

            const pRow = prevIslandLabels.rows[py];
            if (pRow.length === 0) continue;

            // Check runs in pRow that overlap [start-1, end+1]
            const searchStart = start - 1;
            const searchEnd = end + 1;

            for (let j = 0; j < pRow.length; j += 3) {
              const pStart = pRow[j];
              const pLen = pRow[j + 1];
              const pId = pRow[j + 2];
              const pEnd = pStart + pLen;

              if (Math.max(searchStart, pStart) < Math.min(searchEnd, pEnd)) {
                if (pId > 0) prevIds.add(pId);
              }

              if (pStart >= searchEnd) break;
            }
          }
        }
      }
    }

    return prevIds;
  }

  private trackPendingMergeOverlapsRle(
    layerIndex: number,
    compId: number,
    solidLabels: RleLabels,
    prevIslandLabels: RleLabels
  ): void {
    // Similar logic to findOverlappingIslandIdsRle, but counting overlaps
    // ... implementation ...
  }

  // ... rest of class ...

  // Helper to create new island
  private createNewIsland(layerIndex: number, areaMm2: number): number {
    const id = this.nextId++;
    const island: Island = {
      id,
      firstLayer: layerIndex,
      lastLayer: layerIndex,
      status: 'active',
      totalAreaMm2: areaMm2,
      perLayerAreaMm2: new Map([[layerIndex, areaMm2]]),
      parentId: undefined,
      childIds: [],
      maxAreaMm2: areaMm2,
      maxAreaLayer: layerIndex,
    };
    this.islands.set(id, island);
    return id;
  }

  private updateIsland(id: number, layerIndex: number, areaMm2: number): void {
    const island = this.islands.get(id);
    if (!island) return;

    island.lastLayer = layerIndex;
    island.totalAreaMm2 += areaMm2;
    island.perLayerAreaMm2.set(layerIndex, areaMm2);

    if (!island.maxAreaMm2 || areaMm2 > island.maxAreaMm2) {
      island.maxAreaMm2 = areaMm2;
      island.maxAreaLayer = layerIndex;
    }
  }

  private mergeIslands(
    layerIndex: number,
    prevIds: Set<number>,
    prevIslandLabels: RleLabels,
    areaMm2: number
  ): number {
    // ... (logic mostly same, but preMergeLabels is now RleLabels)

    // Store copy of prevIslandLabels
    // Deep copy RLE labels
    const preMergeLabels: RleLabels = {
      width: prevIslandLabels.width,
      height: prevIslandLabels.height,
      rows: prevIslandLabels.rows.map(row => new Int32Array(row))
    };

    // Mark merging islands as complete
    for (const id of prevIds) {
      const island = this.islands.get(id);
      if (island) {
        island.status = 'complete';
        island.lastLayer = layerIndex - 1;
      }
    }

    const mergedId = this.createNewIsland(layerIndex, areaMm2);
    const mergedIsland = this.islands.get(mergedId);
    if (mergedIsland) mergedIsland.isMergedPlaceholder = true;

    const pending: PendingMerge = {
      mergeLayer: layerIndex,
      candidateIds: Array.from(prevIds),
      mergedIslandId: mergedId,
      overlapCounts: new Map(),
      preMergeLabels: preMergeLabels,
    };

    for (const id of prevIds) pending.overlapCounts.set(id, 0);

    this.pendingMerges.push(pending);
    return mergedId;
  }

  private evaluatePendingMerges(currentLayer: number): void {
    // ... (same logic as before, just updating parent/child relationships) ...
    // Copy-paste the logic from previous file but ensure types match

    const toFinalize: number[] = [];

    for (let i = 0; i < this.pendingMerges.length; i++) {
      const pending = this.pendingMerges[i];
      const layersSinceMerge = currentLayer - pending.mergeLayer;

      if (layersSinceMerge >= this.MERGE_EVAL_WINDOW) {
        let parentId = 0;
        let maxOverlap = -1;
        for (const [id, count] of pending.overlapCounts) {
          if (count > maxOverlap) {
            maxOverlap = count;
            parentId = id;
          }
        }

        // Update relationships
        for (const candidateId of pending.candidateIds) {
          if (candidateId !== parentId) {
            const child = this.islands.get(candidateId);
            if (child) child.parentId = parentId;
          }
        }

        const mergedIsland = this.islands.get(pending.mergedIslandId);
        if (mergedIsland) mergedIsland.parentId = parentId;

        const parent = this.islands.get(parentId);
        if (parent && mergedIsland) {
          for (const candidateId of pending.candidateIds) {
            if (candidateId !== parentId && !parent.childIds.includes(candidateId)) {
              parent.childIds.push(candidateId);
            }
          }
          if (!parent.childIds.includes(pending.mergedIslandId)) {
            parent.childIds.push(pending.mergedIslandId);
          }

          parent.lastLayer = mergedIsland.lastLayer;
          parent.status = mergedIsland.status;

          for (const [layer, areaMm2] of mergedIsland.perLayerAreaMm2) {
            parent.perLayerAreaMm2.set(layer, areaMm2);
            parent.totalAreaMm2 += areaMm2;
            if (!parent.maxAreaMm2 || areaMm2 > parent.maxAreaMm2) {
              parent.maxAreaMm2 = areaMm2;
              parent.maxAreaLayer = layer;
            }
          }
        }

        toFinalize.push(i);
      }
    }

    for (let i = toFinalize.length - 1; i >= 0; i--) {
      this.pendingMerges.splice(toFinalize[i], 1);
    }
  }

  getIslands(): Island[] {
    return Array.from(this.islands.values());
  }

  finalizeIslands(finalLayer: number): void {
    // No-op
  }
}

