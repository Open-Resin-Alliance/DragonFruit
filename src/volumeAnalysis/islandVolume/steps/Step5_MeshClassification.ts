import * as THREE from 'three';
import { type BasinFillProxy } from './expansion/BasinFillProxy';
import { type BasinFillSimulator } from './expansion/BasinFillSimulator';

export interface MeshClassificationResult {
    islandId: number;
    faceCount: number;
    estimatedVolumeMm3: number; // Rough estimate based on voxel count or mesh? lets do mesh count first.
    color?: THREE.Color;
}

export interface ClassificationOutput {
    summary: Map<number, MeshClassificationResult>; // Summary by ID
    faceLabels: Int32Array; // Per-face Island ID (Index -> IslandID)
}

/**
 * Step 5: Classify Mesh Faces based on Voxel Basin Fill Results.
 * 
 * Maps every triangle of the original mesh to an Island ID by checking
 * which voxel the triangle's centroid falls into.
 */
export class MeshClassifier {

    public static classify(
        geometry: THREE.BufferGeometry,
        simulator: BasinFillSimulator | BasinFillProxy,
        gridOriginX: number,
        gridOriginZ: number,
        worldMinZ: number
    ): ClassificationOutput {

        const positionAttr = geometry.getAttribute('position');
        const indexAttr = geometry.getIndex();

        const faceCount = indexAttr ? indexAttr.count / 3 : positionAttr.count / 3;

        // This array will store the island ID for every face
        const faceLabels = new Int32Array(faceCount);

        const classification = new Map<number, MeshClassificationResult>();

        // Helper to get or create result
        const getResult = (id: number) => {
            if (!classification.has(id)) {
                classification.set(id, {
                    islandId: id,
                    faceCount: 0,
                    estimatedVolumeMm3: 0
                });
            }
            return classification.get(id)!;
        };

        const pxMm = simulator.pxMm;
        const layerHeightMm = simulator.layerHeightMm;

        // Re-use vectors
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const centroid = new THREE.Vector3();

        for (let i = 0; i < faceCount; i++) {
            // 1. Get Triangle Vertices
            if (indexAttr) {
                const idx0 = indexAttr.getX(i * 3);
                const idx1 = indexAttr.getX(i * 3 + 1);
                const idx2 = indexAttr.getX(i * 3 + 2);
                a.fromBufferAttribute(positionAttr, idx0);
                b.fromBufferAttribute(positionAttr, idx1);
                c.fromBufferAttribute(positionAttr, idx2);
            } else {
                a.fromBufferAttribute(positionAttr, i * 3);
                b.fromBufferAttribute(positionAttr, i * 3 + 1);
                c.fromBufferAttribute(positionAttr, i * 3 + 2);
            }

            // 2. Compute Centroid
            centroid.addVectors(a, b).add(c).multiplyScalar(1 / 3);

            // 3. Convert to Grid Coords
            // Grid Logic matches BasinFillSimulator constructor
            // wx = originX + (x * px) + offset -> x = (wx - originX) / px
            const gx = Math.floor((centroid.x - gridOriginX) / pxMm);

            // wy = -(originZ + y*px + offset) -> -wy = originZ + y*px -> y = (-wy - originZ)/px
            const gy = Math.floor((-centroid.y - gridOriginZ) / pxMm);

            const gz = Math.floor((centroid.z - worldMinZ) / layerHeightMm);

            // 4. Lookup Logic
            if (gx >= 0 && gx < simulator.gridWidth &&
                gy >= 0 && gy < simulator.gridHeight &&
                gz >= 0 && gz < simulator.gridDepth) {

                const gridIdx = gx + (gy * simulator.gridWidth) + (gz * simulator.gridWidth * simulator.gridHeight);

                // Use the exposed lookup function (works on both Simulator and Proxy if interface aligns, 
                // but Simulator doesn't have 'lookupLabel' public? Proxy has it. 
                // Let's assume passed object has lookupLabel or lookup.
                // BasinFillSimulator has 'lookup' private. 
                // BasinFillProxy has 'lookupLabel' public.
                // We should cast or unify. 

                let islandId = 0;
                if ('lookupLabel' in simulator) {
                    islandId = (simulator as BasinFillProxy).lookupLabel(gridIdx);
                } else {
                    // Simulator logic (if we ever pass raw simulator)
                    // We can just add lookupLabel to Simulator too or use private access (naughty)
                    // Better to rely on Proxy for now as that's what we pass.
                    islandId = (simulator as any).lookup(gridIdx);
                    if (islandId !== -1) {
                        // Simulator.lookup returns SolidIdx. Need to get Label.
                        islandId = (simulator as BasinFillSimulator).labels[islandId];
                    } else {
                        islandId = 0;
                    }
                }

                // Store result
                faceLabels[i] = islandId;

                if (islandId > 0) {
                    const res = getResult(islandId);
                    res.faceCount++;
                    // Rough volume estimation? 
                    // Volume of a tetrahedron from origin? No, too complex.
                    // Just count faces for now.
                }
            } else {
                faceLabels[i] = 0; // OOB
            }
        }

        return {
            summary: classification,
            faceLabels: faceLabels
        };
    }
}
