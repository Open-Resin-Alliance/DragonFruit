import * as THREE from 'three';
import { STLExporter } from 'three-stdlib';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import { resolveModelMeshModifiers } from '@/features/mesh-modifiers/meshModifierStore';
import { KNOWN_SOURCE_EXTENSION_STRIP_RE } from '@/features/plugins/pluginFileTypeExtensions';
import { buildSupportExportFromStores, serializeVoxlDocumentV2, serializeVoxlDocumentV2Streaming, VoxlSizeLimitError, type PrecompressedChunk } from '@/features/scene/voxl';
import { type BakedChunk, meshChunkStore } from '@/features/scene/voxl/meshChunkStore';
import { buildScopedSupportExportDocument, buildScopedSupportGeometryGroup } from '@/features/export/logic/supportExportReconstruction';
import { allocateMeshStagePath, exportMeshFile, pickSavePathWithNativeDialog, writeChunkedToNativePath, writeFileAtomicToNativePath, writeFileAtomicStreamedToNativePath } from '@/features/slicing/tauri/nativeSlicerBridge';
import { getKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { getSnapshot } from '@/supports/state';
import { getRaftSettings, getRaftSettingsForModel } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { generateChamferedBase } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBase';
import { generatePerimeterWall } from '@/supports/Rafts/Crenelated/geometry/generatePerimeterWall';
import { generateCrenelatedWallManual } from '@/supports/Rafts/Crenelated/geometry/generateCrenelatedWallManual';
import { generateUnionedLineRaftMesh } from '@/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh';
import { generateChamferedBeam } from '@/supports/Rafts/Crenelated/geometry/generateChamferedBeam';
import { buildLineRaftEdgePairs } from '@/supports/Rafts/Crenelated/geometry/buildLineRaftEdgePairs';
import { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';

export interface ExportOptions {
  filename: string;
  format: 'stl' | '3mf' | 'voxl';
  binary: boolean;
  separateFiles: boolean; // If true, model and supports are separate files (zipped?) - For now assume single file or separate calls
  includeRaft: boolean;
  includeSupports: boolean;
  includeModel: boolean;
  embedOriginalMesh?: boolean;
}

export interface ExportSceneContext {
  models: LoadedModel[];
  activeModelId: string | null;
  selectedModelIds: string[];
  exportThumbnailPng?: Uint8Array | null;
}

export interface ExportSceneSaveTarget {
  nativePath?: string | null;
  /**
   * VOXL 2.2 modifier-snapshot chunking. Omitted/`true` writes the newest
   * (chunked 2.2) layout — the manual-save default. Autosave passes `false` to
   * preserve a pre-2.2 file's inline layout, and escalates to `true` itself if
   * that write throws (see `useSceneAutosave`). Never write `false` for a file
   * that is already 2.2 — that would downgrade it.
   */
  chunkModifierSnapshots?: boolean;
}

export class ExportManager {
  private static readonly BAKE_WAIT_MS = 2_000;

  private static readonly embeddedBinaryStlCache = new Map<string, {
    geometrySignature: string;
    rawBytes: Uint8Array;
    sha256: string;
  }>();

  private static getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error ?? 'Unknown error');
  }

  private static async yieldToBrowserFrame(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
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

  private static readModelIdFromUserData(node: THREE.Object3D, inheritedModelId: string | null): string | null {
    const rawModelId = (node.userData as { modelId?: unknown } | undefined)?.modelId;
    if (typeof rawModelId === 'string' && rawModelId.trim().length > 0) {
      return rawModelId;
    }

    return inheritedModelId;
  }

  private static cloneObjectTreeForModelScope(
    node: THREE.Object3D,
    allowedModelIds: Set<string>,
    inheritedModelId: string | null,
  ): THREE.Object3D | null {
    const currentModelId = this.readModelIdFromUserData(node, inheritedModelId);
    const clonedChildren: THREE.Object3D[] = [];

    for (const child of node.children) {
      const clonedChild = this.cloneObjectTreeForModelScope(child, allowedModelIds, currentModelId);
      if (clonedChild) {
        clonedChildren.push(clonedChild);
      }
    }

    const includeSelf = currentModelId === null || allowedModelIds.has(currentModelId);
    if (!includeSelf && clonedChildren.length === 0) {
      return null;
    }

    const clone = node.clone(false);
    for (const child of clonedChildren) {
      clone.add(child);
    }

    return clone;
  }

  private static buildScopedSupportsGroup(
    supportsGroup: THREE.Object3D,
    allowedModelIds: Set<string>,
  ): THREE.Object3D | null {
    if (allowedModelIds.size === 0) return null;

    const scopedClone = this.cloneObjectTreeForModelScope(supportsGroup, allowedModelIds, null);
    if (!scopedClone) return null;

    scopedClone.updateMatrixWorld(true);
    return scopedClone;
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

  /**
   * The dirty primitive for the COW chunk store (Ph0.1 sub-phase C).
   *
   * Derived entirely from the geometry object — `uuid` changes when
   * `replaceModelGeometry` swaps in a new `BufferGeometry` (hollow, punch,
   * mirror, repair), and `position.version` / `index.version` change on an
   * in-place edit. That is why this, and not a boolean `dirty` flag, is the
   * authority: a flag depends on every present and future mutation path
   * remembering to set it, whereas a signature cannot drift from the object it
   * is read out of. The cost of getting it wrong is asymmetric — a missed flag
   * writes stale geometry into the user's recovery file; a missed bake hook only
   * costs one lazy re-bake.
   */
  static computeModelGeometrySignature(model: LoadedModel): string {
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const vertexCount = position?.count ?? 0;
    const positionVersion = !position
      ? 0
      : ('version' in position ? position.version : position.data.version);
    const indexVersion = index?.version ?? 0;
    return `${geometry.uuid}:${positionVersion}:${indexVersion}:${vertexCount}`;
  }

  /**
   * Encode → SHA → zlib-6 → store, once, for this model's current geometry.
   *
   * Call it at finalization (`replaceModelGeometry`, import completion, both
   * split paths) so the work lands on the operation the user is already waiting
   * for rather than on the next autosave tick. Idempotent and cheap on a hit, so
   * the tick calls it too as a lazy fallback — that is what makes the hooks an
   * optimization rather than a correctness dependency.
   *
   * **Ph5:** the original-mesh embed baked with `slot: 'original'` goes through
   * this same seam; nothing about the tick or the writer changes to accommodate
   * it, because the writer consumes the store rather than the geometry.
   */
  static async bakeModelGeometryChunk(model: LoadedModel): Promise<BakedChunk> {
    return meshChunkStore.bake({
      modelId: model.id,
      signature: this.computeModelGeometrySignature(model),
      encode: () => this.exportModelAsEmbeddedBinaryStlBytes(model),
    });
  }

  /**
   * Resolves this model's chunk for a tick.
   *
   * Waits a bounded {@link BAKE_WAIT_MS} for a bake that is already in flight;
   * if that expires, falls back to whatever chunk the store last committed for
   * this model and reports `stale`. Losing the tick entirely would be worse than
   * writing one-operation-old geometry — but presenting it as current would be a
   * lie, so the caller stamps `geometryStale` on the MODL entry (D2).
   */
  static async resolveModelChunkForTick(model: LoadedModel): Promise<{
    chunk: BakedChunk;
    stale: boolean;
  } | null> {
    const signature = this.computeModelGeometrySignature(model);

    const cached = meshChunkStore.lookup(model.id, signature);
    if (cached) return { chunk: cached, stale: false };

    const inFlight = meshChunkStore.pending(model.id, signature);
    if (inFlight) {
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), this.BAKE_WAIT_MS);
      });
      const settled = await Promise.race([inFlight, timeout]);
      if (settled) return { chunk: settled, stale: false };

      const lastCommitted = meshChunkStore.lastCommitted(model.id);
      if (lastCommitted) return { chunk: lastCommitted, stale: true };
    }

    return { chunk: await this.bakeModelGeometryChunk(model), stale: false };
  }

  /**
   * Eviction hook (Ph0.1 sub-phase C2). Called from `deleteModels`.
   *
   * Before this the encode memo had exactly one `.get` and one `.set` and no
   * eviction anywhere, so deleting a 4M-tri model left ~191 MiB of raw STL
   * resident for the rest of the session. Releasing every slot the model owns
   * also covers Ph5's original embed without a second hook.
   */
  static releaseModelChunks(modelIds: Iterable<string>): void {
    for (const id of modelIds) meshChunkStore.release(id);
  }

  /** Backstop for paths that drop models without going through `deleteModels`. */
  static retainModelChunks(modelIds: Iterable<string>): void {
    meshChunkStore.retainOnly(modelIds);
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

  /**
   * Returns true if the mesh material marks it as a non-exportable hitbox.
   * Hitboxes are always fully invisible (transparent=true AND opacity===0).
   * NOTE: Do NOT check `instanceof MeshBasicMaterial` here — default THREE.Mesh
   * objects (e.g. model meshes built with `new THREE.Mesh(geo)`) also get a
   * MeshBasicMaterial, which would incorrectly exclude the model geometry.
   */
  private static isMaterialHitbox(material: THREE.Material | THREE.Material[]): boolean {
    const mat = Array.isArray(material) ? material[0] : material;
    if (!mat) return false;
    return mat.transparent && mat.opacity === 0;
  }

  /** Counts export triangles across Mesh and InstancedMesh nodes, skipping hitboxes. */
  private static countExportTriangles(objects: THREE.Object3D[]): number {
    let count = 0;
    const perGeo = (geo: THREE.BufferGeometry) => {
      const idx = geo.getIndex();
      if (idx) return Math.floor(idx.count / 3);
      const pos = geo.getAttribute('position');
      return pos ? Math.floor(pos.count / 3) : 0;
    };
    for (const obj of objects) {
      obj.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
          if (this.isMaterialHitbox(node.material)) return;
          count += perGeo(node.geometry) * node.count;
          return;
        }
        if (!(node instanceof THREE.Mesh) || !(node.geometry instanceof THREE.BufferGeometry)) return;
        if (this.isMaterialHitbox(node.material)) return;
        count += perGeo(node.geometry);
      });
    }
    return count;
  }

  /**
   * Extracts raw triangle vertex data from the scene and streams it to a Tauri
   * staging file via IPC.
   *
   * Staging format: 9 × Float32 (LE) per triangle — v0xyz v1xyz v2xyz.
   * This is the most compact representation (36 bytes/tri) and is trivially
   * readable on the Rust side.
   *
   * The staging buffer is pre-allocated at `triCount × 36` bytes.  For ~2M
   * triangles that's ~72 MB — well within JS heap limits (the old 3MF XML
   * pre-allocation was 4–6× larger and was the OOM source).
   */
  private static async stageRawGeometry(
    objects: THREE.Object3D[],
    stagingPath: string,
  ): Promise<number> {
    const triCount = this.countExportTriangles(objects);
    if (triCount === 0) throw new Error('Cannot export: no triangle geometry found.');

    // 9 floats per triangle, 4 bytes each = 36 bytes/tri
    const buf = new Float32Array(triCount * 9);
    let off = 0;

    const v = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const comMat = new THREE.Matrix4();

    const processGeo = (geo: THREE.BufferGeometry, mat: THREE.Matrix4) => {
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      const emit = (a: number, b: number, c: number) => {
        v.fromBufferAttribute(pos, a).applyMatrix4(mat);
        buf[off++] = v.x; buf[off++] = v.y; buf[off++] = v.z;
        v.fromBufferAttribute(pos, b).applyMatrix4(mat);
        buf[off++] = v.x; buf[off++] = v.y; buf[off++] = v.z;
        v.fromBufferAttribute(pos, c).applyMatrix4(mat);
        buf[off++] = v.x; buf[off++] = v.y; buf[off++] = v.z;
      };
      if (idx) {
        const arr = idx.array;
        for (let i = 0; i + 2 < arr.length; i += 3) emit(arr[i], arr[i + 1], arr[i + 2]);
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) emit(i, i + 1, i + 2);
      }
    };

    for (const obj of objects) {
      obj.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
          if (node.count === 0 || this.isMaterialHitbox(node.material)) return;
          for (let i = 0; i < node.count; i++) {
            node.getMatrixAt(i, tmpMat);
            comMat.multiplyMatrices(node.matrixWorld, tmpMat);
            processGeo(node.geometry, comMat);
          }
          return;
        }
        if (!(node instanceof THREE.Mesh) || !(node.geometry instanceof THREE.BufferGeometry)) return;
        if (this.isMaterialHitbox(node.material)) return;
        processGeo(node.geometry, node.matrixWorld);
      });
    }

    // Stream the raw f32 data to the staging file (writeChunkedToNativePath handles 4 MB chunking)
    const bytes = new Uint8Array(buf.buffer, 0, off * 4);
    await writeChunkedToNativePath(stagingPath, bytes);

    return off / 9; // actual triangle count
  }

  /**
   * Builds a binary STL buffer directly from live scene objects.
   * Handles both THREE.Mesh and THREE.InstancedMesh natively — no cloning, no expansion.
   * Pre-allocates the exact buffer size in one triangle-count pass, then writes in one fill pass.
   */
  private static buildBinaryStl(objects: THREE.Object3D[]): Uint8Array {
    const triCount = this.countExportTriangles(objects);
    // 80-byte header + 4-byte triangle count + 50 bytes per triangle
    const buf = new ArrayBuffer(84 + triCount * 50);
    const view = new DataView(buf);
    view.setUint32(80, triCount, true);
    let off = 84;

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const comMat = new THREE.Matrix4();

    const writeTri = (
      pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
      mat: THREE.Matrix4,
      a: number, b: number, c: number,
    ) => {
      vA.fromBufferAttribute(pos, a).applyMatrix4(mat);
      vB.fromBufferAttribute(pos, b).applyMatrix4(mat);
      vC.fromBufferAttribute(pos, c).applyMatrix4(mat);
      edge1.subVectors(vB, vA);
      edge2.subVectors(vC, vA);
      normal.crossVectors(edge1, edge2).normalize();
      view.setFloat32(off, normal.x, true); off += 4;
      view.setFloat32(off, normal.y, true); off += 4;
      view.setFloat32(off, normal.z, true); off += 4;
      view.setFloat32(off, vA.x, true); off += 4;
      view.setFloat32(off, vA.y, true); off += 4;
      view.setFloat32(off, vA.z, true); off += 4;
      view.setFloat32(off, vB.x, true); off += 4;
      view.setFloat32(off, vB.y, true); off += 4;
      view.setFloat32(off, vB.z, true); off += 4;
      view.setFloat32(off, vC.x, true); off += 4;
      view.setFloat32(off, vC.y, true); off += 4;
      view.setFloat32(off, vC.z, true); off += 4;
      view.setUint16(off, 0, true); off += 2;
    };

    const processGeo = (geo: THREE.BufferGeometry, mat: THREE.Matrix4) => {
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      if (idx) {
        const arr = idx.array;
        for (let i = 0; i + 2 < arr.length; i += 3) writeTri(pos, mat, arr[i], arr[i + 1], arr[i + 2]);
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) writeTri(pos, mat, i, i + 1, i + 2);
      }
    };

    for (const obj of objects) {
      obj.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
          if (node.count === 0 || this.isMaterialHitbox(node.material)) return;
          for (let i = 0; i < node.count; i++) {
            node.getMatrixAt(i, tmpMat);
            comMat.multiplyMatrices(node.matrixWorld, tmpMat);
            processGeo(node.geometry, comMat);
          }
          return;
        }
        if (!(node instanceof THREE.Mesh) || !(node.geometry instanceof THREE.BufferGeometry)) return;
        if (this.isMaterialHitbox(node.material)) return;
        processGeo(node.geometry, node.matrixWorld);
      });
    }

    return new Uint8Array(buf);
  }

  private static normalizeExportFilenameBase(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) return 'export';

    const withoutKnownExt = trimmed.replace(KNOWN_SOURCE_EXTENSION_STRIP_RE, '');
    const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
    return cleaned || 'export';
  }

  // ---------------------------------------------------------------------------
  // CRC-32 (used by the minimal ZIP builder)
  // ---------------------------------------------------------------------------

  private static readonly CRC32_TABLE: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  private static crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    const t = ExportManager.CRC32_TABLE;
    for (let i = 0; i < data.length; i++) {
      crc = (t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Incremental CRC32 update.  Pass the running state (start with 0xffffffff) and
   * finalize the final call with `(result ^ 0xffffffff) >>> 0`.
   */
  private static updateCrc32(crc: number, data: Uint8Array): number {
    const t = ExportManager.CRC32_TABLE;
    for (let i = 0; i < data.length; i++) {
      crc = (t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    return crc;
  }

  // ---------------------------------------------------------------------------
  // ZIP structural helpers (STORE, with optional data-descriptor for streaming)
  // ---------------------------------------------------------------------------

  private static buildLocalFileHeader(name: Uint8Array, crc: number, size: number, dataDescriptor: boolean): Uint8Array {
    const out = new Uint8Array(30 + name.length);
    const v = new DataView(out.buffer);
    let p = 0;
    const w32 = (n: number) => { v.setUint32(p, n >>> 0, true); p += 4; };
    const w16 = (n: number) => { v.setUint16(p, n,        true); p += 2; };
    w32(0x04034b50); w16(20); w16(dataDescriptor ? 0x0008 : 0); w16(0); // sig, version, flags, method=STORE
    w16(0); w16(0);                                                       // mod time, mod date
    w32(dataDescriptor ? 0 : crc); w32(dataDescriptor ? 0 : size); w32(dataDescriptor ? 0 : size);
    w16(name.length); w16(0);
    out.set(name, p);
    return out;
  }

  /** 16-byte data descriptor written after streamed file data (ZIP flag bit 3). */
  private static buildDataDescriptor(crc: number, size: number): Uint8Array {
    const out = new Uint8Array(16);
    const v = new DataView(out.buffer);
    v.setUint32(0,  0x08074b50, true); // signature
    v.setUint32(4,  crc  >>> 0, true);
    v.setUint32(8,  size >>> 0, true); // compressed size (STORE: same as uncompressed)
    v.setUint32(12, size >>> 0, true); // uncompressed size
    return out;
  }

  private static buildCentralDirEntry(name: Uint8Array, crc: number, size: number, localOffset: number, dataDescriptor: boolean): Uint8Array {
    const out = new Uint8Array(46 + name.length);
    const v = new DataView(out.buffer);
    let p = 0;
    const w32 = (n: number) => { v.setUint32(p, n >>> 0, true); p += 4; };
    const w16 = (n: number) => { v.setUint16(p, n,        true); p += 2; };
    w32(0x02014b50); w16(20); w16(20); w16(dataDescriptor ? 0x0008 : 0); w16(0); // sig, made-by, needed, flags, method=STORE
    w16(0); w16(0);                                                                // mod time, mod date
    w32(crc); w32(size); w32(size);                                                // crc, compressed, uncompressed
    w16(name.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(localOffset);   // name, extra, comment, disk, int-attr, ext-attr, offset
    out.set(name, p);
    return out;
  }

  private static buildEocd(numFiles: number, cdSize: number, cdOffset: number): Uint8Array {
    const out = new Uint8Array(22);
    const v = new DataView(out.buffer);
    v.setUint32(0,  0x06054b50, true);
    v.setUint16(4,  0,        true); v.setUint16(6, 0,        true); // disk numbers
    v.setUint16(8,  numFiles, true); v.setUint16(10, numFiles, true);
    v.setUint32(12, cdSize   >>> 0, true);
    v.setUint32(16, cdOffset >>> 0, true);
    v.setUint16(20, 0, true); // comment length
    return out;
  }

  /**
   * Builds a ZIP as a Blob from pre-computed XML chunks (browser path).
   * The Blob constructor accepts an array of BlobPart — it never needs a single
   * contiguous ArrayBuffer, so it can handle arbitrarily large model XML.
   *
   * Small metadata files (Content_Types, rels) are stored with CRC in the local
   * header.  The large 3dmodel.model file uses ZIP flag bit 3 (data descriptor
   * follows) so its local header can be written without knowing the CRC / size
   * up front; the data descriptor and central directory carry the correct values.
   */
  private static buildBlobZip(
    ctName: Uint8Array, ctData: Uint8Array,
    relsName: Uint8Array, relsData: Uint8Array,
    modelName: Uint8Array,
    xmlChunks: Uint8Array[], xmlCrc32: number, xmlTotalBytes: number,
  ): Blob {
    const ctCrc   = this.crc32(ctData);
    const relsCrc = this.crc32(relsData);
    const ctHeader    = this.buildLocalFileHeader(ctName,    ctCrc,   ctData.length,   false);
    const relsHeader  = this.buildLocalFileHeader(relsName,  relsCrc, relsData.length, false);
    const modelHeader = this.buildLocalFileHeader(modelName, 0, 0, true); // data descriptor flag

    const ctOffset    = 0;
    const relsOffset  = ctHeader.length + ctData.length;
    const modelOffset = relsOffset + relsHeader.length + relsData.length;
    const cdOffset    = modelOffset + modelHeader.length + xmlTotalBytes + 16; // 16 = data descriptor

    const dataDesc = this.buildDataDescriptor(xmlCrc32, xmlTotalBytes);
    const cdCt     = this.buildCentralDirEntry(ctName,    ctCrc,    ctData.length,   ctOffset,    false);
    const cdRels   = this.buildCentralDirEntry(relsName,  relsCrc,  relsData.length, relsOffset,  false);
    const cdModel  = this.buildCentralDirEntry(modelName, xmlCrc32, xmlTotalBytes,   modelOffset, true);
    const cdSize   = cdCt.length + cdRels.length + cdModel.length;
    const eocd     = this.buildEocd(3, cdSize, cdOffset);

    return new Blob(
      // Cast required: strict DOM lib expects Uint8Array<ArrayBuffer> for BlobPart,
      // but all Uint8Array constructors here return Uint8Array<ArrayBufferLike>.
      // At runtime every Uint8Array is accepted by the Blob constructor.
      [ctHeader, ctData, relsHeader, relsData, modelHeader, ...xmlChunks, dataDesc, cdCt, cdRels, cdModel, eocd] as unknown as BlobPart[],
      { type: 'model/3mf' },
    );
  }

  /**
   * Streams a 3MF ZIP directly to the native file system using append_mesh_stage_chunk.
   *
   * Three sequential writes to the same path:
   *   1. Preamble  — local headers for the two small metadata files + their data +
   *                  the model local header (flag bit 3, CRC/sizes = 0).
   *   2. XML chunks — streamed one 4 MB chunk at a time, never all in memory at once.
   *   3. Postamble — data descriptor + central directory + end-of-central-directory.
   *
   * append_mesh_stage_chunk truncates the file on the first call to a given path and
   * appends on all subsequent calls, so the three sequential writeChunkedToNativePath
   * calls are always correct.
   */
  private static async streamZipToNativePath(
    nativePath: string,
    ctName: Uint8Array, ctData: Uint8Array,
    relsName: Uint8Array, relsData: Uint8Array,
    modelName: Uint8Array,
    xmlChunks: Uint8Array[], xmlCrc32: number, xmlTotalBytes: number,
  ): Promise<void> {
    const ctCrc   = this.crc32(ctData);
    const relsCrc = this.crc32(relsData);
    const ctHeader    = this.buildLocalFileHeader(ctName,    ctCrc,   ctData.length,   false);
    const relsHeader  = this.buildLocalFileHeader(relsName,  relsCrc, relsData.length, false);
    const modelHeader = this.buildLocalFileHeader(modelName, 0, 0, true);

    const ctOffset    = 0;
    const relsOffset  = ctHeader.length + ctData.length;
    const modelOffset = relsOffset + relsHeader.length + relsData.length;

    // ── 1. Preamble (truncates the output file) ──
    const preambleSize = ctHeader.length + ctData.length + relsHeader.length + relsData.length + modelHeader.length;
    const preamble = new Uint8Array(preambleSize);
    let p = 0;
    preamble.set(ctHeader,    p); p += ctHeader.length;
    preamble.set(ctData,      p); p += ctData.length;
    preamble.set(relsHeader,  p); p += relsHeader.length;
    preamble.set(relsData,    p); p += relsData.length;
    preamble.set(modelHeader, p);
    await writeChunkedToNativePath(nativePath, preamble);

    // ── 2. XML chunks (appended sequentially) ──
    for (const chunk of xmlChunks) {
      await writeChunkedToNativePath(nativePath, chunk);
    }

    // ── 3. Postamble: data descriptor + central dir + EOCD ──
    const cdOffset = modelOffset + modelHeader.length + xmlTotalBytes + 16;
    const dataDesc = this.buildDataDescriptor(xmlCrc32, xmlTotalBytes);
    const cdCt     = this.buildCentralDirEntry(ctName,    ctCrc,    ctData.length,   ctOffset,    false);
    const cdRels   = this.buildCentralDirEntry(relsName,  relsCrc,  relsData.length, relsOffset,  false);
    const cdModel  = this.buildCentralDirEntry(modelName, xmlCrc32, xmlTotalBytes,   modelOffset, true);
    const cdSize   = cdCt.length + cdRels.length + cdModel.length;
    const eocd     = this.buildEocd(3, cdSize, cdOffset);

    const postambleSize = dataDesc.length + cdCt.length + cdRels.length + cdModel.length + eocd.length;
    const postamble = new Uint8Array(postambleSize);
    p = 0;
    postamble.set(dataDesc, p); p += dataDesc.length;
    postamble.set(cdCt,     p); p += cdCt.length;
    postamble.set(cdRels,   p); p += cdRels.length;
    postamble.set(cdModel,  p); p += cdModel.length;
    postamble.set(eocd,     p);
    await writeChunkedToNativePath(nativePath, postamble);
  }

  /**
   * Builds the 3MF model XML in fixed-size chunks (4 MB each) to avoid a single
   * large pre-allocation.
   *
   * Why chunked:  for a full print-plate (~2 M+ triangles) the old approach
   * pre-allocated `triCount × (3×59 + 52)` bytes in one shot — up to 450 MB — which
   * reliably throws `RangeError: Array buffer allocation failed` on constrained
   * heap environments.
   *
   * Callers either stream the returned chunks directly to a native file
   * (Tauri / streamZipToNativePath) or fold them into a Blob (browser /
   * buildBlobZip).  Neither path ever requires a single contiguous buffer for
   * the full model XML.
   */
  private static async buildMinimal3mfXmlChunks(
    objects: THREE.Object3D[],
  ): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per working buffer
    const chunks: Uint8Array[] = [];
    let cur = new Uint8Array(CHUNK_SIZE);
    let off = 0;
    let totalBytes = 0;

    /** Push the current buffer to the output list and start a new one. */
    const flush = () => {
      if (off === 0) return;
      // .slice() returns Uint8Array<ArrayBuffer> (vs a view over ArrayBufferLike),
      // which is required for the Blob constructor and allows the 4 MB source buffer
      // to be freed once cur is reassigned.
      chunks.push(cur.slice(0, off));
      totalBytes += off;
      cur = new Uint8Array(CHUNK_SIZE);
      off = 0;
    };

    /**
     * Ensure at least `n` bytes remain in the current buffer.
     * Because CHUNK_SIZE (4 MB) >> max unit (~180 bytes), one flush is always sufficient.
     */
    const ensure = (n: number) => { if (off + n > cur.length) flush(); };

    const ws = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        if (off >= cur.length) flush();
        cur[off++] = s.charCodeAt(i);
      }
    };

    /**
     * Write a float with exactly 4 decimal places as ASCII bytes.
     * Uses integer math — zero heap allocation for |v| < 10 000 (all realistic coords).
     */
    const wf4 = (v: number) => {
      if (!isFinite(v)) v = 0;
      if (v < 0) { cur[off++] = 45; v = -v; } // '-'
      let iv = Math.round(v * 10000);
      if (iv < 0) iv = 0;
      const frac = iv % 10000;
      const whole = ((iv - frac) / 10000) | 0;
      if      (whole === 0)  { cur[off++] = 48; }
      else if (whole < 10)   { cur[off++] = 48 + whole; }
      else if (whole < 100)  {
        cur[off++] = 48 + ((whole / 10) | 0);
        cur[off++] = 48 + (whole % 10);
      } else if (whole < 1000) {
        cur[off++] = 48 + ((whole / 100) | 0);
        cur[off++] = 48 + (((whole / 10) | 0) % 10);
        cur[off++] = 48 + (whole % 10);
      } else if (whole < 10000) {
        cur[off++] = 48 + ((whole / 1000) | 0);
        cur[off++] = 48 + (((whole / 100) | 0) % 10);
        cur[off++] = 48 + (((whole / 10) | 0) % 10);
        cur[off++] = 48 + (whole % 10);
      } else {
        const s2 = whole.toString();
        for (let i = 0; i < s2.length; i++) cur[off++] = s2.charCodeAt(i);
      }
      cur[off++] = 46; // '.'
      cur[off++] = 48 + ((frac / 1000) | 0);
      cur[off++] = 48 + (((frac / 100) | 0) % 10);
      cur[off++] = 48 + (((frac / 10) | 0) % 10);
      cur[off++] = 48 + (frac % 10);
    };

    /** Write unsigned integer without allocation up to 10^8. */
    const wu = (v: number) => {
      if (v < 10)       { cur[off++] = 48 + v; return; }
      if (v < 100)      { cur[off++] = 48 + ((v / 10) | 0);       cur[off++] = 48 + (v % 10); return; }
      if (v < 1000)     { cur[off++] = 48 + ((v / 100) | 0);      cur[off++] = 48 + (((v / 10) | 0) % 10);      cur[off++] = 48 + (v % 10); return; }
      if (v < 10000)    { cur[off++] = 48 + ((v / 1000) | 0);     cur[off++] = 48 + (((v / 100) | 0) % 10);     cur[off++] = 48 + (((v / 10) | 0) % 10);      cur[off++] = 48 + (v % 10); return; }
      if (v < 100000)   { cur[off++] = 48 + ((v / 10000) | 0);    cur[off++] = 48 + (((v / 1000) | 0) % 10);    cur[off++] = 48 + (((v / 100) | 0) % 10);     cur[off++] = 48 + (((v / 10) | 0) % 10);      cur[off++] = 48 + (v % 10); return; }
      if (v < 1000000)  { cur[off++] = 48 + ((v / 100000) | 0);   cur[off++] = 48 + (((v / 10000) | 0) % 10);   cur[off++] = 48 + (((v / 1000) | 0) % 10);    cur[off++] = 48 + (((v / 100) | 0) % 10);     cur[off++] = 48 + (((v / 10) | 0) % 10);    cur[off++] = 48 + (v % 10); return; }
      if (v < 10000000) { cur[off++] = 48 + ((v / 1000000) | 0);  cur[off++] = 48 + (((v / 100000) | 0) % 10);  cur[off++] = 48 + (((v / 10000) | 0) % 10);   cur[off++] = 48 + (((v / 1000) | 0) % 10);    cur[off++] = 48 + (((v / 100) | 0) % 10);   cur[off++] = 48 + (((v / 10) | 0) % 10); cur[off++] = 48 + (v % 10); return; }
      const s2 = v.toString(); for (let i = 0; i < s2.length; i++) cur[off++] = s2.charCodeAt(i);
    };

    ensure(256);
    ws('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>');

    let writtenTris = 0;
    let vertexOffset = 0;
    const wv = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();
    const comMat = new THREE.Matrix4();

    // ── Pass 1: write ALL vertices ──
    // Collect (geometry, matrix, vertexOffset) for the triangle pass.
    const geoEntries: Array<{
      geo: THREE.BufferGeometry;
      mat: THREE.Matrix4;
      startVertex: number;
    }> = [];

    const collectVertices = (geo: THREE.BufferGeometry, mat: THREE.Matrix4) => {
      const pos = geo.getAttribute('position');
      if (!pos || pos.count === 0) return;
      const startVertex = vertexOffset;
      geoEntries.push({ geo, mat, startVertex });

      for (let i = 0; i < pos.count; i++) {
        wv.fromBufferAttribute(pos, i).applyMatrix4(mat);
        ws('<vertex x="'); wf4(wv.x); ws('" y="'); wf4(wv.y); ws('" z="'); wf4(wv.z); ws('"/>');
      }
      vertexOffset += pos.count;
    };

    for (const obj of objects) {
      obj.traverse((node) => {
        if (node instanceof THREE.InstancedMesh) {
          if (node.count === 0 || this.isMaterialHitbox(node.material)) return;
          for (let i = 0; i < node.count; i++) {
            node.getMatrixAt(i, tmpMat);
            comMat.multiplyMatrices(node.matrixWorld, tmpMat);
            collectVertices(node.geometry, comMat);
          }
          return;
        }
        if (!(node instanceof THREE.Mesh) || !(node.geometry instanceof THREE.BufferGeometry)) return;
        if (this.isMaterialHitbox(node.material)) return;
        collectVertices(node.geometry, node.matrixWorld);
      });
    }

    if (geoEntries.length === 0) throw new Error('Cannot export 3MF: no triangle geometry found.');

    ws('</vertices>');

    // Yield to unblock the render loop between the two heavyweight passes.
    await new Promise<void>(r => setTimeout(r, 0));

    // ── Pass 2: write ALL triangles ──
    ws('<triangles>');

    for (const entry of geoEntries) {
      const { geo, mat, startVertex } = entry;
      const pos = geo.getAttribute('position')!;
      const idx = geo.getIndex();

      if (idx) {
        const arr = idx.array;
        for (let i = 0; i + 2 < arr.length; i += 3) {
          ws('<triangle v1="'); wu(startVertex + arr[i]); ws('" v2="'); wu(startVertex + arr[i + 1]); ws('" v3="'); wu(startVertex + arr[i + 2]); ws('"/>');
          writtenTris++;
        }
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) {
          ws('<triangle v1="'); wu(startVertex + i); ws('" v2="'); wu(startVertex + i + 1); ws('" v3="'); wu(startVertex + i + 2); ws('"/>');
          writtenTris++;
        }
      }
    }

    if (writtenTris === 0) throw new Error('Cannot export 3MF: no triangle geometry found.');

    ws('</triangles></mesh></object></resources><build><item objectid="1"/></build></model>');

    flush();
    return { chunks, totalBytes };
  }

  /**
   * Exports the scene as a 3MF file.
   *
   * For the Tauri native path: the ZIP is streamed directly to disk chunk by chunk —
   * the full model XML is never resident in memory all at once.
   * For the browser path: the ZIP is assembled as a Blob (array of BlobPart),
   * which also avoids a single contiguous ArrayBuffer allocation.
   *
   * Returns the saved path (native) or the resolved filename (browser), or null on
   * unexpected failure.
   */
  private static async export3mf(
    objects: THREE.Object3D[],
    filename: string,
    prePickedNativePath: string | null,
    useNativeWrite: boolean,
  ): Promise<string | null> {
    const enc = new TextEncoder();
    const ctName    = enc.encode('[Content_Types].xml');
    const relsName  = enc.encode('_rels/.rels');
    const modelName = enc.encode('3D/3dmodel.model');
    const ctData    = enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    const relsData  = enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');

    const { chunks: xmlChunks, totalBytes: xmlTotalBytes } = await this.buildMinimal3mfXmlChunks(objects);

    // Compute CRC32 of the model XML incrementally — no extra buffer needed.
    let xmlCrcState = 0xffffffff;
    for (const chunk of xmlChunks) xmlCrcState = this.updateCrc32(xmlCrcState, chunk);
    const xmlCrc32 = (xmlCrcState ^ 0xffffffff) >>> 0;

    if (prePickedNativePath && useNativeWrite) {
      await this.streamZipToNativePath(
        prePickedNativePath,
        ctName, ctData, relsName, relsData, modelName,
        xmlChunks, xmlCrc32, xmlTotalBytes,
      );
      return prePickedNativePath;
    }

    // Browser fallback: Blob-based ZIP.
    const zipBlob = this.buildBlobZip(
      ctName, ctData, relsName, relsData, modelName,
      xmlChunks, xmlCrc32, xmlTotalBytes,
    );
    const normalizedBase = this.normalizeExportFilenameBase(filename);
    const resolvedFilename = `${normalizedBase}.3mf`;
    const url = URL.createObjectURL(zipBlob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      URL.revokeObjectURL(url);
    }
    return resolvedFilename;
  }
  public static async exportScene(
    modelObject: THREE.Object3D | null,
    supportsGroup: THREE.Object3D | null,
    options: ExportOptions,
    sceneContext?: ExportSceneContext,
    saveTarget?: ExportSceneSaveTarget,
  ): Promise<string | null> {
    const scopedModelIds = new Set((sceneContext?.models ?? []).map((model) => model.id));
    const hasScopedModelFilter = scopedModelIds.size > 0;

    // Ask for the save destination FIRST so the user doesn't wait through
    // geometry serialization before seeing the dialog.
    const base = this.normalizeExportFilenameBase(options.filename || 'export');
    const ext = options.format === '3mf' ? '3mf' : options.format === 'voxl' ? 'voxl' : 'stl';
    const suggestedName = `${base}.${ext}`;
    let prePickedNativePath = saveTarget?.nativePath?.trim() || null;
    let useNativeWrite = true;

    if (!prePickedNativePath) {
      try {
        prePickedNativePath = await pickSavePathWithNativeDialog(suggestedName);
      } catch (err) {
        const msg = this.getErrorMessage(err);
        if (msg.toLowerCase().includes('save cancelled by user') || msg.toLowerCase().includes('cancelled by user')) {
          return null; // User dismissed — nothing to do
        }
        // Native dialog unavailable (web mode) — fall back to browser <a download>
        useNativeWrite = false;
      }
    }

    // VOXL path: serialization can be expensive, so destination is pre-picked above.
    if (options.format === 'voxl') {
      return this.exportVoxl(sceneContext, options, prePickedNativePath, useNativeWrite, saveTarget?.chunkModifierSnapshots ?? true);
    }

    // Collect live scene objects for serialization — no cloning, no InstancedMesh expansion.
    // Each serializer (buildBinaryStl / buildMinimal3mfModelXml) handles InstancedMesh natively.
    const exportObjects: THREE.Object3D[] = [];

    // Model: already a fresh group from ExportPanel's buildModelGroup, updateMatrixWorld was called there.
    if (options.includeModel && modelObject) {
      modelObject.updateMatrixWorld(true);
      exportObjects.push(modelObject);
    }

    // Supports: use the live R3F ref directly — its matrixWorld is already current.
    // Hitbox meshes are filtered per-node inside the serializers via isMaterialHitbox().
    if (options.includeSupports) {
      if (hasScopedModelFilter) {
        const supportSnapshot = getSnapshot();
        const kickstandSnapshot = getKickstandSnapshot();
        const scopedSupports = buildScopedSupportGeometryGroup(supportSnapshot, kickstandSnapshot, scopedModelIds);
        if (scopedSupports.children.length > 0) {
          exportObjects.push(scopedSupports);
        }
      } else if (supportsGroup) {
        supportsGroup.updateMatrixWorld(true);
        exportObjects.push(supportsGroup);
      }
    }

    // 4. Add Raft (if requested and enabled) — per-model so each model gets its own raft
    if (options.includeRaft) {
      const globalRaftSettings = getRaftSettings();
      if (globalRaftSettings.bottomMode !== 'off') {
        const supportState = getSnapshot();
        const kickstandState = getKickstandSnapshot();
        const allRoots = Object.values(supportState.roots);
        const allKickstandRoots = Object.values(kickstandState.roots);

        // Group roots by modelId so each model gets a separate raft
        const rootsByModel = new Map<string, typeof allRoots>();
        for (const root of allRoots) {
          const rootModelId = root.modelId ?? null;
          if (hasScopedModelFilter) {
            if (!rootModelId || !scopedModelIds.has(rootModelId)) {
              continue;
            }
          }

          const mid = rootModelId ?? '__orphan__';
          let arr = rootsByModel.get(mid);
          if (!arr) { arr = []; rootsByModel.set(mid, arr); }
          arr.push(root);
        }

        for (const root of allKickstandRoots) {
          const rootModelId = root.modelId ?? null;
          if (hasScopedModelFilter) {
            if (!rootModelId || !scopedModelIds.has(rootModelId)) {
              continue;
            }
          }

          const mid = rootModelId ?? '__orphan__';
          let arr = rootsByModel.get(mid);
          if (!arr) { arr = []; rootsByModel.set(mid, arr); }
          arr.push(root);
        }

        for (const [modelKey, roots] of rootsByModel) {
          if (roots.length === 0) continue;

          // Use per-model raft settings if available, otherwise use global settings
          const modelId = modelKey === '__orphan__' ? null : modelKey;
          const raftSettings = modelId ? getRaftSettingsForModel(modelId) : globalRaftSettings;

          const thickness = raftSettings.bottomMode === 'line' ? raftSettings.lineHeightMm : raftSettings.thickness;
          const chamferInset = Math.max(0, thickness) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettings.chamferAngle))));
          const wallInset = raftSettings.wallEnabled ? Math.max(0, raftSettings.wallThickness) : 0;
          const dynamicMargin = 0.2 + Math.max(chamferInset, wallInset);

          const circles: SupportBaseCircle[] = roots.map(r => ({
            x: r.transform.pos.x,
            y: r.transform.pos.y,
            r: r.diameter / 2
          }));

          const profile = computeFootprint(circles, { marginMm: dynamicMargin, samplesPerCircle: 24 });

          if (!profile || profile.length < 3) continue;

          const raftGroup = new THREE.Group();
          raftGroup.name = 'Raft';

          if (raftSettings.bottomMode === 'solid') {
            const baseMesh = generateChamferedBase(profile, {
              thickness: raftSettings.thickness,
              chamferAngle: raftSettings.chamferAngle
            });
            raftGroup.add(baseMesh);
          }

          if (raftSettings.bottomMode === 'line') {
            const nodes2d = roots.map((r) => new THREE.Vector2(r.transform.pos.x, r.transform.pos.y));
            const hasBorderRing = !!profile && profile.length >= 3;
            const edgePairs = buildLineRaftEdgePairs(nodes2d, {
              hasBorderRing,
              keepFactor: 8,
              absMaxLen: 220,
              enforceConnected: true,
            });

            const beamHeight = Math.max(0.01, raftSettings.lineHeightMm);

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

          }

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

          raftGroup.updateMatrixWorld(true);
          exportObjects.push(raftGroup);
        }
      }
    }

    // 5. Serialize and write
    // ── Tauri path: stage raw geometry → Rust writes STL / compressed 3MF ──
    if (prePickedNativePath && useNativeWrite) {
      try {
        const stagingPath = await allocateMeshStagePath();
        await this.stageRawGeometry(exportObjects, stagingPath);
        const format = options.format === '3mf' ? '3mf' : 'stl';
        await exportMeshFile(stagingPath, prePickedNativePath, format);
        return prePickedNativePath;
      } catch (err) {
        console.warn('[ExportManager] Rust export failed, falling back to JS serializer.', err);
        // Fall through to JS-based export below
      }
    }

    // ── Browser / fallback: JS-based serializers ──
    if (options.format === '3mf') {
      return this.export3mf(exportObjects, options.filename, null, false);
    }

    const stlBytes = this.buildBinaryStl(exportObjects);
    return this.downloadFile(stlBytes, options.filename, 'stl', 'application/octet-stream', null, false);
  }

  private static async exportVoxl(
    sceneContext: ExportSceneContext | undefined,
    options: ExportOptions,
    prePickedNativePath: string | null,
    useNativeWrite: boolean,
    chunkModifierSnapshots = true,
  ): Promise<string | null> {
    // Yield before the (synchronous) support snapshot so the render loop stays
    // alive on scenes with many support nodes.
    await this.yieldToBrowserFrame();

    const supportSnapshot = getSnapshot();
    const kickstandSnapshot = getKickstandSnapshot();

    const scopedModelIds = new Set((sceneContext?.models ?? []).map((model) => model.id));
    const hasScopedModelFilter = scopedModelIds.size > 0;

    const supports = hasScopedModelFilter
      ? buildScopedSupportExportDocument(
          supportSnapshot,
          kickstandSnapshot,
          scopedModelIds,
          'dragonfruit-voxl-export',
        )
      : buildSupportExportFromStores(
          supportSnapshot,
          kickstandSnapshot,
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
      supports.kickstands = [];
    }

    // Post-C the writer is fed from the chunk store, so `meshBytesMap` stays
    // empty on this path: the raw STL bytes exist only inside the bake and are
    // dropped immediately after. `precompressedMap` carries the payload, its
    // compression tag, and its uncompressed length — everything the directory
    // and the MODL entries need.
    const meshBytesMap = new Map<number, Uint8Array>();
    const sha256Map = new Map<number, string>();
    const precompressedMap = new Map<number, PrecompressedChunk>();
    const precompressedOriginalMap = new Map<number, PrecompressedChunk>();
    const staleModelIds = new Set<string>();

    const models = options.includeModel
      ? await (async () => {
          const sourceModels = sceneContext?.models ?? [];
          const exportedModels: Array<{
            id: string;
            name: string;
            visible: boolean;
            color: string;
            polygonCount: number;
            fileSizeBytes: number;
            sourcePath?: string;
            nativePreview?: {
              originalTriangleCount: number;
              previewTriangleCount: number;
              cPre?: [number, number, number];
              sourceFingerprint?: { sizeBytes: number; mtimeMs: number };
            };
            geometryStale?: boolean;
            transform: {
              position: { x: number; y: number; z: number };
              rotation: { x: number; y: number; z: number };
              scale: { x: number; y: number; z: number };
            };
            meshModifiers?: ModelMeshModifiers;
            isSupportGeometry?: boolean;
            linkGroupId?: string;
            mesh: {
              mode: 'embedded-file';
              fileName: string;
              mimeType: 'model/stl';
            };
          }> = [];

          if (sourceModels.length > 0) {
            await this.yieldToBrowserFrame();
          }

          for (let index = 0; index < sourceModels.length; index += 1) {
            const model = sourceModels[index];
            const resolvedChunk = await this.resolveModelChunkForTick(model);
            if (resolvedChunk) {
              sha256Map.set(index, resolvedChunk.chunk.sha256);
              precompressedMap.set(index, {
                data: resolvedChunk.chunk.data,
                compression: resolvedChunk.chunk.compression,
                uncompressedSize: resolvedChunk.chunk.uncompressedSize,
              });
              if (resolvedChunk.stale) staleModelIds.add(model.id);
            }

            const origChunk = meshChunkStore.lastCommitted(model.id, 'original');
            if (origChunk) {
              precompressedOriginalMap.set(index, {
                data: origChunk.data,
                compression: origChunk.compression,
                uncompressedSize: origChunk.uncompressedSize,
              });
            }

            exportedModels.push({
              id: model.id,
              name: model.name,
              visible: model.visible,
              color: model.color,
              polygonCount: model.polygonCount,
              fileSizeBytes: model.fileSizeBytes ?? 0,
              // Preserves sourcePath / nativePreview if present on model
              ...(typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
                ? { sourcePath: model.sourcePath }
                : {}),
              ...(model.geometry.nativePreview
                ? { nativePreview: { ...model.geometry.nativePreview } }
                : {}),
              ...(model.originalRef
                ? { originalRef: origChunk ? { ...model.originalRef, sha256: origChunk.sha256, uncompressedSizeBytes: origChunk.uncompressedSize } : model.originalRef }
                : (options.embedOriginalMesh && origChunk
                  ? { originalRef: { mode: 'embedded-chunk' as const, sha256: origChunk.sha256, uncompressedSizeBytes: origChunk.uncompressedSize } }
                  : (!options.embedOriginalMesh && typeof model.sourcePath === 'string' && model.sourcePath.trim().length > 0
                    ? { originalRef: { mode: 'external-file' as const, fileName: model.sourcePath } }
                    : {}))),
              // Honesty flag (Ph0.1 D2): this model's embedded mesh is the last
              // committed bake, not the geometry currently on screen, because a
              // mutation was still baking when the bounded wait expired.
              ...(staleModelIds.has(model.id) ? { geometryStale: true as const } : {}),
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
              // Model objects in React state carry meshModifiers: undefined
              // by design (externalized store) — resolve through the store or
              // every saved VOXL silently loses hollowing/hole-punch
              // re-editability (voxl-format-spec.md V2.1 requirement).
              meshModifiers: resolveModelMeshModifiers(model),
              isSupportGeometry: model.isSupportGeometry,
              linkGroupId: model.linkGroupId,
              mesh: {
                mode: 'embedded-file',
                fileName: `${this.normalizeExportFilenameBase(model.name || 'model')}.stl`,
                mimeType: 'model/stl',
              },
            });

            if (index < sourceModels.length - 1) {
              await this.yieldToBrowserFrame();
            }
          }

          return exportedModels;
        })()
      : [];

    const thumbnailBytes = sceneContext?.exportThumbnailPng;
    const voxlExtensions = thumbnailBytes && thumbnailBytes.length > 0
      ? {
          'ora.preview': {
            kind: 'scene-thumbnail',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: this.toBase64(thumbnailBytes),
          },
        }
      : undefined;

    const documentInput = {
      models,
      activeModelId: sceneContext?.activeModelId ?? null,
      selectedModelIds: sceneContext?.selectedModelIds ?? [],
      supports,
      meta: {
        generator: 'DragonFruit',
      },
      extensions: voxlExtensions,
    };
    // `chunkModifierSnapshots` selects the VOXL 2.2 layout (chunked, the default
    // and the manual-save path) or the pre-2.2 inline layout (autosave preserving
    // an old file's format). Autosave owns the escalate-on-failure decision so it
    // can also latch the scene to 2.2 — see `useSceneAutosave`.
    const serializeOptions = {
      precompressed: precompressedMap,
      precompressedOriginal: precompressedOriginalMap,
      embedOriginalMesh: options.embedOriginalMesh ?? true,
      chunkModifierSnapshots,
    };

    // Native path: stream straight into the atomic writer's temp file, so the
    // 172–515 MiB contiguous document buffer never exists (Ph0.1 sub-phase E).
    // A pre-picked destination is the autosave and in-place Ctrl+S case — the
    // one that runs unattended and the one that most needed the buffer gone.
    if (useNativeWrite && prePickedNativePath && this.requiresAtomicCommit('voxl')) {
      try {
        await writeFileAtomicStreamedToNativePath(prePickedNativePath, async (emit) => {
          await serializeVoxlDocumentV2Streaming(
            documentInput,
            meshBytesMap,
            sha256Map,
            emit,
            serializeOptions,
          );
        });
        return prePickedNativePath;
      } catch (error) {
        if (error instanceof VoxlSizeLimitError) throw error;
        console.warn('[ExportManager] Streamed VOXL write failed, retrying buffered.', error);
      }
    }

    // serializeVoxlDocumentV2 is async — compression runs off the main thread.
    const binary = await serializeVoxlDocumentV2(
      documentInput,
      meshBytesMap,
      sha256Map,
      serializeOptions,
    );

    return this.downloadFile(
      binary,
      options.filename,
      'voxl',
      'application/vnd.dragonfruit.voxl',
      prePickedNativePath,
      useNativeWrite,
    );
  }

  /**
   * Which exported formats must be committed atomically rather than written in
   * place. A scene file IS the user's document — losing it to an interrupted
   * overwrite is unrecoverable data loss — whereas a mesh export is a
   * regenerable artifact.
   *
   * Exported for the shared-seam test: this predicate, not the caller, decides
   * whether a given save is crash-safe.
   */
  static requiresAtomicCommit(extension: string): boolean {
    return extension.trim().toLowerCase() === 'voxl';
  }

  private static async downloadFile(
    data: DataView | Uint8Array | string,
    filename: string,
    extension: 'stl' | '3mf' | 'voxl',
    mimeType: string,
    /** Pre-picked native path from an earlier dialog call; null means browser-fallback. */
    prePickedNativePath: string | null = null,
    /** False when native dialog was unavailable and we should use browser <a download>. */
    useNativeWrite = true,
  ): Promise<string | null> {
    const normalizedBaseName = this.normalizeExportFilenameBase(filename);
    const resolvedFilename = `${normalizedBaseName}.${extension}`;

    const bytes = data instanceof DataView
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof Uint8Array
        ? data
        : new TextEncoder().encode(data);

    // The shared write seam (Ph0.1 sub-phase A, finding N1).
    //
    // Scene files go through the atomic writer: temp → fsync → rename. The
    // truncate-first chunked writer destroyed the destination before the first
    // byte of the new payload landed, so a crash mid-write left a truncated file
    // with no fallback.
    //
    // Autosave and explicit save BOTH arrive here — autosave via
    // `useSceneAutosave.performAutosave` → `exportScene({nativePath})`, Ctrl+S
    // via the same `exportScene` with a picked path — so this one branch is what
    // makes both crash-safe. Do not fork them into separate writers.
    //
    // STL/3MF keep the raw chunked writer: they are new-file exports rather than
    // overwrites of the working document, and 3MF's native path additionally
    // depends on the existing truncate-on-fresh-appender semantics.
    const writeNative = this.requiresAtomicCommit(extension)
      ? writeFileAtomicToNativePath
      : writeChunkedToNativePath;

    // If a native path was already picked before heavy work started, write directly.
    let nativeDestinationPath = prePickedNativePath;

    if (nativeDestinationPath && useNativeWrite) {
      try {
        await writeNative(nativeDestinationPath, bytes);
        return nativeDestinationPath;
      } catch (error) {
        console.warn('[ExportManager] Chunked write failed, retrying with a fresh save destination.', error);
        nativeDestinationPath = null;
      }
    }

    if (useNativeWrite && !nativeDestinationPath) {
      // Fallback: try native dialog + write (e.g. VOXL path that doesn't pre-pick)
      try {
        const destinationPath = await pickSavePathWithNativeDialog(resolvedFilename);
        await writeNative(destinationPath, bytes);
        return destinationPath;
      } catch (error) {
        const message = this.getErrorMessage(error);
        if (message.toLowerCase().includes('save cancelled by user') || message.toLowerCase().includes('cancelled by user')) {
          return null;
        }
        console.warn('[ExportManager] Native save dialog unavailable/failed, falling back to browser download.', error);
      }
    }

    // Browser <a download> fallback
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
    // Browser download — no path available
    return resolvedFilename;
  }
}
