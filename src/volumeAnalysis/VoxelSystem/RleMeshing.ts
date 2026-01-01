
import * as THREE from 'three';
import type { RleLabels } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';

// Safe limit for indices per mesh.
const MAX_INDICES = 20_000_000;
// const MAX_INDICES = 20_000_000; // Removed as part of optimization

/**
 * Generates a greedy mesh directly from RLE data.
 * This skips the expensive Voxel -> Map -> Mesh pipeline.
 * Complexity: O(RLE Segments) instead of O(Voxels).
 */
// Greedy Meshing with Optimizations:
// 1. Hoisted Neighbor Lookups (O(N) vs O(N^2))
// 2. Typed Arrays for buffering (Zero GC)
export function generateMeshFromRLE(
    islandId: number,
    labelsPerLayer: (RleLabels | null)[],
    grid: { width: number; height: number; px_mm: number; originX: number; originZ: number; },
    layerHeightMm: number,
    zOffset: number,
    startLayer: number,
    endLayer: number
): THREE.BufferGeometry[] {

    const geometries: THREE.BufferGeometry[] = [];

    // Buffer Config
    const CHUNK_SIZE = 600_000; // Vertices per chunk. 600k * 3 floats = 7.2MB. Safe for Browser.
    // 400k vertices ~ 100k quads.

    let positionBuffer = new Float32Array(CHUNK_SIZE * 3);
    let indexBuffer = new Uint32Array(CHUNK_SIZE * 1.5); // 6 indices per 4 verts = 1.5x
    let vertexCount = 0;
    let indexCount = 0;

    const { px_mm, width, height, originX, originZ } = grid;
    const halfSize = px_mm / 2;
    const halfHeight = layerHeightMm / 2;

    // Y-direction is negated in original visualizer: -(originZ + row * px_mm - offset)
    // We'll stick to that logic.
    // originZ + row*px_mm is "World Z" in Scan terms, which maps to "World Y" in THREE.js terms usually.
    // Let's replicate the exact coordinate logic from IslandVoxelVisualization.tsx:
    // const worldX = originX + col * px_mm + px_mm * VOXEL_OFFSET_X;
    // const worldY = -(originZ + row * px_mm - px_mm * VOXEL_OFFSET_Y);
    // const layerZ = zOffset + layer * layerHeightMm + layerHeightMm * VOXEL_OFFSET_Z;
    // We assume offsets are 0.0 or handled elsewhere for simplicity if passed in grid?
    // The original code had VOXEL_OFFSET_X/Y/Z imported.
    const VOXEL_OFFSET_X = 0; // Assuming 0 for now or passed in?
    const VOXEL_OFFSET_Y = 0;
    const VOXEL_OFFSET_Z = 0;

    const commitGeometry = () => {
        if (vertexCount === 0) return;
        const geometry = new THREE.BufferGeometry();
        // Copy used portion of buffer
        geometry.setAttribute('position', new THREE.BufferAttribute(positionBuffer.slice(0, vertexCount * 3), 3));
        geometry.setIndex(new THREE.BufferAttribute(indexBuffer.slice(0, indexCount), 1));
        geometry.computeVertexNormals();
        geometries.push(geometry);

        // Reset counters (buffers are reused by overwriting, but we need fresh slice logic? 
        // No, 'slice' copies. We can reuse the big buffers for next chunk.)
        // But slice is expensive-ish.
        // Better: create buffer attribute from VIEW if possible? No, we need distinct geometries usually.
        // Fast slice is fine.
        vertexCount = 0;
        indexCount = 0;
    };

    const checkFlush = () => {
        // flush if near limit (need 4 verts = 12 floats, 6 indices)
        // using 20k margin for safety
        if (vertexCount + 100 >= CHUNK_SIZE) {
            commitGeometry();
        }
    }

    const addQuad = (v0: number[], v1: number[], v2: number[], v3: number[]) => {
        checkFlush();

        // Vertices
        const vBase = vertexCount * 3;
        positionBuffer[vBase + 0] = v0[0]; positionBuffer[vBase + 1] = v0[1]; positionBuffer[vBase + 2] = v0[2];
        positionBuffer[vBase + 3] = v1[0]; positionBuffer[vBase + 4] = v1[1]; positionBuffer[vBase + 5] = v1[2];
        positionBuffer[vBase + 6] = v2[0]; positionBuffer[vBase + 7] = v2[1]; positionBuffer[vBase + 8] = v2[2];
        positionBuffer[vBase + 9] = v3[0]; positionBuffer[vBase + 10] = v3[1]; positionBuffer[vBase + 11] = v3[2];

        // Indices
        const iBase = indexCount;
        const vc = vertexCount;
        indexBuffer[iBase + 0] = vc;
        indexBuffer[iBase + 1] = vc + 1;
        indexBuffer[iBase + 2] = vc + 2;
        indexBuffer[iBase + 3] = vc;
        indexBuffer[iBase + 4] = vc + 2;
        indexBuffer[iBase + 5] = vc + 3;

        vertexCount += 4;
        indexCount += 6;
    };

    // Helper: Iterate RLE segments for a specific layer
    const forEachSegment = (layerIdx: number, callback: (row: number, start: number, len: number) => void) => {
        const layer = labelsPerLayer[layerIdx];
        if (!layer) return;
        for (let y = 0; y < layer.height; y++) {
            const rowData = layer.rows[y];
            if (!rowData) continue; // Should be empty iter but safety check
            for (let i = 0; i < rowData.length; i += 3) {
                const start = rowData[i];
                const len = rowData[i + 1];
                const id = rowData[i + 2];
                if (id === islandId) {
                    callback(y, start, len);
                }
            }
        }
    }

    // Checking neighbors involves intersecting ranges.
    // To check if a segment [start, start+len] in (layer, row) is exposed:
    // We check overlap with neighbors in (layer+/-1, row) or (layer, row+/-1).
    // An efficient way is to iterate neighbors' segments and subtract them from current segment.
    // Whatever remains is Exposed.

    // However, subtracting ranges is complex.
    // A simpler greedy approach:
    // For Top/Bottom/Front/Back, we can rely on the fact that if RLE is consistent, subtraction is easy.
    // Actually, simply iterating pixels in the RLE segment is O(N) again for checking.
    // BUT we iterate 1D pixels, not 3D neighbors (map lookup). Key difference.
    // 
    // Optimization: Check entire segment against neighbor segments.
    // Find all neighbor segments that overlap [start, end].
    // If they cover the entire range, no face.
    // If gaps, render faces for gaps.

    const getSegments = (layerIdx: number, rowIdx: number): { start: number, end: number }[] => {
        const segs: { start: number, end: number }[] = [];
        if (layerIdx < 0 || layerIdx >= labelsPerLayer.length) return segs;
        const layer = labelsPerLayer[layerIdx];
        if (!layer) return segs;
        if (rowIdx < 0 || rowIdx >= layer.height) return segs;

        const rowData = layer.rows[rowIdx];
        if (!rowData) return segs; // Added safety check for rowData
        for (let i = 0; i < rowData.length; i += 3) {
            const s = rowData[i];
            const l = rowData[i + 1];
            const id = rowData[i + 2];
            if (id === islandId) segs.push({ start: s, end: s + l });
        }
        return segs;
    };

    // Returns list of ranges [start, end] inside [queryStart, queryEnd] that are NOT covered by neighbors
    const computeExposedRanges = (queryStart: number, queryEnd: number, neighbors: { start: number, end: number }[]): { start: number, end: number }[] => {
        let exposed: { start: number, end: number }[] = [{ start: queryStart, end: queryEnd }];

        for (const neighbor of neighbors) {
            const nextExposed: { start: number, end: number }[] = [];
            for (const range of exposed) {
                // Intersect range with neighbor
                // Case 1: No overlap
                if (neighbor.end <= range.start || neighbor.start >= range.end) {
                    nextExposed.push(range);
                    continue;
                }

                // Case 2: Overlap. Cut neighbor out of range.
                // Left part?
                if (neighbor.start > range.start) {
                    nextExposed.push({ start: range.start, end: neighbor.start });
                }
                // Right part?
                if (neighbor.end < range.end) {
                    nextExposed.push({ start: neighbor.end, end: range.end });
                }
            }
            exposed = nextExposed;
            if (exposed.length === 0) break;
        }
        return exposed;
    };

    for (let l = startLayer; l <= endLayer; l++) {
        const layerZ = zOffset + l * layerHeightMm; // Center Z of layer? No, existing code used layerZ as center usually?
        // Existing: z + halfHeight is top.

        // Group segments by row for this layer
        const currentSegmentsByRow: { [row: number]: { start: number, end: number }[] } = {};

        forEachSegment(l, (y, start, len) => {
            if (!currentSegmentsByRow[y]) currentSegmentsByRow[y] = [];
            currentSegmentsByRow[y].push({ start, end: start + len });
        });

        // Loop over rows that HAVE segments
        for (const strY in currentSegmentsByRow) {
            const y = parseInt(strY);
            const segments = currentSegmentsByRow[y];

            // OPTIMIZATION: Fetch neighbor rows ONCE per row, not per segment
            const frontNeighbors = getSegments(l, y - 1); // Front (+Y visualizer logic)
            const backNeighbors = getSegments(l, y + 1);  // Back (-Y visualizer logic)
            const topNeighbors = getSegments(l + 1, y);   // Top (+Z)
            const bottomNeighbors = getSegments(l - 1, y);// Bottom (-Z)

            for (const seg of segments) {
                const { start, end } = seg;
                // const len = end - start; // Not used

                // --- X FACES (Left/Right) ---
                // Left: simple check if start-1 is in same row's segments
                // Since segments are sorted and non-overlapping in RLE:
                // We just need to check if previous segment ends at start.
                // Actually, if it's the SAME island, it would be merged in RLE? 
                // Scanline usually merges same-ID segments.
                // If so, Left and Right are ALWAYS exposed!
                // Unless we support multiple colors per island? No.
                // So Left and Right of RLE segment are always surfaces.

                // Left Face (-X)
                {
                    const col = start;
                    const wx = originX + col * px_mm;
                    const wy = -(originZ + y * px_mm); // Center Y

                    // const v0 = [wx, wy - halfSize, layerZ - halfHeight]; // Not used
                    // const v1 = [wx, wy + halfSize, layerZ - halfHeight]; // Not used
                    // const v2 = [wx, wy + halfSize, layerZ + halfHeight]; // Not used
                    // const v3 = [wx, wy - halfSize, layerZ + halfHeight]; // Not used

                    // Normal (-1, 0, 0)
                    // v0 (bottom-left), v1 (top-left), v2 (top-right), v3 (bottom-right)?
                    // Standard quad order: BL, TL, TR, BR?
                    // Let's use logic from visualizer:
                    // v0 = [x-h, y-h, z-h]
                    // v1 = [x-h, y+h, z-h] ...
                    // Wait, X is variable here. Left face is at x - halfSize.
                    // For RLE start, x is center of pixel 'start'.
                    // Left edge is at x - halfSize.

                    // Correct coords for Left Face:
                    const lx = wx - halfSize; // Left edge
                    const by = wy - halfSize; // Bottom (-Y)
                    const ty = wy + halfSize; // Top (+Y)
                    const bz = layerZ - halfHeight; // Bottom (-Z)
                    const tz = layerZ + halfHeight; // Top (+Z)

                    // check visualizer: v0, v1, v2, v3
                    // v0 = [x-h, y-h, z-h]
                    // v1 = [x-h, y+h, z-h]
                    // v2 = [x-h, y+h, z+h]
                    // v3 = [x-h, y-h, z+h]
                    addQuad([lx, by, bz], [lx, by, tz], [lx, ty, tz], [lx, ty, bz]);
                }

                // Right Face (+X)
                {
                    const col = end - 1; // Last pixel index
                    const wx = originX + col * px_mm;
                    const wy = -(originZ + y * px_mm);
                    const rx = wx + halfSize; // Right edge
                    const by = wy - halfSize;
                    const ty = wy + halfSize;
                    const bz = layerZ - halfHeight;
                    const tz = layerZ + halfHeight;

                    // v0 = [x+h, y-h, z-h]
                    // v1 = [x+h, y-h, z+h] (Wait, visualizer order?)
                    // Right face visualizer:
                    // v0 = [x+h, y-h, z-h]
                    // v1 = [x+h, y-h, z+h]
                    // v2 = [x+h, y+h, z+h]
                    // v3 = [x+h, y+h, z-h]
                    // My quad expects CCW?
                    addQuad([rx, by, bz], [rx, ty, bz], [rx, ty, tz], [rx, by, tz]);
                }

                // --- Y FACES (Front/Back) ---
                // Front (+Y): Row y+1? Or y-1?
                // Visualizer: Front (+Y) is y + voxelSize. originZ is top-left usually? 
                // Wy = -(originZ + row). So +Row is -Y.
                // Visualizer: "Front Face (+Y)" checks `y + voxelSize`. 
                // If Wy decreases as Row increases, then +Y is Row-1.
                // Let's stick to visualizer logic:
                // Front (+Y) -> Check neighbors.
                // If Wy = -originZ - row*px.
                // +Y refers to smaller row index (y-1).

                // Front (+Y) - Neighbor is row y-1
                {
                    const exposed = computeExposedRanges(start, end, frontNeighbors);
                    for (const r of exposed) {
                        // r.start to r.end are exposed pixels.
                        // Generate a single quad for this strip.
                        // const len = r.end - r.start; // Not used
                        const startCol = r.start;
                        const endCol = r.end - 1;

                        // X coords
                        const x1 = (originX + startCol * px_mm) - halfSize;
                        const x2 = (originX + endCol * px_mm) + halfSize;

                        // Y coord (Front face is 'Top' of pixel in Y)
                        // wy = -(originZ + y...)
                        // Front (+Y side) is wy + halfSize.
                        const wy = -(originZ + y * px_mm);
                        const fy = wy + halfSize;

                        const bz = layerZ - halfHeight;
                        const tz = layerZ + halfHeight;

                        // Visualizer Front (+Y):
                        // v0 = [x-h, y+h, z-h]
                        // v1 = [x+h, y+h, z-h]
                        // v2 = [x+h, y+h, z+h]
                        // v3 = [x-h, y+h, z+h]
                        addQuad([x1, fy, bz], [x1, fy, tz], [x2, fy, tz], [x2, fy, bz]);
                    }
                }

                // Back (-Y) - Neighbor is row y+1
                {
                    const exposed = computeExposedRanges(start, end, backNeighbors);
                    for (const r of exposed) {
                        const startCol = r.start;
                        const endCol = r.end - 1;

                        const x1 = (originX + startCol * px_mm) - halfSize;
                        const x2 = (originX + endCol * px_mm) + halfSize;

                        const wy = -(originZ + y * px_mm);
                        const by = wy - halfSize; // Back (-Y side)

                        const bz = layerZ - halfHeight;
                        const tz = layerZ + halfHeight;

                        // Visualizer Back (-Y):
                        // v0 = [x-h, y-h, z-h]
                        // v1 = [x-h, y-h, z+h]
                        // v2 = [x+h, y-h, z+h]
                        // v3 = [x+h, y-h, z-h]
                        addQuad([x1, by, bz], [x2, by, bz], [x2, by, tz], [x1, by, tz]);
                    }
                }

                // --- Z FACES (Top/Bottom) ---

                // Top (+Z) - Neighbor is layer l+1
                {
                    const exposed = computeExposedRanges(start, end, topNeighbors);
                    for (const r of exposed) {
                        const startCol = r.start;
                        const endCol = r.end - 1;

                        const x1 = (originX + startCol * px_mm) - halfSize;
                        const x2 = (originX + endCol * px_mm) + halfSize;

                        const wy = -(originZ + y * px_mm);
                        const by = wy - halfSize;
                        const ty = wy + halfSize;

                        const tz = layerZ + halfHeight; // Top face Z

                        // Visualizer Top (+Z):
                        // v0 = [x-h, y-h, z+h]
                        // v1 = [x-h, y+h, z+h]
                        // v2 = [x+h, y+h, z+h]
                        // v3 = [x+h, y-h, z+h]
                        addQuad([x1, by, tz], [x2, by, tz], [x2, ty, tz], [x1, ty, tz]);
                    }
                }

                // Bottom (-Z) - Neighbor is layer l-1
                {
                    const exposed = computeExposedRanges(start, end, bottomNeighbors);
                    for (const r of exposed) {
                        const startCol = r.start;
                        const endCol = r.end - 1;

                        const x1 = (originX + startCol * px_mm) - halfSize;
                        const x2 = (originX + endCol * px_mm) + halfSize;

                        const wy = -(originZ + y * px_mm);
                        const by = wy - halfSize;
                        const ty = wy + halfSize;

                        const bz = layerZ - halfHeight; // Bottom face Z

                        // Visualizer Bottom (-Z):
                        // v0 = [x-h, y-h, z-h]
                        // v1 = [x+h, y-h, z-h]
                        // v2 = [x+h, y+h, z-h]
                        // v3 = [x-h, y+h, z-h]
                        addQuad([x1, by, bz], [x1, ty, bz], [x2, ty, bz], [x2, by, bz]);
                    }
                }

            }
        }
    }

    commitGeometry();
    return geometries;
}
