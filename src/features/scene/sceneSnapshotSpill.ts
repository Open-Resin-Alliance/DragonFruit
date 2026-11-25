import * as THREE from 'three';
import { accelerateGeometry } from '@/utils/bvh';
import { releaseGeometryStorage } from '@/utils/releaseGeometry';
import type { LoadedModel, SceneSnapshotPair } from '@/features/scene/useSceneCollectionManager';
import type { SupportState } from '@/supports/types';
import { loadTauriCore, type TauriInvoke } from '@/utils/tauriMeshBridge';

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

/**
 * Where spilled snapshots live: one file per history key.
 *
 * In the desktop app the files are written by Rust (`undo_spill.rs`). The origin
 * private file system was the only store until it turned out that WebKit has no
 * `FileSystemFileHandle.createWritable()` before Safari 26, so in the WKWebView of
 * macOS 12 to 15 every spill threw and each history entry kept a whole scene in
 * memory. The origin private file system is still what a browser uses, when it
 * has that method.
 */
export interface SpillStore {
  /** Writes `chunks`, in order, as the key's file, replacing any earlier one. */
  write(key: string, chunks: readonly Uint8Array[]): Promise<void>;
  read(key: string, offset: number, length: number): Promise<ArrayBuffer>;
  /** Deletes the key's file; one that is already gone is not an error. */
  remove(key: string): Promise<void>;
  /** Deletes every file whose key is not in `activeKeys`. */
  prune(activeKeys: ReadonlySet<string>): Promise<void>;
}

const fileName = (key: string) => `scene-${key}.bin`;

/** Bytes per IPC call. Each chunk is copied on its way to Rust, so it stays modest. */
const NATIVE_CHUNK_BYTES = 8 * 1024 * 1024;

export function nativeSpillStore(invoke: TauriInvoke): SpillStore {
  const remove = async (key: string) => {
    await invoke<void>('undo_spill_remove', { key });
  };
  return {
    async write(key, chunks) {
      let offset = 0;
      try {
        for (const chunk of chunks) {
          for (let start = 0; start < chunk.byteLength; start += NATIVE_CHUNK_BYTES) {
            const part = chunk.subarray(start, Math.min(start + NATIVE_CHUNK_BYTES, chunk.byteLength));
            offset = await invoke<number>('undo_spill_append', part, {
              headers: {
                'Content-Type': 'application/octet-stream',
                'x-undo-spill-key': key,
                'x-undo-spill-offset': String(offset),
              },
            });
          }
        }
      } catch (error) {
        await remove(key).catch(() => undefined);
        throw error;
      }
    },
    async read(key, offset, length) {
      const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('undo_spill_read', { key, offset, length });
      if (bytes instanceof ArrayBuffer) return bytes;
      const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      return view.slice().buffer;
    },
    remove,
    async prune(activeKeys) {
      await invoke<number>('undo_spill_prune', { activeKeys: [...activeKeys] });
    },
  };
}

function opfsWritable(): boolean {
  return typeof FileSystemFileHandle !== 'undefined'
    && typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function';
}

function opfsSpillStore(): SpillStore {
  const directory = async (): Promise<FileSystemDirectoryHandle> => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(SPILL_DIRECTORY, { create: true });
  };
  const remove = async (key: string) => {
    try {
      await (await directory()).removeEntry(fileName(key));
    } catch {
      // Already gone.
    }
  };
  return {
    async write(key, chunks) {
      const fileHandle = await (await directory()).getFileHandle(fileName(key), { create: true });
      try {
        const writable = await fileHandle.createWritable();
        for (const chunk of chunks) await writable.write(chunk as unknown as ArrayBufferView<ArrayBuffer>);
        await writable.close();
      } catch (error) {
        await remove(key);
        throw error;
      }
    },
    async read(key, offset, length) {
      const file = await (await (await directory()).getFileHandle(fileName(key))).getFile();
      return file.slice(offset, offset + length).arrayBuffer();
    },
    remove,
    async prune(activeKeys) {
      const dir = await directory();
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        if (handle.kind !== 'file' || !name.endsWith('.bin')) continue;
        const key = name.slice('scene-'.length, -'.bin'.length);
        if (!name.startsWith('scene-') || !activeKeys.has(key)) {
          await dir.removeEntry(name).catch(() => undefined);
        }
      }
    },
  };
}

let spillStorePromise: Promise<SpillStore | null> | null = null;

/** The store this runtime spills to, or null where there is none. Cached. */
function spillStore(): Promise<SpillStore | null> {
  if (!spillStorePromise) {
    spillStorePromise = loadTauriCore().then((core) => {
      if (core) return nativeSpillStore(core.invoke);
      if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' && opfsWritable()) return opfsSpillStore();
      return null;
    }).catch(() => null);
  }
  return spillStorePromise;
}

/** Points the spill at `store` (null: back to the runtime's own). Tests only. */
export function setSpillStoreForTests(store: SpillStore | null): void {
  spillStorePromise = store ? Promise.resolve(store) : null;
}

export function hasSpilledSceneSnapshot(key: string): boolean {
  return spilledSceneSnapshots.has(key);
}

/** Removes scratch files that no current history entry references (startup/HMR cleanup). */
export async function pruneSpilledSceneSnapshots(activeKeys: ReadonlySet<string>): Promise<void> {
  const store = await spillStore();
  if (!store) return;
  try {
    await store.prune(activeKeys);
  } catch (error) {
    console.warn('[UndoSpill] Failed pruning scratch snapshots.', error);
  }
}

/**
 * Writes a snapshot's geometry arrays to the scratch store, then clears the
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
  try {
    const store = await spillStore();
    if (!store) return false;

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
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
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

    const chunks: Uint8Array[] = [prefix, headerBytes];
    for (const { array, spec } of payloads) {
      chunks.push(new Uint8Array(array.buffer, array.byteOffset, spec.byteLength));
    }
    if (beforeSupport) chunks.push(beforeSupport);
    if (afterSupport) chunks.push(afterSupport);
    await store.write(key, chunks);

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
    // The store removes a half-written file itself.
    console.warn('[UndoSpill] Failed spilling scene snapshot; keeping it in memory.', error);
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
    const store = await spillStore();
    if (!store) return false;
    const readSection = (offset: number, byteLength: number) => (
      store.read(key, spilled.dataOffset + offset, byteLength)
    );
    const byUuid = new Map<string, THREE.BufferGeometry>();
    for (const geometry of pairGeometries(pair)) byUuid.set(geometry.uuid, geometry);

    for (const spec of spilled.geometries) {
      const geometry = byUuid.get(spec.uuid);
      if (!geometry) continue;
      if (Object.keys(geometry.attributes).length > 0) continue;

      for (const attributeSpec of spec.attributes) {
        const Ctor = constructorFor(attributeSpec.type);
        const buffer = await readSection(attributeSpec.offset, attributeSpec.byteLength);
        geometry.setAttribute(
          attributeSpec.name,
          new THREE.BufferAttribute(new Ctor(buffer) as never, attributeSpec.itemSize, attributeSpec.normalized),
        );
      }
      if (spec.index) {
        const Ctor = constructorFor(spec.index.type);
        const buffer = await readSection(spec.index.offset, spec.index.byteLength);
        geometry.setIndex(new THREE.BufferAttribute(new Ctor(buffer) as never, spec.index.itemSize, spec.index.normalized));
      }
      if (spec.hadBoundsTree) accelerateGeometry(geometry);
    }

    if (spilled.support) {
      const decoder = new TextDecoder();
      const readSupport = async (section: SupportSection | null): Promise<SupportState | undefined> => {
        if (!section) return undefined;
        const buffer = await readSection(section.offset, section.byteLength);
        return JSON.parse(decoder.decode(buffer)) as SupportState;
      };
      pair.before.supportState = await readSupport(spilled.support.before);
      pair.after.supportState = await readSupport(spilled.support.after);
    }

    // The arrays are in RAM again and no history pair points at this file:
    // leaving it would strand a full copy of the scene on disk until the next
    // startup prunes it.
    void store.remove(key).catch(() => undefined);
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
  void spillStore().then((store) => store?.remove(key)).catch(() => undefined);
}
