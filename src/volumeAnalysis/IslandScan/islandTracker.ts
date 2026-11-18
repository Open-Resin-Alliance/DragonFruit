import { type Island, type ComponentInfo } from './types';
import { type RleMask, type RleLabels, type RleRow, rleLabelComponents } from './rle';

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

export type IslandTrackerOptions = {
  minOverlapPx?: number;
  overlapNeighborhoodPx?: number;
  radiusPx?: number;
  connectivity?: 4 | 8;
};

export class IslandTracker {
  private islands: Map<number, Island> = new Map();
  private nextId: number = 1;
  private px_mm: number;
  private minOverlapPx: number;
  private overlapNeighborhoodPx: number;
  private connectivity: 4 | 8;
  private pendingMerges: PendingMerge[] = [];
  private groundedIslands: Set<number> = new Set();
  private readonly MERGE_EVAL_WINDOW = 30; // Layers to wait before finalizing parent

  constructor(
    px_mm: number,
    options?: IslandTrackerOptions
  ) {
    this.px_mm = px_mm;
    this.minOverlapPx = Math.max(1, options?.minOverlapPx ?? 1);
    this.overlapNeighborhoodPx = Math.max(0, options?.overlapNeighborhoodPx ?? options?.radiusPx ?? 1);
    this.connectivity = options?.connectivity ?? 8;
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
        const assignedId = this.createNewIsland(layerIndex, areaMm2, comp);
        if (layerIndex === 0) {
          this.groundedIslands.add(assignedId);
        }
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
      const { labels: solidLabels, components: solidComps } = this.rleLabelSolidComponents(solidMask);
      const solidRowSpans = this.rowSpansByComponent(solidLabels);

      const activeAtLayerStart = new Set<number>();
      for (const [id, island] of this.islands) {
        if (island.status === 'active') {
          activeAtLayerStart.add(id);
        }
      }

      type SolidCompInput = {
        compIdx: number;
        areaMm2: number;
        prevIds: Set<number>;
        activePrevIds: Set<number>;
      };

      const compInputs: SolidCompInput[] = [];
      for (let compIdx = 0; compIdx < solidComps.length; compIdx++) {
        const component = solidComps[compIdx];
        const prevIdOverlapCounts = this.findOverlappingIslandIdsRle(
          component.id,
          solidLabels,
          prevIslandLabels,
          solidRowSpans.get(component.id)
        );

        const prevIds = new Set<number>();
        for (const [id, count] of prevIdOverlapCounts) {
          if (count >= this.minOverlapPx) {
            prevIds.add(id);
          }
        }

        // Filter for active islands (resolving finalized placeholders / indirect chains)
        const activePrevIds = new Set<number>();
        for (const id of prevIds) {
          const resolved = this.resolveParent(id);
          if (activeAtLayerStart.has(resolved)) {
            activePrevIds.add(id);
          }
        }

        const areaMm2 = component.area_px * this.px_mm * this.px_mm;
        compInputs.push({ compIdx, areaMm2, prevIds, activePrevIds });
      }

      const solidCompIdToIslandId = new Map<number, number>();
      const updatedThisLayer = new Set<number>();

      // Fixpoint pre-flush: finalize any open PendingMerge participating in a genuine multi-target merge
      while (true) {
        const toFlush = new Set<number>();
        for (const input of compInputs) {
          if (input.activePrevIds.size >= 2) {
            const resolved = new Set<number>();
            for (const id of input.activePrevIds) {
              resolved.add(this.resolveParent(id));
            }
            if (resolved.size >= 2) {
              for (const pending of this.pendingMerges) {
                if (resolved.has(pending.mergedIslandId)) {
                  toFlush.add(pending.mergedIslandId);
                }
              }
            }
          }
        }
        if (toFlush.size === 0) break;

        for (let i = 0; i < this.pendingMerges.length; ) {
          if (toFlush.has(this.pendingMerges[i].mergedIslandId)) {
            const [flushed] = this.pendingMerges.splice(i, 1);
            const mergedId = flushed.mergedIslandId;
            const parentId = this.finalizePendingMerge(flushed);
            if (activeAtLayerStart.has(mergedId)) {
              activeAtLayerStart.add(parentId);
            }
            if (updatedThisLayer.has(mergedId)) {
              updatedThisLayer.add(parentId);
            }
          } else {
            i++;
          }
        }
      }

      // Pass 1: create new islands immediately; classify continuations vs merges
      const continuations: Array<{ compIdx: number; target: number; areaMm2: number }> = [];
      const merges: Array<{ compIdx: number; resolved: Set<number>; areaMm2: number }> = [];

      for (const input of compInputs) {
        const component = solidComps[input.compIdx];
        if (input.activePrevIds.size === 0) {
          if (input.prevIds.size === 0) {
            const assignedId = this.createNewIsland(layerIndex, input.areaMm2, component);
            updatedThisLayer.add(assignedId);
            solidCompIdToIslandId.set(component.id, assignedId);
          } else {
            let firstPrevId = Infinity;
            for (const id of input.prevIds) {
              if (id < firstPrevId) firstPrevId = id;
            }
            const target = this.resolveParent(firstPrevId);
            continuations.push({ compIdx: input.compIdx, target, areaMm2: input.areaMm2 });
          }
        } else {
          const resolved = new Set<number>();
          for (const id of input.activePrevIds) {
            resolved.add(this.resolveParent(id));
          }
          if (resolved.size === 1) {
            const target = resolved.values().next().value as number;
            continuations.push({ compIdx: input.compIdx, target, areaMm2: input.areaMm2 });
          } else {
            merges.push({ compIdx: input.compIdx, resolved, areaMm2: input.areaMm2 });
          }
        }
      }

      // Pass 2a: execute ALL continuations first
      for (const cont of continuations) {
        const component = solidComps[cont.compIdx];
        this.updateIsland(cont.target, layerIndex, cont.areaMm2, component);
        updatedThisLayer.add(cont.target);
        solidCompIdToIslandId.set(component.id, cont.target);
      }

      // Pass 2b: execute merges (preserving islands updated on this layer)
      for (const merge of merges) {
        const component = solidComps[merge.compIdx];
        let resolved = new Set<number>();
        for (const id of merge.resolved) {
          resolved.add(this.resolveParent(id));
        }

        if (resolved.size >= 2) {
          while (true) {
            const toFlush = new Set<number>();
            for (const pending of this.pendingMerges) {
              if (resolved.has(pending.mergedIslandId)) {
                toFlush.add(pending.mergedIslandId);
              }
            }
            if (toFlush.size === 0) break;

            for (let i = 0; i < this.pendingMerges.length; ) {
              if (toFlush.has(this.pendingMerges[i].mergedIslandId)) {
                const [flushed] = this.pendingMerges.splice(i, 1);
                for (const comp of solidComps) {
                  const overlaps = this.findOverlappingIslandIdsRle(
                    comp.id,
                    solidLabels,
                    flushed.preMergeLabels,
                    solidRowSpans.get(comp.id)
                  );
                  for (const [id, count] of overlaps) {
                    if (!flushed.overlapCounts.has(id)) continue;
                    flushed.overlapCounts.set(id, (flushed.overlapCounts.get(id) ?? 0) + count);
                  }
                }
                const mergedId = flushed.mergedIslandId;
                const parentId = this.finalizePendingMerge(flushed);
                if (updatedThisLayer.has(mergedId)) {
                  updatedThisLayer.add(parentId);
                }
                for (const [cid, mappedId] of solidCompIdToIslandId) {
                  if (mappedId === mergedId) {
                    solidCompIdToIslandId.set(cid, parentId);
                  }
                }
              } else {
                i++;
              }
            }

            const nextResolved = new Set<number>();
            for (const id of resolved) {
              nextResolved.add(this.resolveParent(id));
            }
            resolved = nextResolved;
            if (resolved.size < 2) break;
          }
        }

        let assignedId: number;
        if (resolved.size === 1) {
          assignedId = resolved.values().next().value as number;
          this.updateIsland(assignedId, layerIndex, merge.areaMm2, component);
          updatedThisLayer.add(assignedId);
        } else {
          const sortedResolved = Array.from(resolved).sort((a, b) => a - b);
          const grounded: number[] = [];
          const ungrounded: number[] = [];
          for (const id of sortedResolved) {
            if (this.groundedIslands.has(id)) {
              grounded.push(id);
            } else {
              ungrounded.push(id);
            }
          }

          if (grounded.length === 1) {
            const gp = grounded[0];
            const gpIsland = this.islands.get(gp);
            for (const uid of ungrounded) {
              const uIsland = this.islands.get(uid);
              if (uIsland) {
                uIsland.parentId = gp;
                if (!updatedThisLayer.has(uid) && !uIsland.perLayerAreaMm2.has(layerIndex)) {
                  uIsland.status = 'complete';
                  if (layerIndex > 0) {
                    uIsland.lastLayer = layerIndex - 1;
                  }
                }
              }
              if (gpIsland && !gpIsland.childIds.includes(uid)) {
                gpIsland.childIds.push(uid);
              }
            }
            assignedId = gp;
            this.updateIsland(gp, layerIndex, merge.areaMm2, component);
            updatedThisLayer.add(gp);
          } else if (grounded.length >= 2) {
            assignedId = this.mergeIslands(
              layerIndex,
              new Set(grounded),
              prevIslandLabels,
              merge.areaMm2,
              component,
              updatedThisLayer
            );
            this.groundedIslands.add(assignedId);
            updatedThisLayer.add(assignedId);
            const mergedIsland = this.islands.get(assignedId);
            for (const uid of ungrounded) {
              const uIsland = this.islands.get(uid);
              if (uIsland) {
                uIsland.parentId = assignedId;
                if (!updatedThisLayer.has(uid) && !uIsland.perLayerAreaMm2.has(layerIndex)) {
                  uIsland.status = 'complete';
                  if (layerIndex > 0) {
                    uIsland.lastLayer = layerIndex - 1;
                  }
                }
              }
              if (mergedIsland && !mergedIsland.childIds.includes(uid)) {
                mergedIsland.childIds.push(uid);
              }
            }
          } else {
            assignedId = this.mergeIslands(
              layerIndex,
              resolved,
              prevIslandLabels,
              merge.areaMm2,
              component,
              updatedThisLayer
            );
            updatedThisLayer.add(assignedId);
          }
        }

        solidCompIdToIslandId.set(component.id, assignedId);
      }

      // Track overlaps for pending merges after all component assignments
      for (const component of solidComps) {
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
    return rleLabelComponents(solidMask, this.connectivity);
  }

  /**
   * Find which previous island IDs overlap with a specific solid component.
   */
  /**
   * Rows spanned by each component label, in one pass over the RLE.
   *
   * Without it {@link findOverlappingIslandIdsRle} walks every row of the layer
   * for every component, so a layer with C components costs C full-image scans
   * even though each component usually occupies a handful of rows.
   */
  private rowSpansByComponent(solidLabels: RleLabels): Map<number, { minY: number; maxY: number }> {
    const spans = new Map<number, { minY: number; maxY: number }>();
    for (let y = 0; y < solidLabels.height; y++) {
      const row = solidLabels.rows[y];
      for (let i = 0; i < row.length; i += 3) {
        const id = row[i + 2];
        const span = spans.get(id);
        if (span) {
          span.maxY = y;
        } else {
          spans.set(id, { minY: y, maxY: y });
        }
      }
    }
    return spans;
  }

  private findOverlappingIslandIdsRle(
    compId: number,
    solidLabels: RleLabels,
    prevIslandLabels: RleLabels,
    rowSpan?: { minY: number; maxY: number },
  ): Map<number, number> {
    const prevIdOverlapCounts = new Map<number, number>();
    const { height } = solidLabels;

    // Only the rows this component actually occupies; the whole layer when the
    // span is unknown.
    const firstRow = rowSpan ? rowSpan.minY : 0;
    const lastRow = rowSpan ? rowSpan.maxY : height - 1;

    for (let y = firstRow; y <= lastRow; y++) {
      const solidRow = solidLabels.rows[y];

      if (solidRow.length === 0) continue;

      // Find runs belonging to compId
      for (let i = 0; i < solidRow.length; i += 3) {
        if (solidRow[i + 2] !== compId) continue;

        const start = solidRow[i];
        const len = solidRow[i + 1];
        const end = start + len;

        const r = Number.isNaN(this.overlapNeighborhoodPx)
          ? 0
          : Math.max(0, Math.trunc(this.overlapNeighborhoodPx));
        const rSq = r * r;
        const yStart = Math.max(0, y - r);
        const yEnd = Math.min(prevIslandLabels.height - 1, y + r);

        for (let py = yStart; py <= yEnd; py++) {
          const pRow = prevIslandLabels.rows[py];
          if (!pRow || pRow.length === 0) continue;

          const dy = py - y;
          const dx = Math.floor(Math.sqrt(rSq - dy * dy));
          const searchStart = start - dx;
          const searchEnd = end + dx;

          for (let j = 0; j < pRow.length; j += 3) {
            const pStart = pRow[j];
            const pLen = pRow[j + 1];
            const pId = pRow[j + 2];
            const pEnd = pStart + pLen;

            const overlapStart = Math.max(searchStart, pStart);
            const overlapEnd = Math.min(searchEnd, pEnd);

            if (overlapStart < overlapEnd && pId > 0) {
              const overlapPx = overlapEnd - overlapStart;
              prevIdOverlapCounts.set(pId, (prevIdOverlapCounts.get(pId) ?? 0) + overlapPx);
            }

            if (pStart >= searchEnd) break;
          }
        }
      }
    }

    return prevIdOverlapCounts;
  }

  private trackPendingMergeOverlapsRle(
    layerIndex: number,
    compId: number,
    solidLabels: RleLabels,
    prevIslandLabels: RleLabels
  ): void {
    if (this.pendingMerges.length === 0) return;

    for (const pending of this.pendingMerges) {
      if (layerIndex < pending.mergeLayer) continue;

      const overlapCounts = this.findOverlappingIslandIdsRle(
        compId,
        solidLabels,
        pending.preMergeLabels
      );

      for (const [id, count] of overlapCounts) {
        if (!pending.overlapCounts.has(id)) continue;
        pending.overlapCounts.set(id, (pending.overlapCounts.get(id) ?? 0) + count);
      }
    }
  }

  // ... rest of class ...

  // Helper to create new island
  private createNewIsland(layerIndex: number, areaMm2: number, comp?: ComponentInfo): number {
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
      // Centroid initialization
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

    if (comp && (typeof comp.centroidSumX !== 'number' || typeof comp.centroidSumY !== 'number')) {
      console.warn(`IslandTracker: Component ${comp.id} at layer ${layerIndex} missing centroid sums!`);
    }

    this.islands.set(id, island);
    return id;
  }

  private resolveParent(startId: number): number {
    let currentId = startId;
    const visited = new Set<number>();
    while (true) {
      if (visited.has(currentId)) break; // Cycle protection
      visited.add(currentId);
      const isl = this.islands.get(currentId);
      if (!isl || isl.parentId === undefined) break;
      currentId = isl.parentId;
    }
    return currentId;
  }

  private updateIsland(id: number, layerIndex: number, areaMm2: number, comp?: ComponentInfo): void {
    const island = this.islands.get(id);
    if (!island) return;

    island.lastLayer = Math.max(island.lastLayer, layerIndex);
    island.totalAreaMm2 += areaMm2;
    const layerArea = (island.perLayerAreaMm2.get(layerIndex) ?? 0) + areaMm2;
    island.perLayerAreaMm2.set(layerIndex, layerArea);

    if (island.maxAreaMm2 === undefined || layerArea > island.maxAreaMm2) {
      island.maxAreaMm2 = layerArea;
      island.maxAreaLayer = layerIndex;
    }

    if (comp) {
      if (typeof comp.centroidSumX === 'number' && typeof comp.centroidSumY === 'number') {
        island.centroidSumX += comp.centroidSumX;
        island.centroidSumY += comp.centroidSumY;
      } else {
        console.warn(`IslandTracker: Update Component ${comp.id} at layer ${layerIndex} missing centroid sums!`);
      }
      island.centroidSumZ += comp.size * layerIndex;
      island.centroidCount += comp.size;

      // Update Terminal Centroid (Last Active Layer Centroid)
      if (comp.size > 0) {
        island.lastLayerCentroid = {
          x: comp.centroidSumX / comp.size,
          y: comp.centroidSumY / comp.size,
          z: layerIndex
        };
      }
    }
  }

  private mergeIslands(
    layerIndex: number,
    prevIds: Set<number>,
    prevIslandLabels: RleLabels,
    areaMm2: number,
    comp: ComponentInfo | undefined,
    updatedThisLayer: Set<number>
  ): number {
    // Deep copy pre-merge labels, remapping any finalized/parented IDs to current roots
    const preMergeLabels: RleLabels = {
      width: prevIslandLabels.width,
      height: prevIslandLabels.height,
      rows: prevIslandLabels.rows.map(row => {
        const copy = new Int32Array(row.length);
        for (let i = 0; i < row.length; i += 3) {
          copy[i] = row[i];
          copy[i + 1] = row[i + 1];
          const rawId = row[i + 2];
          copy[i + 2] = rawId > 0 ? this.resolveParent(rawId) : rawId;
        }
        return copy;
      })
    };

    // Mark merging islands as complete (unless already updated on this layer)
    for (const id of prevIds) {
      if (updatedThisLayer.has(id)) continue;
      const island = this.islands.get(id);
      if (island) {
        if (island.perLayerAreaMm2.has(layerIndex)) continue;
        island.status = 'complete';
        if (layerIndex > 0) {
          island.lastLayer = layerIndex - 1;
        }
      }
    }

    // New merged island starts fresh with component stats
    const mergedId = this.createNewIsland(layerIndex, areaMm2, comp);
    const mergedIsland = this.islands.get(mergedId);
    if (mergedIsland) mergedIsland.isMergedPlaceholder = true;

    const pending: PendingMerge = {
      mergeLayer: layerIndex,
      candidateIds: Array.from(prevIds).sort((a, b) => a - b),
      mergedIslandId: mergedId,
      overlapCounts: new Map(),
      preMergeLabels: preMergeLabels,
    };

    for (const id of prevIds) pending.overlapCounts.set(id, 0);

    this.pendingMerges.push(pending);
    return mergedId;
  }

  private finalizePendingMerge(pending: PendingMerge): number {
    const resolvedCounts = new Map<number, number>();
    for (const [rawId, count] of pending.overlapCounts) {
      const resolved = this.resolveParent(rawId);
      const isl = this.islands.get(resolved);
      if (isl && !isl.isMergedPlaceholder) {
        resolvedCounts.set(resolved, (resolvedCounts.get(resolved) ?? 0) + count);
      }
    }

    let hasGrounded = false;
    for (const id of resolvedCounts.keys()) {
      if (this.groundedIslands.has(id)) {
        hasGrounded = true;
        break;
      }
    }

    let parentId = 0;
    let maxOverlap = -1;
    for (const [id, count] of resolvedCounts) {
      if (hasGrounded && !this.groundedIslands.has(id)) continue;
      if (count > maxOverlap || (count === maxOverlap && id < parentId)) {
        maxOverlap = count;
        parentId = id;
      }
    }

    if (parentId === 0) {
      for (const cid of pending.candidateIds) {
        const resolved = this.resolveParent(cid);
        const isl = this.islands.get(resolved);
        if (isl && !isl.isMergedPlaceholder) {
          parentId = resolved;
          break;
        }
      }
    }

    // Update candidate relationships
    for (const candidateId of pending.candidateIds) {
      if (candidateId !== parentId) {
        const child = this.islands.get(candidateId);
        if (child) child.parentId = parentId;
      }
    }

    // Reparent any existing islands whose parent was the merged placeholder
    for (const island of this.islands.values()) {
      if (island.parentId === pending.mergedIslandId && island.id !== parentId) {
        island.parentId = parentId;
      }
    }

    const mergedIsland = this.islands.get(pending.mergedIslandId);
    const mergedWasActive = mergedIsland ? mergedIsland.status === 'active' : false;
    if (mergedIsland) {
      mergedIsland.parentId = parentId;
      mergedIsland.status = 'complete';
    }

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
      for (const childId of mergedIsland.childIds) {
        if (childId !== parentId && !parent.childIds.includes(childId)) {
          parent.childIds.push(childId);
        }
      }

      const prevParentLastLayer = parent.lastLayer;
      parent.lastLayer = Math.max(parent.lastLayer, mergedIsland.lastLayer);
      parent.status = (mergedWasActive || parent.status === 'active') ? 'active' : 'complete';

      for (const [layer, areaMm2] of mergedIsland.perLayerAreaMm2) {
        parent.lastLayer = Math.max(parent.lastLayer, layer);
        const layerArea = (parent.perLayerAreaMm2.get(layer) ?? 0) + areaMm2;
        parent.perLayerAreaMm2.set(layer, layerArea);
        parent.totalAreaMm2 += areaMm2;
        if (parent.maxAreaMm2 === undefined || layerArea > parent.maxAreaMm2) {
          parent.maxAreaMm2 = layerArea;
          parent.maxAreaLayer = layer;
        }
      }

      // Merge Centroid Data
      if (mergedIsland.centroidCount > 0) {
        parent.centroidSumX += mergedIsland.centroidSumX;
        parent.centroidSumY += mergedIsland.centroidSumY;
        parent.centroidSumZ += mergedIsland.centroidSumZ;
        parent.centroidCount += mergedIsland.centroidCount;
      }

      if (mergedIsland.lastLayer >= prevParentLastLayer && mergedIsland.lastLayerCentroid) {
        parent.lastLayerCentroid = { ...mergedIsland.lastLayerCentroid };
      }
    }

    if (
      this.groundedIslands.has(pending.mergedIslandId) ||
      pending.candidateIds.some((cid) => this.groundedIslands.has(cid))
    ) {
      this.groundedIslands.add(parentId);
    }

    return parentId;
  }

  private evaluatePendingMerges(currentLayer: number): void {
    const remaining: PendingMerge[] = [];
    for (const pending of this.pendingMerges) {
      if (currentLayer - pending.mergeLayer >= this.MERGE_EVAL_WINDOW) {
        this.finalizePendingMerge(pending);
      } else {
        remaining.push(pending);
      }
    }
    this.pendingMerges = remaining;
  }

  getIslands(): Island[] {
    const islands = Array.from(this.islands.values());
    for (const island of islands) {
      if (island.centroidCount > 0) {
        island.centroid = {
          x: island.centroidSumX / island.centroidCount,
          y: island.centroidSumY / island.centroidCount,
          z: island.centroidSumZ / island.centroidCount
        };
      }
    }
    return islands;
  }

  finalizeIslands(_finalLayer: number): void {
    const pending = this.pendingMerges;
    this.pendingMerges = [];
    for (const p of pending) {
      this.finalizePendingMerge(p);
    }
  }
}

