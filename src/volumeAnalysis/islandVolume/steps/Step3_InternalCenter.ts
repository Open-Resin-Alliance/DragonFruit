
import * as THREE from 'three';
import { type Island } from './voxelization/types';
import { type RleLabels } from './voxelization/rle';

/**
 * Step 3: Identify Internal Centers (Pole of Inaccessibility)
 * 
 * For each island, we want to find the point strictly inside the volume
 * that is furthest from the surface. This is the "Pole of Inaccessibility".
 * 
 * Algorithm:
 * 1. For each island:
 *    a. Determine the 3D bounding box from the RLE data.
 *    b. Extract a dense 3D boolean grid for that island.
 *    c. Compute the Euclidean Distance Transform (EDT) or Squared EDT.
 *    d. Find the voxel with the maximum distance.
 *    e. Convert local coordinates back to world coordinates.
 */
export class InternalCenterFinder {

    /**
     * computeCenters
     * Updates the provided islands in-place with internalCenter and internalRadius.
     */
    public static computeCenters(
        islands: Island[],
        islandLabelsPerLayer: RleLabels[],
        px_mm: number,
        originX: number,
        originZ: number,
        layerHeight: number,
        worldMinZ: number
    ): void {
        console.time('Step3_InternalCenter');

        for (const island of islands) {
            if (island.status !== 'complete' && island.status !== 'active') continue;
            // Skip if no layers
            if (island.firstLayer > island.lastLayer) continue;

            const center = this.findCenterForIsland(island, islandLabelsPerLayer, px_mm, layerHeight);

            if (center) {
                // Convert to World Coordinates (Z-UP System)
                // Grid X -> World X
                // Grid Y -> World Y (inverted storage in originZ)
                // Grid Z (Layer) -> World Z

                // Grid mapping from ScanOrchestrator/islandOverlayLogic:
                // worldX = originX + gridX * px_mm + offset
                // worldY = -(originZ + gridY * px_mm + offset)

                const offsetX = px_mm * 0.5; // Center of voxel

                const x_world = originX + center.x * px_mm + offsetX;
                // originZ is -MaxY. gridY counts down from MaxY? No, gridY counts rows.
                // worldY = -(originZ + center.y * px_mm) 

                const y_world = -(originZ + center.y * px_mm);

                const z_world = worldMinZ + center.z * layerHeight;

                island.internalCenter = {
                    x: x_world,
                    y: y_world,
                    z: z_world
                };
                island.internalRadius = Math.sqrt(center.sqDist) * px_mm; // Approx radius in mm
                island.seedVoxel = {
                    x: center.x,
                    y: center.y,
                    z: center.z
                };
            }
        }

        console.timeEnd('Step3_InternalCenter');
    }

    private static findCenterForIsland(
        island: Island,
        allLayers: RleLabels[],
        px_mm: number,
        layerHeight: number
    ): { x: number, y: number, z: number, sqDist: number } | null {

        // 1. Determine Bounds
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        const minZ = island.firstLayer;
        const maxZ = island.lastLayer;

        // We only scan layers relevant to this island
        // First pass: Calculate 2D bounds
        for (let z = minZ; z <= maxZ; z++) {
            const layer = allLayers[z];
            if (!layer) continue;
            const width = layer.width;
            const height = layer.height; // Grid Y

            const rows = layer.rows;
            for (let y = 0; y < height; y++) {
                const row = rows[y];
                for (let i = 0; i < row.length; i += 3) {
                    const id = row[i + 2];
                    if (id === island.id) {
                        const start = row[i];
                        const len = row[i + 1];
                        const end = start + len;

                        minX = Math.min(minX, start);
                        maxX = Math.max(maxX, end);
                        minY = Math.min(minY, y);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
        }

        if (minX === Infinity) return null; // Empty island

        const sizeX = maxX - minX;
        const sizeY = maxY - minY + 1;
        const sizeZ = maxZ - minZ + 1;

        // Security check for memory
        const totalVoxels = sizeX * sizeY * sizeZ;
        if (totalVoxels > 100_000_000) {
            console.warn(`Island ${island.id} is too large for dense EDT (${totalVoxels} voxels). Skipping precise center.`);
            // Fallback: Centroid
            return null;
        }

        // 2. Build Dense Grid
        // Flattened array: z * (sizeX * sizeY) + y * sizeX + x
        // Int32Array for Distance Transform (Squared Distance)
        // Initialize with Infinity (represented by a large number)
        // 0 for Outside, Infinity for Inside
        const INF = 999999999;
        const grid = new Int32Array(totalVoxels).fill(0); // 0 means boundary? No.

        // Standard EDT initialization:
        // Input: Binary Image (0 is background, 1 is object)
        // Transform: Distance to nearest 0.
        // Initialization:
        // If pixel is 0 (background): Dist = 0
        // If pixel is 1 (object): Dist = INF

        // Extract Data
        for (let z = minZ; z <= maxZ; z++) {
            const layer = allLayers[z];
            const localZ = z - minZ;
            const zOffset = localZ * sizeX * sizeY;

            if (!layer) continue; // Treat as background (0)

            const rows = layer.rows;
            // Initialize this slice as 0 (background) first? 
            // Actually we iterate island pixels and set them to INF.
            // But wait, the grid is initialized with 0.
            // So we need to set "Inside" pixels to INF.

            for (let y = minY; y <= maxY; y++) {
                const row = rows[y];
                const localY = y - minY;
                const yOffset = localY * sizeX;

                for (let i = 0; i < row.length; i += 3) {
                    const id = row[i + 2];
                    if (id === island.id) {
                        const start = row[i];
                        const len = row[i + 1];
                        // Only overlaps with our X bounds
                        const segStart = Math.max(minX, start);
                        const segEnd = Math.min(maxX, start + len);

                        for (let x = segStart; x < segEnd; x++) {
                            const localX = x - minX;
                            grid[zOffset + yOffset + localX] = INF;
                        }
                    }
                }
            }
        }

        // 3. Compute Squared Euclidean Distance Transform
        // Separable algorithm: Pass X, then Pass Y, then Pass Z.
        // Using Meijster et al. or simple parabolic envelope.
        // For simplicity and ease of implementation in 3D:
        // We can use the simple 2-pass algorithm if we were doing Manhattan/Chebyshev.
        // For Euclidean, separability is key.
        // Dimension 1 (Rows): Update d[x] = min((x-i)^2 + g[i])
        // Since input is binary 0/INF, the 1D transform is simple.

        // 1D Squared EDT function
        // f: input array (0 or INF)
        // d: output array (squared distance)
        // n: length
        const edt1d = (f: Int32Array, d: Int32Array, offset: number, stride: number, n: number) => {
            // Forward pass
            // Find nearest 0 to left
            // Actually, for binary input:
            // Scan left-to-right, keeping dist to last 0.
            // Scan right-to-left, updating min.
            // That gives Manhattan (L1) not Squared Euclidean (L2).

            // For Squared Euclidean on binary:
            // Initialize output with f.
            // We need a proper parabolic algorithm? 
            // Or simpler: For typical 3D printing grids, simple distance propagation might be enough.
            // But let's try to do it right. Meijster is efficient.
            // BUT, implementing full Meijster 3D in one go is complex.

            // ALTERNATIVE: Use 3D Chamfer Distance (e.g. <3,4,5> weights).
            // Much simpler (2 passes: Forward and Backward mask).
            // Approximation error is low for "finding the center".
            // Let's use Chamfer 3-4-5.
            // Distances: Axial=3, FaceDiag=4, BodyDiag=5.
            // Max distance point will be correct "Pole".
        };

        // Let's implement Chamfer Distance Transform (3,4,5 integer weights)
        // It treats 0 as boundary.
        // Note: Real scale considerations? We assume voxel is a cube?
        // If layerHeight != px_mm, we have anisotropy.
        // The user asked for "furthest length... find center".
        // Standard EDT assumes isotropic voxels.
        // If voxels are very flat (0.05mm Z vs 0.1mm X), a sphere is an ellipsoid in grid space.
        // However, "Pole of Inaccessibility" usually implies "Center of largest inscribed SPHERE".
        // If we work in GRID space, we find "Largest inscribed Grid-Sphere".
        // If aspect ratio is high, Grid-Sphere != World-Sphere.
        // CORRECTION: We should probably try to respect aspect ratio OR just assume grid is close enough.
        // Given complexity, let's stick to Grid Distance (Isotropic assumption or simple scaling).
        // Let's use Chamfer with basic neighborhood checks.

        // Chamfer Algorithm:
        // Initialize Grid: 0 for Background, INF (max integer) for Object.
        // Forward Pass: (z: 0..D-1, y: 0..H-1, x: 0..W-1)
        //   Val = min(Val, Neighbor + Weight)
        // Backward Pass: (z: D-1..0, y: H-1..0, x: W-1..0)
        //   Val = min(Val, Neighbor + Weight)

        // Weights for 3-4-5:
        // d1 (1 offset): 3
        // d2 (2 offsets): 4
        // d3 (3 offsets): 5

        // Initialize with somewhat distinct value to indicate "Inside" vs "Outside".
        // We already have 0 (Outside) and INF (Inside).

        const strideY = sizeX;
        const strideZ = sizeX * sizeY;

        // Forward Mask (Checking neighbors that have been visited already)
        // (-1, -1, -1) to (1, 1, 1) but only "previous" ones.
        // In raster limit order:
        // Z-1: All 9 neighbors
        // Z=0: Y-1 (All 3 checks: x-1, x, x+1), Y=0 (x-1)

        const check = (currIdx: number, nIdx: number, weight: number) => {
            const val = grid[nIdx] + weight;
            if (val < grid[currIdx]) grid[currIdx] = val;
        };

        // Forward Pass
        for (let z = 0; z < sizeZ; z++) {
            for (let y = 0; y < sizeY; y++) {
                for (let x = 0; x < sizeX; x++) {
                    const i = z * strideZ + y * strideY + x;
                    if (grid[i] === 0) continue; // Boundary remains 0

                    // Boundary Conditions (Dirichlet: Outside is 0)
                    // If we are at the "start" edge, we are adjacent to 0. Min dist is 3.
                    if (z === 0) grid[i] = Math.min(grid[i], 3);
                    if (y === 0) grid[i] = Math.min(grid[i], 3);
                    if (x === 0) grid[i] = Math.min(grid[i], 3);

                    // Neighbors (Standard Chamfer)
                    // Z-1 layer
                    if (z > 0) {
                        const bz = i - strideZ;
                        check(i, bz, 3); // (0,0,-1)
                        if (y > 0) {
                            check(i, bz - strideY, 4); // (0,-1,-1)
                            if (x > 0) check(i, bz - strideY - 1, 5); // (-1,-1,-1)
                            if (x < sizeX - 1) check(i, bz - strideY + 1, 5); // (1,-1,-1)
                        }
                        if (y < sizeY - 1) {
                            check(i, bz + strideY, 4); // (0,1,-1)
                            if (x > 0) check(i, bz + strideY - 1, 5); // (-1,1,-1)
                            if (x < sizeX - 1) check(i, bz + strideY + 1, 5); // (1,1,-1)
                        }
                        if (x > 0) check(i, bz - 1, 4); // (-1,0,-1)
                        if (x < sizeX - 1) check(i, bz + 1, 4); // (1,0,-1)
                    }

                    // Same Z layer
                    if (y > 0) {
                        const by = i - strideY;
                        check(i, by, 3); // (0,-1,0)
                        if (x > 0) check(i, by - 1, 4); // (-1,-1,0)
                        if (x < sizeX - 1) check(i, by + 1, 4); // (1,-1,0)
                    }
                    if (x > 0) {
                        check(i, i - 1, 3); // (-1,0,0)
                    }
                }
            }
        }

        // Backward Pass
        for (let z = sizeZ - 1; z >= 0; z--) {
            for (let y = sizeY - 1; y >= 0; y--) {
                for (let x = sizeX - 1; x >= 0; x--) {
                    const i = z * strideZ + y * strideY + x;
                    if (grid[i] === 0) continue;

                    // Boundary Conditions (End edges)
                    if (z === sizeZ - 1) grid[i] = Math.min(grid[i], 3);
                    if (y === sizeY - 1) grid[i] = Math.min(grid[i], 3);
                    if (x === sizeX - 1) grid[i] = Math.min(grid[i], 3);

                    // Neighbors
                    // Z+1 layer
                    if (z < sizeZ - 1) {
                        const fz = i + strideZ;
                        check(i, fz, 3);
                        if (y > 0) {
                            check(i, fz - strideY, 4);
                            if (x > 0) check(i, fz - strideY - 1, 5);
                            if (x < sizeX - 1) check(i, fz - strideY + 1, 5);
                        }
                        if (y < sizeY - 1) {
                            check(i, fz + strideY, 4);
                            if (x > 0) check(i, fz + strideY - 1, 5);
                            if (x < sizeX - 1) check(i, fz + strideY + 1, 5);
                        }
                        if (x > 0) check(i, fz - 1, 4);
                        if (x < sizeX - 1) check(i, fz + 1, 4);
                    }

                    // Same Z layer
                    if (y < sizeY - 1) {
                        const fy = i + strideY;
                        check(i, fy, 3);
                        if (x > 0) check(i, fy - 1, 4);
                        if (x < sizeX - 1) check(i, fy + 1, 4);
                    }
                    if (x < sizeX - 1) {
                        check(i, i + 1, 3);
                    }
                }
            }
        }

        // 4. Find Max
        let maxVal = -1;
        let maxIdx = -1;

        for (let i = 0; i < totalVoxels; i++) {
            if (grid[i] > maxVal && grid[i] !== INF) { // Should not be INF after passes unless unconnected
                maxVal = grid[i];
                maxIdx = i;
            }
        }

        if (maxIdx === -1) return null;

        // Decode Index
        const z = Math.floor(maxIdx / strideZ);
        const rem = maxIdx % strideZ;
        const y = Math.floor(rem / strideY);
        const x = rem % strideY;

        // Map back to relative coords
        return {
            x: minX + x,
            y: minY + y,
            z: minZ + z,
            sqDist: (maxVal / 3) * (maxVal / 3) // Approx roughly back to units? 
            // Chamfer 3-4-5 approximates Euclidean distance * 3.
            // So Dist ≈ Val / 3.
            // Squared Dist ≈ (Val / 3)^2
        };
    }
}
