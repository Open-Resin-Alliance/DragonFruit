import type { BufferGeometry, BufferAttribute, InterleavedBufferAttribute } from 'three';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './tauriRuntime';

export type SliceMeshBounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
export type LoadedSliceMeshReference = {
  sourceId: string;
  expectedCorners: number;
  triangleStart: number;
  triangleEnd: number;
  order: 'geometry' | 'soup';
};
export type AppendLoadedSliceMesh = LoadedSliceMeshReference & {
  matrix: number[];
  center: number[];
  plateOffset: number[];
  flipWinding: boolean;
};
export type AppendedLoadedSliceMesh = { triangleCount: number; meshBounds: SliceMeshBounds };

type Attribute = BufferAttribute | InterleavedBufferAttribute;
function version(attribute: Attribute): number {
  return 'data' in attribute ? attribute.data.version : attribute.version;
}
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | null | undefined): number {
  if (!value) return 0;
  let id = identities.get(value);
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
  return id;
}
// Primitive tokens do not pin retired renderer attributes/buffers after an edit.
type GeometryRevision = {
  position: number; positions: number; positionVersion: number;
  positionCount: number; itemSize: number; normalized: boolean;
  index: number; indices: number; indexVersion: number | null; indexCount: number | null;
};
function revision(geometry: BufferGeometry): GeometryRevision | null {
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const index = geometry.getIndex();
  return { position: identity(position), positions: identity(position.array), positionVersion: version(position),
    positionCount: position.count, itemSize: position.itemSize, normalized: position.normalized,
    index: identity(index), indices: identity(index?.array), indexVersion: index?.version ?? null, indexCount: index?.count ?? null };
}
function samePositions(geometry: BufferGeometry, saved: GeometryRevision): boolean {
  const position = geometry.getAttribute('position');
  return !!position && identity(position) === saved.position && identity(position.array) === saved.positions
    && version(position) === saved.positionVersion && position.count === saved.positionCount
    && position.itemSize === saved.itemSize && position.normalized === saved.normalized;
}
function sameRevision(geometry: BufferGeometry, saved: GeometryRevision): boolean {
  const index = geometry.getIndex();
  return samePositions(geometry, saved) && identity(index) === saved.index
    && identity(index?.array) === saved.indices && (index?.version ?? null) === saved.indexVersion
    && (index?.count ?? null) === saved.indexCount;
}
export type LoadedSliceMeshPartitions = { modelTriangleCount: number; modelBounds: SliceMeshBounds; supportBounds: SliceMeshBounds };
type ImportSource = { token: number; expectedCorners: number; offset: [number, number, number]; revision: GeometryRevision };
const imports = new WeakMap<BufferGeometry, ImportSource>();
const retained = new WeakMap<BufferGeometry, { reference: LoadedSliceMeshReference; revision: GeometryRevision; partitions?: LoadedSliceMeshPartitions; parent?: { geometry: BufferGeometry; revision: GeometryRevision } }>();

/** Called on the loader's soup, before repair, centering or BVH construction. */
export function rememberImportedSliceMesh(geometry: BufferGeometry, token: number): void {
  const saved = revision(geometry);
  if (!saved) return;
  imports.set(geometry, { token, expectedCorners: saved.positionCount, offset: [0, 0, 0], revision: saved });
}

export function forgetImportedSliceMesh(geometry: BufferGeometry): void {
  imports.delete(geometry);
  retained.delete(geometry);
}

/** Only the import's synchronous, exact clone is allowed to inherit a loader token. */
export function inheritImportedSliceMesh(source: BufferGeometry, target: BufferGeometry): void {
  const entry = imports.get(source);
  const saved = revision(target);
  if (entry && saved && sameRevision(source, entry.revision)) {
    imports.set(target, { ...entry, offset: [...entry.offset], revision: saved });
  }
}

/** The one authorized position mutation during import, reproduced with f32 rounding natively. */
export function centerImportedSliceMesh(geometry: BufferGeometry, offset: [number, number, number], translate: () => void): void {
  const entry = imports.get(geometry);
  const valid = entry && samePositions(geometry, entry.revision);
  translate();
  if (!entry || !valid) return;
  const saved = revision(geometry);
  if (!saved) return;
  imports.set(geometry, { ...entry, offset, revision: saved });
}

/** Retain existing native points plus the finalized BVH corner order, never re-upload positions. */
export async function retainImportedSliceMesh(geometry: BufferGeometry, modelTriangleCount?: number | null): Promise<void> {
  if (!isTauriRuntime()) { imports.delete(geometry); return; }
  const entry = imports.get(geometry);
  if (!entry || !samePositions(geometry, entry.revision)) { imports.delete(geometry); return; }
  const saved = revision(geometry);
  if (!saved) return;
  const indices = geometry.getIndex()?.array;
  // The importer still owns this geometry until this await finishes. IPC does not detach it.
  const order = indices instanceof Uint32Array ? indices : indices ? Uint32Array.from(indices) : new Uint32Array(0);
  const body = new Uint8Array(order.buffer, order.byteOffset, order.byteLength);
  try {
    const result = await invoke<{ sourceId: string; partitions?: LoadedSliceMeshPartitions } | null>('retain_loaded_slice_mesh', body, { headers: {
      'Content-Type': 'application/octet-stream',
      'x-mesh-token': String(entry.token),
      'x-mesh-expected-corners': String(entry.expectedCorners),
      'x-mesh-position-offset': '[' + entry.offset.map(value => Object.is(value, -0) ? '-0' : String(value)).join(',') + ']',
      ...(modelTriangleCount != null && modelTriangleCount > 0 && modelTriangleCount * 3 < entry.expectedCorners
        ? { 'x-mesh-model-triangles': String(modelTriangleCount) } : {}),
    } });
    if (result && sameRevision(geometry, saved)) {
      retained.set(geometry, { revision: saved, partitions: result.partitions, reference: { sourceId: result.sourceId, expectedCorners: entry.expectedCorners,
        triangleStart: 0, triangleEnd: (saved.indexCount ?? saved.positionCount) / 3, order: 'geometry' } });
    }
  } catch (error) {
    console.warn('[SliceMeshCache] Imported mesh retention unavailable; slicing will prepare the exact live geometry.', error);
  } finally { imports.delete(geometry); }
}

export function loadedSliceMeshReference(geometry: BufferGeometry): LoadedSliceMeshReference | null {
  const entry = retained.get(geometry);
  return entry && sameRevision(geometry, entry.revision)
    && (!entry.parent || sameRevision(entry.parent.geometry, entry.parent.revision)) ? entry.reference : null;
}

export function loadedSliceMeshPartitions(geometry: BufferGeometry): LoadedSliceMeshPartitions | null {
  const entry = retained.get(geometry);
  return entry && loadedSliceMeshReference(geometry) ? entry.partitions ?? null : null;
}

/** Classified sections use raw soup ranges, not the BVH's triangle traversal order. */
export function inheritLoadedSliceMeshRange(source: BufferGeometry, target: BufferGeometry, start: number, end: number): void {
  const entry = retained.get(source);
  const saved = revision(target);
  if (!entry || !saved || !sameRevision(source, entry.revision)) return;
  if (start < 0 || end <= start || end * 3 > entry.reference.expectedCorners) return;
  retained.set(target, { revision: saved, parent: { geometry: source, revision: entry.revision },
    reference: { ...entry.reference, order: 'soup', triangleStart: start, triangleEnd: end } });
}
