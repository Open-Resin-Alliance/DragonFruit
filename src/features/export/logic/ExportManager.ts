import * as THREE from 'three';
import { STLExporter } from 'three-stdlib';
import JSZip from 'jszip';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSupportExportFromStores, buildVoxlDocumentV1, serializeVoxlDocument } from '@/features/scene/voxl';
import { pickSavePathWithNativeDialog, writeBytesToNativePath } from '@/features/slicing/tauri/nativeSlicerBridge';
import { getSupportBraceSnapshot } from '@/supports/SupportTypes/SupportBrace/supportBraceStore';
import { getSnapshot } from '@/supports/state';
import { getRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
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
  format: 'stl' | '3mf' | 'voxl';
  binary: boolean;
  separateFiles: boolean; // If true, model and supports are separate files (zipped?) - For now assume single file or separate calls
  includeRaft: boolean;
  includeSupports: boolean;
  includeModel: boolean;
}

export interface ExportSceneContext {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
}

export class ExportManager {
  private static getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error ?? 'Unknown error');
  }

  private static toBase64(bytes: Uint8Array): string {
    if (typeof btoa !== 'function') {
      throw new Error('Base64 encoding is unavailable in this environment.');
    }

    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private static exportModelAsEmbeddedBinaryStlBytes(model: LoadedModel): Uint8Array {
    const localGroup = new THREE.Group();
    const mesh = new THREE.Mesh(model.geometry.geometry);
    const centerOffset = model.geometry.center;
    mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);
    localGroup.add(mesh);
    localGroup.updateMatrixWorld(true);

    const exporter = new STLExporter();
    const result = exporter.parse(localGroup, { binary: true });
    if (!(result instanceof DataView)) {
      throw new Error('Expected binary STL payload while exporting VOXL embedded mesh.');
    }

    const bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    return new Uint8Array(bytes);
  }

  private static encodeRleU8(input: Uint8Array): Uint8Array {
    if (input.length === 0) return new Uint8Array();

    const output: number[] = [];
    let runValue = input[0];
    let runCount = 1;

    for (let i = 1; i < input.length; i += 1) {
      const value = input[i];
      if (value === runValue && runCount < 255) {
        runCount += 1;
      } else {
        output.push(runCount, runValue);
        runValue = value;
        runCount = 1;
      }
    }

    output.push(runCount, runValue);
    return new Uint8Array(output);
  }

  private static async sha256Hex(bytes: Uint8Array): Promise<string> {
    if (!globalThis.crypto?.subtle) {
      throw new Error('SHA-256 hashing is unavailable in this environment.');
    }

    const digestInput = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(digestInput).set(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
    const digestBytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < digestBytes.length; i += 1) {
      hex += digestBytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  private static async buildEmbeddedMeshPayload(model: LoadedModel): Promise<{
    dataBase64: string;
    dataEncoding: 'base64-raw' | 'base64-rle-u8';
    uncompressedSizeBytes: number;
    sha256: string;
  }> {
    const rawBytes = this.exportModelAsEmbeddedBinaryStlBytes(model);
    const rleBytes = this.encodeRleU8(rawBytes);
    const useRle = rleBytes.length > 0 && rleBytes.length < rawBytes.length;
    const payloadBytes = useRle ? rleBytes : rawBytes;

    return {
      dataBase64: this.toBase64(payloadBytes),
      dataEncoding: useRle ? 'base64-rle-u8' : 'base64-raw',
      uncompressedSizeBytes: rawBytes.length,
      sha256: await this.sha256Hex(rawBytes),
    };
  }

  private static expandInstancedMeshes(root: THREE.Object3D): void {
    const instancedMeshes: THREE.InstancedMesh[] = [];

    root.traverse((child) => {
      if (child instanceof THREE.InstancedMesh && child.count > 0) {
        instancedMeshes.push(child);
      }
    });

    const tempMatrix = new THREE.Matrix4();
    const combinedMatrix = new THREE.Matrix4();

    for (const instanced of instancedMeshes) {
      const parent = instanced.parent;
      if (!parent) continue;

      for (let i = 0; i < instanced.count; i += 1) {
        instanced.getMatrixAt(i, tempMatrix);
        combinedMatrix.multiplyMatrices(instanced.matrix, tempMatrix);

        const mesh = new THREE.Mesh(
          instanced.geometry,
          Array.isArray(instanced.material)
            ? instanced.material.map((m) => m.clone())
            : instanced.material.clone(),
        );
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(combinedMatrix);
        mesh.castShadow = instanced.castShadow;
        mesh.receiveShadow = instanced.receiveShadow;
        mesh.name = `${instanced.name || 'InstancedMesh'}_${i}`;
        parent.add(mesh);
      }

      parent.remove(instanced);
    }
  }

  private static normalizeExportFilenameBase(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) return 'export';

    const withoutKnownExt = trimmed.replace(/(\.(stl|obj|3mf|lys|lychee|json|voxl))+$/i, '');
    const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
    return cleaned || 'export';
  }

  private static buildMinimal3mfModelXml(scene: THREE.Scene): string {
    const vertices: Array<{ x: number; y: number; z: number }> = [];
    const triangles: Array<{ v1: number; v2: number; v3: number }> = [];

    const worldVertex = new THREE.Vector3();

    scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      if (!(node.geometry instanceof THREE.BufferGeometry)) return;

      const geometry = node.geometry;
      const position = geometry.getAttribute('position');
      if (!position) return;

      const index = geometry.getIndex();
      const matrixWorld = node.matrixWorld;

      const appendTri = (a: number, b: number, c: number) => {
        const base = vertices.length;

        worldVertex.fromBufferAttribute(position, a).applyMatrix4(matrixWorld);
        vertices.push({ x: worldVertex.x, y: worldVertex.y, z: worldVertex.z });

        worldVertex.fromBufferAttribute(position, b).applyMatrix4(matrixWorld);
        vertices.push({ x: worldVertex.x, y: worldVertex.y, z: worldVertex.z });

        worldVertex.fromBufferAttribute(position, c).applyMatrix4(matrixWorld);
        vertices.push({ x: worldVertex.x, y: worldVertex.y, z: worldVertex.z });

        triangles.push({ v1: base, v2: base + 1, v3: base + 2 });
      };

      if (index) {
        const indexArray = index.array;
        for (let i = 0; i + 2 < indexArray.length; i += 3) {
          appendTri(indexArray[i], indexArray[i + 1], indexArray[i + 2]);
        }
      } else {
        for (let i = 0; i + 2 < position.count; i += 3) {
          appendTri(i, i + 1, i + 2);
        }
      }
    });

    if (triangles.length === 0) {
      throw new Error('Cannot export 3MF: no triangle geometry found.');
    }

    const vertexXml = vertices
      .map((v) => `<vertex x="${v.x}" y="${v.y}" z="${v.z}"/>`)
      .join('');

    const triangleXml = triangles
      .map((t) => `<triangle v1="${t.v1}" v2="${t.v2}" v3="${t.v3}"/>`)
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertexXml}</vertices><triangles>${triangleXml}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  }

  private static async export3mfFromScene(scene: THREE.Scene): Promise<Uint8Array> {
    const modelXml = this.buildMinimal3mfModelXml(scene);

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypesXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('3D/3dmodel.model', modelXml);

    return zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  }

  /**
   * Generates and downloads an export artifact (STL / 3MF / VOXL) based on current scene state.
   */
  public static async exportScene(
    modelObject: THREE.Object3D | null,
    supportsGroup: THREE.Object3D | null,
    options: ExportOptions,
    sceneContext?: ExportSceneContext,
  ): Promise<void> {
    console.log('[ExportManager] Starting export...', options);

    if (options.format === 'voxl') {
      await this.exportVoxl(sceneContext, options);
      return;
    }

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

      // STLExporter doesn't serialize InstancedMesh directly.
      // Expand batched/instanced supports into regular meshes for export.
      this.expandInstancedMeshes(clonedSupports);
      
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

               const unionPositionAttribute = unionMesh.geometry.getAttribute('position');
               const unionHasGeometry = !!unionPositionAttribute && unionPositionAttribute.count > 0;
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
    if (options.format === '3mf') {
      const bytes = await this.export3mfFromScene(scene);
      await this.downloadFile(bytes, options.filename, '3mf', 'model/3mf');
      scene.clear();
      return;
    }

    const exporter = new STLExporter();
    const result = options.binary
      ? exporter.parse(scene, { binary: true })
      : exporter.parse(scene, { binary: false });

    // 6. Download
    await this.downloadFile(result, options.filename, 'stl', 'application/octet-stream');
    
    // 7. Cleanup
    scene.clear();
  }

  private static async exportVoxl(sceneContext: ExportSceneContext | undefined, options: ExportOptions): Promise<void> {
    const supportSnapshot = getSnapshot();
    const supportBraceSnapshot = getSupportBraceSnapshot();
    const supports = buildSupportExportFromStores(
      supportSnapshot,
      supportBraceSnapshot,
      'dragonfruit-voxl-export',
    );

    if (!options.includeSupports) {
      supports.roots = [];
      supports.trunks = [];
      supports.branches = [];
      supports.leaves = [];
      supports.twigs = [];
      supports.sticks = [];
      supports.braces = [];
      supports.knots = [];
      supports.supportBraces = [];
    }

    const models = options.includeModel
      ? await Promise.all((sceneContext?.models ?? []).map(async (model) => {
          const embedded = await this.buildEmbeddedMeshPayload(model);

          return {
            id: model.id,
            name: model.name,
            visible: model.visible,
            color: model.color,
            polygonCount: model.polygonCount,
            fileSizeBytes: model.fileSizeBytes,
            transform: {
              position: {
                x: model.transform.position.x,
                y: model.transform.position.y,
                z: model.transform.position.z,
              },
              rotation: {
                x: model.transform.rotation.x,
                y: model.transform.rotation.y,
                z: model.transform.rotation.z,
              },
              scale: {
                x: model.transform.scale.x,
                y: model.transform.scale.y,
                z: model.transform.scale.z,
              },
            },
            mesh: {
              mode: 'embedded-file' as const,
              fileName: `${this.normalizeExportFilenameBase(model.name || 'model')}.stl`,
              mimeType: 'model/stl',
              dataBase64: embedded.dataBase64,
              dataEncoding: embedded.dataEncoding,
              uncompressedSizeBytes: embedded.uncompressedSizeBytes,
              sha256: embedded.sha256,
            },
          };
        }))
      : [];

    const doc = buildVoxlDocumentV1({
      models,
      activeModelId: sceneContext?.activeModelId ?? null,
      selectedModelIds: sceneContext?.selectedModelIds ?? [],
      supports,
      meta: {
        generator: 'DragonFruit',
      },
    });

    const json = serializeVoxlDocument(doc, true);
    await this.downloadFile(json, options.filename, 'voxl', 'application/json');
  }

  private static async downloadFile(data: DataView | Uint8Array | string, filename: string, extension: 'stl' | '3mf' | 'voxl', mimeType: string) {
    const normalizedBaseName = this.normalizeExportFilenameBase(filename);
    const resolvedFilename = `${normalizedBaseName}.${extension}`;

    const bytes = data instanceof DataView
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof Uint8Array
        ? data
        : new TextEncoder().encode(data);

    try {
      const destinationPath = await pickSavePathWithNativeDialog(resolvedFilename);
      await writeBytesToNativePath(destinationPath, bytes);
      return;
    } catch (error) {
      const message = this.getErrorMessage(error);
      if (message.toLowerCase().includes('save cancelled by user')) {
        return;
      }
      console.warn('[ExportManager] Native save dialog unavailable/failed, falling back to browser download.', error);
    }

    // Create a clean copy with explicit ArrayBuffer for Blob compatibility
    const blobData = typeof data === 'string' ? data : new Uint8Array(bytes);
    const blob = new Blob([blobData], { type: mimeType });

    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedFilename;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
