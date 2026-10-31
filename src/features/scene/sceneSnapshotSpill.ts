import * as THREE from 'three';
import { accelerateGeometry } from '@/utils/bvh';
import { releaseGeometryStorage } from '@/utils/releaseGeometry';
import type { LoadedModel, SceneSnapshotPair } from '@/features/scene/useSceneCollectionManager';
import type { SupportState } from '@/supports/types';

const SPILL_DIRECTORY = 'dragonfruit-undo';
const SPILL_VERSION = 1;

type TypedArrayName =
  | 'Float32Array'
  | 'Float64Array'
  | 'Uint32Array'
  | 'Uint16Array'
  | 'Uint8Array'
  | 'Uint8ClampedArray'
  | 'Int32Array'
  | 'Int16Array'
  | 'Int8Array';

type AttributeSpec = {
  name: string;
  type: TypedArrayName;
  itemSize: number;
  normalized: boolean;
  offset: number;
  byteLength: number;
};

type GeometrySpec = {
  uuid: string;
  attributes: AttributeSpec[];
  index: AttributeSpec | null;
  hadBoundsTree: boolean;
};

type SpillHeader = {
  version: number;
  geometries: GeometrySpec[];
  /**
   * The pair's support states, serialized beside the geometry. They are the
   * other heavy part of a history entry: a supported plate is tens of thousands
   * of entities, and the pair holds its own deep copy.
   */
  support?: {
    before: SupportSection | null;
    after: SupportSection | null;
  };
};

type SupportSection = {
  offset: number;
  byteLength: number;
};

export type SpilledSceneSnapshot = {
  fileHandle: FileSystemFileHandle;
  dataOffset: number;
  /** Bytes this scratch file holds, for the history's disk budget. */
  byteLength: number;
  geometries: GeometrySpec[];
  support: SpillHeader['support'];
};

const spilledSceneSnapshots = new Map<string, SpilledSceneSnapshot>();
const inFlightSpills = new Set<string>();

/** Total bytes the scratch store holds for snapshots still in history. */
export function spilledSceneSnapshotBytes(): number {
  let total = 0;
  for (const entry of spilledSceneSnapshots.values()) total += entry.byteLength;
  return total;
}

function typedArrayName(array: ArrayBufferView): TypedArrayName | null {
  switch (array.constructor) {
    case Float32Array: return 'Float32Array';
    case Float64Array: return 'Float64Array';
    case Uint32Array: return 'Uint32Array';
    case Uint16Array: return 'Uint16Array';
    case Uint8Array: return 'Uint8Array';
    case Uint8ClampedArray: return 'Uint8ClampedArray';
    case Int32Array: return 'Int32Array';
    case Int16Array: return 'Int16Array';
    case Int8Array: return 'Int8Array';
    default: return null;
  }
}

function constructorFor(name: TypedArrayName): new (buffer: ArrayBuffer) => ArrayBufferView {
  const map = {
    Float32Array,
    Float64Array,
    Uint32Array,
    Uint16Array,
    Uint8Array,
    Uint8ClampedArray,
    Int32Array,
    Int16Array,
    Int8Array,
  };
  return map[name];
}

function modelGeometries(model: Pick<LoadedModel, 'geometry'>): THREE.BufferGeometry[] {
  const geometries: THREE.BufferGeometry[] = [model.geometry.geometry];
  if (model.geometry.edgeGeometry) geometries.push(model.geometry.edgeGeometry);
  const defects = model.geometry.meshDefects;
  if (defects?.supportSectionGeometry) geometries.push(defects.supportSectionGeometry);
  if (defects?.modelSectionGeometry) geometries.push(defects.modelSectionGeometry);
  return geometries;
}

function pairGeometries(pair: SceneSnapshotPair): THREE.BufferGeometry[] {
  const geometries = new Set<THREE.BufferGeometry>();
  for (const model of pair.before.models) modelGeometries(model).forEach((geometry) => geometries.add(geometry));
  for (const model of pair.after.models) modelGeometries(model).forEach((geometry) => geometries.add(geometry));
  return [...geometries];
}

function canSerializeGeometry(geometry: THREE.BufferGeometry): boolean {
  if (geometry.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) return false;
  if (geometry.index && (geometry.index as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return false;
  for (const attribute of Object.values(geometry.attributes)) {
    if ((attribute as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return false;
    if (!typedArrayName(attribute.array as ArrayBufferView)) return false;
  }
  return Object.keys(geometry.attributes).length > 0;
}

/**
 * A support state as JSON bytes.
 *
 * Written verbatim — the per-type views AND the canonical `supports` map — rather
 * than reduced to `supports`. The primitive collections (`roots`, `knots`) live
 * only as properties (they are not in `supports`), and a pair's state is read by
 * code that expects the views before it reaches the store; a reduced payload
 * restored into any of those readers is a state with missing collections.
 */
function serializeSupportState(state: SupportState | undefined): Uint8Array | null {
  if (!state) return null;
  try {
    return new TextEncoder().encode(JSON.stringify(state));
  } catch {
    return null;
  }
}

async function spillDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SPILL_DIRECTORY, { create: true });
  } catch {
    return null;
  }
}

export function hasSpilledSceneSnapshot(key: string): boolean {
  return spilledSceneSnapshots.has(key);
}

/** Removes scratch files that no current history entry references (startup/HMR cleanup). */
export async function pruneSpilledSceneSnapshots(activeKeys: ReadonlySet<string>): Promise<void> {
  const directory = await spillDirectory();
  if (!directory) return;
  try {
    const entries = (directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind !== 'file' || !name.endsWith('.bin')) continue;
      const key = name.slice('scene-'.length, -'.bin'.length);
      if (!name.startsWith('scene-') || !activeKeys.has(key)) {
        await directory.removeEntry(name).catch(() => undefined);
      }
    }
  } catch (error) {
    console.warn('[UndoSpill] Failed pruning scratch snapshots.', error);
  }
}

/**
 * Writes a snapshot's geometry arrays to the OPFS scratch store, then clears the
 * in-memory attribute storage. The model objects and support state stay in RAM:
 * they are small beside the buffers, and keeping them avoids re-creating the
 * transform/geometry wrappers on undo.
 *
 * `canRelease` is re-checked after the write because an undo may have restored
 * the models while the disk write was in flight.
 */
export async function spillSceneSnapshotPair(
  key: string,
  pair: SceneSnapshotPair,
  /** Whether this geometry may leave RAM at all (nothing else holds it). */
  canSpill: (geometry: THREE.BufferGeometry) => boolean,
  /**
   * Re-checked immediately before the arrays are dropped, and again on the idle
   * callback that drops them. Defaults to `canSpill`; a caller that knows the
   * scene has not committed yet passes the live-scene predicate here.
   */
  canRelease: (geometry: THREE.BufferGeometry) => boolean = canSpill,
): Promise<boolean> {
  if (spilledSceneSnapshots.has(key) || inFlightSpills.has(key)) return false;

  const allGeometries = pairGeometries(pair);
  const candidates = allGeometries.filter((geometry) => (
    canSpill(geometry) && canSerializeGeometry(geometry)
  ));
  const supportPending = Boolean(pair.before.supportState) || Boolean(pair.after.supportState);
  // A pair whose geometry is shared with the live scene can still be holding the
  // support state — a transform commit deep-clones it twice, and that is tens of
  // MB on a supported plate. It spills on its own.
  if (candidates.length === 0 && !supportPending) return false;

  inFlightSpills.add(key);
  let fileHandle: FileSystemFileHandle | null = null;
  try {
    const directory = await spillDirectory();
    if (!directory) return false;

    const specs: GeometrySpec[] = [];
    const payloads: Array<{ array: ArrayBufferView; spec: AttributeSpec }> = [];
    let offset = 0;
    let id = 0;
    for (const geometry of candidates) {
      const geometrySpec: GeometrySpec = {
        uuid: geometry.uuid,
        attributes: [],
        index: null,
        hadBoundsTree: Boolean((geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree),
      };
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const array = attribute.array as ArrayBufferView;
        const type = typedArrayName(array);
        if (!type) continue;
        const spec: AttributeSpec = {
          name,
          type,
          itemSize: attribute.itemSize,
          normalized: Boolean(attribute.normalized),
          offset,
          byteLength: array.byteLength,
        };
        offset += array.byteLength;
        payloads.push({ array, spec });
        geometrySpec.attributes.push(spec);
      }
      if (geometry.index) {
        const array = geometry.index.array as ArrayBufferView;
        const type = typedArrayName(array);
        if (type) {
          const spec: AttributeSpec = {
            name: '__index',
            type,
            itemSize: geometry.index.itemSize,
            normalized: Boolean(geometry.index.normalized),
            offset,
            byteLength: array.byteLength,
          };
          offset += array.byteLength;
          payloads.push({ array, spec });
          geometrySpec.index = spec;
        }
      }
      specs.push(geometrySpec);
      id += 1;
      if (id % 4 === 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
    }

    // Support states ride in the same file, after the geometry payloads. They
    // are the pair's other large allocation: a supported plate clones tens of
    // thousands of entities per history entry.
    const beforeSupport = serializeSupportState(pair.before.supportState);
    const afterSupport = serializeSupportState(pair.after.supportState);
    const support: SpillHeader['support'] = beforeSupport || afterSupport
      ? { before: null, after: null }
      : undefined;
    if (support && beforeSupport) {
      support.before = { offset, byteLength: beforeSupport.byteLength };
      offset += beforeSupport.byteLength;
    }
    if (support && afterSupport) {
      support.after = { offset, byteLength: afterSupport.byteLength };
      offset += afterSupport.byteLength;
    }

    const header: SpillHeader = { version: SPILL_VERSION, geometries: specs, ...(support ? { support } : {}) };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, headerBytes.byteLength, true);

    fileHandle = await directory.getFileHandle(`scene-${key}.bin`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(prefix);
    await writable.write(headerBytes);
    for (const { array, spec } of payloads) {
      await writable.write(new Uint8Array(array.buffer, array.byteOffset, spec.byteLength) as unknown as ArrayBufferView<ArrayBuffer>);
    }
    if (beforeSupport) await writable.write(beforeSupport as unknown as ArrayBufferView<ArrayBuffer>);
    if (afterSupport) await writable.write(afterSupport as unknown as ArrayBufferView<ArrayBuffer>);
    await writable.close();

    // Only drop the states that reached the file.
    if (beforeSupport) pair.before.supportState = undefined;
    if (afterSupport) pair.after.supportState = undefined;

    let releaseCount = 0;
    let skipped = 0;
    const release = () => {
      for (const geometry of candidates) {
        // Re-checked here, not when the write started: an undo may have put
        // these models back in the scene while the file was being written.
        if (!canRelease(geometry)) {
          skipped += 1;
          continue;
        }
        releaseGeometryStorage(geometry);
        releaseCount += 1;
      }
      console.info(
        `[UndoSpill] Released ${releaseCount} of ${candidates.length} geometries from scene snapshot "${key}"` +
        (skipped > 0 ? ` (${skipped} still live).` : '.'),
      );
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(release, { timeout: 500 });
    } else {
      setTimeout(release, 50);
    }

    spilledSceneSnapshots.set(key, {
      fileHandle,
      dataOffset: 4 + headerBytes.byteLength,
      byteLength: offset,
      geometries: specs,
      support,
    });
    console.info(
      `[UndoSpill] Spilled ${(offset / 1024 / 1024).toFixed(0)} MB in scene snapshot "${key}" ` +
      `(${candidates.length} geometries).`,
    );
    return true;
  } catch (error) {
    console.warn('[UndoSpill] Failed spilling scene snapshot; keeping it in memory.', error);
    if (fileHandle) {
      try {
        const directory = await spillDirectory();
        await directory?.removeEntry(`scene-${key}.bin`);
      } catch {
        // A stale scratch file is pruned on the next successful spill.
      }
    }
    return false;
  } finally {
    inFlightSpills.delete(key);
  }
}

/** Re-attaches the arrays a spilled snapshot owns. Returns false when the blob is gone. */
export async function rehydrateSceneSnapshotPair(key: string, pair: SceneSnapshotPair): Promise<boolean> {
  const spilled = spilledSceneSnapshots.get(key);
  if (!spilled) return false;

  try {
    const file = await spilled.fileHandle.getFile();
    const byUuid = new Map<string, THREE.BufferGeometry>();
    for (const geometry of pairGeometries(pair)) byUuid.set(geometry.uuid, geometry);

    for (const spec of spilled.geometries) {
      const geometry = byUuid.get(spec.uuid);
      if (!geometry) continue;
      if (Object.keys(geometry.attributes).length > 0) continue;

      for (const attributeSpec of spec.attributes) {
        const Ctor = constructorFor(attributeSpec.type);
        const buffer = await file
          .slice(spilled.dataOffset + attributeSpec.offset, spilled.dataOffset + attributeSpec.offset + attributeSpec.byteLength)
          .arrayBuffer();
        geometry.setAttribute(
          attributeSpec.name,
          new THREE.BufferAttribute(new Ctor(buffer) as never, attributeSpec.itemSize, attributeSpec.normalized),
        );
      }
      if (spec.index) {
        const Ctor = constructorFor(spec.index.type);
        const buffer = await file
          .slice(spilled.dataOffset + spec.index.offset, spilled.dataOffset + spec.index.offset + spec.index.byteLength)
          .arrayBuffer();
        geometry.setIndex(new THREE.BufferAttribute(new Ctor(buffer) as never, spec.index.itemSize, spec.index.normalized));
      }
      if (spec.hadBoundsTree) accelerateGeometry(geometry);
    }

    if (spilled.support) {
      const decoder = new TextDecoder();
      const readSupport = async (section: SupportSection | null): Promise<SupportState | undefined> => {
        if (!section) return undefined;
        const buffer = await file
          .slice(spilled.dataOffset + section.offset, spilled.dataOffset + section.offset + section.byteLength)
          .arrayBuffer();
        return JSON.parse(decoder.decode(buffer)) as SupportState;
      };
      pair.before.supportState = await readSupport(spilled.support.before);
      pair.after.supportState = await readSupport(spilled.support.after);
    }

    // The arrays are in RAM again and no history pair points at this file:
    // leaving it would strand a full copy of the scene on disk until the next
    // startup prunes it.
    void (async () => {
      try {
        const directory = await spillDirectory();
        await directory?.removeEntry(`scene-${key}.bin`);
      } catch {
        // Already gone.
      }
    })();
    spilledSceneSnapshots.delete(key);
    return true;
  } catch (error) {
    console.warn('[UndoSpill] Failed restoring spilled scene snapshot.', error);
    return false;
  }
}

export function disposeSpilledSceneSnapshot(key: string): void {
  const spilled = spilledSceneSnapshots.get(key);
  spilledSceneSnapshots.delete(key);
  if (!spilled) return;
  void (async () => {
    try {
      const directory = await spillDirectory();
      await directory?.removeEntry(`scene-${key}.bin`);
    } catch {
      // Already gone.
    }
  })();
}
