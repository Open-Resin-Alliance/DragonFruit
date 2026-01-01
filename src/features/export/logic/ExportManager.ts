import * as THREE from 'three';
import { STLExporter } from 'three-stdlib';
import { getSnapshot } from '@/supports/state';
import { getRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { SupportGeometryGenerator } from './SupportGeometryGenerator';
import { SupportData } from '@/supports/rendering/SupportBuilder';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { generateChamferedBase } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBase';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';
import { generatePerimeterBorderBeam } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterBorderBeam';
import { generateUnionedLineRaftMesh } from '@/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBeam';
import { delaunayTriangulate2d } from '@/supports/Rafts/Crenelated/geometry/delaunayTriangulate2d';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';
import { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';

type EdgeKey = string;

function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function edgeLen(a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface ExportOptions {
  filename: string;
  binary: boolean;
  separateFiles: boolean; // If true, model and supports are separate files (zipped?) - For now assume single file or separate calls
  includeRaft: boolean;
  includeSupports: boolean;
  includeModel: boolean;
}

export class ExportManager {
  /**
   * Generates and downloads an STL file based on the current scene state.
   */
  public static async exportScene(
    modelObject: THREE.Object3D | null,
    supportsGroup: THREE.Object3D | null,
    options: ExportOptions
  ): Promise<void> {
    console.log('[ExportManager] Starting export...', options);

    // 1. Create a temporary scene
    const scene = new THREE.Scene();

    // 2. Add Model (if requested)
    if (options.includeModel && modelObject) {
      // Clone the object (Group or Mesh)
      const clonedModel = modelObject.clone();
      scene.add(clonedModel);
    }

    // 3. Add Supports (if requested) - USE ACTUAL RENDERED SUPPORTS
    if (options.includeSupports && supportsGroup) {
      // Clone the actual supports group from the scene
      const clonedSupports = supportsGroup.clone();
      clonedSupports.name = 'Supports';
      
      // Remove invisible hitbox meshes and other non-exportable objects
      // STL exporter ignores visibility, so we must actually remove them
      const meshesToRemove: THREE.Mesh[] = [];
      clonedSupports.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          // Skip hitbox meshes (transparent with opacity 0)
          if (child.material instanceof THREE.Material) {
            if (child.material.transparent && child.material.opacity === 0) {
              meshesToRemove.push(child);
              return;
            }
          }
          // Skip meshes with basic materials used for hitboxes
          if (child.material instanceof THREE.MeshBasicMaterial) {
            meshesToRemove.push(child);
            return;
          }
        }
      });
      
      // Actually remove the hitbox meshes from their parents
      meshesToRemove.forEach(mesh => {
        if (mesh.parent) {
          mesh.parent.remove(mesh);
        }
      });
      
      // Reset scale to ensure supports export with correct scale
      // Supports should be in world units, not affected by any parent scaling
      clonedSupports.scale.set(1, 1, 1);
      
      // CRITICAL: Update world matrix for supports to ensure proper scaling/positioning
      clonedSupports.updateMatrixWorld(true);
      
      scene.add(clonedSupports);
    }

    // 4. Add Raft (if requested and enabled)
    if (options.includeRaft) {
      const raftSettings = getRaftSettings();
      if (raftSettings.bottomMode !== 'off') {
        // We need to get the support state for raft generation
        const supportState = getSnapshot();
        const roots = Object.values(supportState.roots);
        if (roots.length > 0) {
           const circles: SupportBaseCircle[] = roots.map(r => ({
             x: r.transform.pos.x,
             y: r.transform.pos.y,
             r: r.diameter / 2
           }));

           const chamferInset = Math.max(0, raftSettings.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))));
           const profile = computeFootprint(circles, { marginMm: 0.2 + (raftSettings.bottomMode === 'line' ? chamferInset : 0), samplesPerCircle: 24 });
           
           if (profile && profile.length >= 3) {
             const raftGroup = new THREE.Group();
             raftGroup.name = 'Raft';

             if (raftSettings.bottomMode === 'solid') {
               // Base
               const baseMesh = generateChamferedBase(profile, {
                 thickness: raftSettings.thickness,
                 chamferAngle: raftSettings.chamferAngle
               });
               raftGroup.add(baseMesh);
             }

             if (raftSettings.bottomMode === 'line') {
               const nodes2d = roots.map((r) => new THREE.Vector2(r.transform.pos.x, r.transform.pos.y));
               const hasBorderRing = !!profile && profile.length >= 3;

               // Compute hull for filtering (border ring replaces hull-edge beams)
               const hull = convexHull2d(nodes2d);
               const hullIndices: number[] = hull.map((hp) => {
                 let best = 0;
                 let bestD2 = Infinity;
                 for (let i = 0; i < nodes2d.length; i++) {
                   const p = nodes2d[i];
                   const dx = p.x - hp.x;
                   const dy = p.y - hp.y;
                   const d2 = dx * dx + dy * dy;
                   if (d2 < bestD2) {
                     bestD2 = d2;
                     best = i;
                   }
                 }
                 return best;
               });

               const hullEdges: Array<[number, number]> = [];
               if (hullIndices.length >= 2) {
                 for (let i = 0; i < hullIndices.length; i++) {
                   const a = hullIndices[i];
                   const b = hullIndices[(i + 1) % hullIndices.length];
                   if (a !== b) hullEdges.push([a, b]);
                 }
               }

               const hullEdgeSet = new Set<EdgeKey>();
               for (const [a, b] of hullEdges) hullEdgeSet.add(edgeKey(a, b));

               const tris = delaunayTriangulate2d(nodes2d);

               const nn = new Array(nodes2d.length).fill(Infinity);
               for (let i = 0; i < nodes2d.length; i++) {
                 for (let j = 0; j < nodes2d.length; j++) {
                   if (i === j) continue;
                   nn[i] = Math.min(nn[i], edgeLen(nodes2d[i], nodes2d[j]));
                 }
                 if (!Number.isFinite(nn[i])) nn[i] = 0;
               }

               const keepFactor = 3.2;
               const absMaxLen = 120;
               const edges = new Set<EdgeKey>();
               const edgePairs: Array<[number, number]> = [];

               // Fallback only: if no border ring, add hull edges.
               if (!hasBorderRing) {
                 for (const [a, b] of hullEdges) {
                   const key = edgeKey(a, b);
                   if (!edges.has(key)) {
                     edges.add(key);
                     edgePairs.push([a, b]);
                   }
                 }
               }

               // Add pruned Delaunay edges
               for (const [i, j, k] of tris) {
                 const triEdges: Array<[number, number]> = [
                   [i, j],
                   [j, k],
                   [k, i],
                 ];
                 for (const [a, b] of triEdges) {
                   const key = edgeKey(a, b);
                   if (edges.has(key)) continue;
                   if (hasBorderRing && hullEdgeSet.has(key)) continue;
                   const len = edgeLen(nodes2d[a], nodes2d[b]);
                   const localMax = keepFactor * Math.min(nn[a], nn[b]);
                   if (len > absMaxLen) continue;
                   if (nn[a] > 0 && nn[b] > 0 && len > localMax) continue;
                   edges.add(key);
                   edgePairs.push([a, b]);
                 }
               }

               const beamHeight = Math.max(0.01, raftSettings.lineHeightMm);

               // Interior network: unioned flat mesh (no chamfer) for clean topology.
               const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]);
               const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
                 widthMm: raftSettings.lineWidthMm,
                 heightMm: beamHeight,
                 borderProfile: null,
               });

               const unionHasGeometry = (unionMesh.geometry as any)?.attributes?.position?.count > 0;
               if (unionHasGeometry) {
                 raftGroup.add(unionMesh);
               } else {
                 for (const [a, b] of edgePairs) {
                   const start = new THREE.Vector3(nodes2d[a].x, nodes2d[a].y, 0);
                   const end = new THREE.Vector3(nodes2d[b].x, nodes2d[b].y, 0);
                   const beam = generateChamferedBeam(start, end, {
                     widthMm: raftSettings.lineWidthMm,
                     heightMm: beamHeight,
                     chamferAngleDeg: 90,
                   });
                   raftGroup.add(beam);
                 }
               }

               // Perimeter border: chamfered ring mesh aligned with wall.
               const borderMesh = generatePerimeterBorderBeam(profile, {
                 widthMm: raftSettings.lineWidthMm,
                 heightMm: beamHeight,
                 chamferAngleDeg: raftSettings.chamferAngle,
               });
               raftGroup.add(borderMesh);
             }

             // Wall
             const shouldRenderWall = raftSettings.wallEnabled;
             if (shouldRenderWall) {
               const useCrenels = raftSettings.crenulationSpacing > 0 && raftSettings.crenulationGapWidth > 0;
               const thickness = raftSettings.bottomMode === 'line' ? Math.max(0.01, raftSettings.lineHeightMm) : raftSettings.thickness;
               const wallMesh = useCrenels
                ? generateCrenelatedWallManual(profile, {
                    wallHeight: raftSettings.wallHeight,
                    wallThickness: raftSettings.wallThickness,
                    crenulationGapWidth: raftSettings.crenulationGapWidth,
                    crenulationSpacing: raftSettings.crenulationSpacing,
                    thickness,
                    chamferAngle: raftSettings.chamferAngle,
                  })
                : generatePerimeterWall(profile, {
                    wallHeight: raftSettings.wallHeight,
                    wallThickness: raftSettings.wallThickness,
                    thickness
                  });
             
               if (wallMesh) raftGroup.add(wallMesh);
             }
             scene.add(raftGroup);
           }
        }
      }
    }

    // CRITICAL: Update all matrices in the detached scene before export.
    // STLExporter relies on .matrixWorld to transform geometry into place.
    // Without this, all grouped/positioned meshes will export at (0,0,0).
    scene.updateMatrixWorld(true);

    // 5. Export
    const exporter = new STLExporter();
    // TypeScript workaround for overload selection
    const result = options.binary 
      ? exporter.parse(scene, { binary: true }) 
      : exporter.parse(scene, { binary: false });
    
    // 6. Download
    this.downloadBlob(result, options.filename);
    
    // 7. Cleanup
    scene.clear();
  }

  private static downloadBlob(data: DataView | string, filename: string) {
    const blob = new Blob([data as any], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.stl') ? filename : `${filename}.stl`;
    link.click();
    URL.revokeObjectURL(url);
  }
}
