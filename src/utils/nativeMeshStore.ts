/**
 * The frontend's side of the native mesh store: the only module that puts meshes into it,
 * reads them back and drops them.
 *
 * The staging register (`stage_mesh_binary_set`) holds one mesh for the whole process, so
 * two passes in flight on different meshes read each other's. The store holds any number:
 * a mesh goes in, an id comes back, each command is told which id to work on, and a command
 * that produces a mesh returns its result's id as `meshId` in its JSON. See
 * `docs/dev/native-mesh-store.md`.
 *
 * Every entry belongs to this page load's client id. The first use in a page load opens the
 * client, which drops whatever an earlier load left behind.
 */
import * as THREE from 'three';
import { logToNativeFile } from './nativeLog';
import {
  decodeF32,
  expandGeometryToTriangleSoup,
  type TauriCoreModule,
} from './tauriMeshBridge';

/** Why an id did not resolve, as the store's error strings name it. */
export type NativeMeshStoreErrorCode = 'expired' | 'unknown' | 'wrong_kind';

/**
 * A store id that did not resolve. `expired` means the store released the entry to stay
 * inside its budget; `unknown` means it was never stored or was already dropped;
 * `wrong_kind` means it holds another kind of entry than the command needs (a session where
 * a mesh was expected, say). None is retried here: a silent re-upload would hide the caller
 * that held an id too long.
 */
export class NativeMeshStoreError extends Error {
  readonly code: NativeMeshStoreErrorCode;

  constructor(code: NativeMeshStoreErrorCode, message: string) {
    super(message);
    this.name = 'NativeMeshStoreError';
    this.code = code;
  }
}

const STORE_ERROR_PATTERN = /^mesh-store\/(expired|unknown|wrong_kind):/;

/** The store error a rejected command carries, or null when it is some other failure. */
export function asNativeMeshStoreError(error: unknown): NativeMeshStoreError | null {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const match = STORE_ERROR_PATTERN.exec(message);
  if (!match) return null;
  return new NativeMeshStoreError(match[1] as NativeMeshStoreErrorCode, message);
}

/** Rethrows a store error as a {@link NativeMeshStoreError}, logged; anything else unchanged. */
function rethrowNativeMeshStoreError(error: unknown): never {
  const storeError = asNativeMeshStoreError(error);
  if (storeError) {
    void logToNativeFile('warn', `[nativeMeshStore] ${storeError.message}`);
    throw storeError;
  }
  throw error;
}

let clientId: string | null = null;
let clientOpened: Promise<string> | null = null;

/**
 * This page load's client id, opened in the store on first call. Opening drops the entries
 * of earlier page loads, so it runs once, before the first put.
 */
export function openNativeMeshClient(core: TauriCoreModule): Promise<string> {
  if (!clientOpened) {
    clientId ??= crypto.randomUUID();
    const id = clientId;
    clientOpened = core
      .invoke<number>('mesh_store_open_client', { clientId: id })
      .then(() => id)
      .catch((error: unknown) => {
        clientOpened = null;
        throw error;
      });
  }
  return clientOpened;
}

/** Puts a geometry into the store as a triangle soup and returns its id. */
export function putNativeMesh(
  core: TauriCoreModule,
  geometry: THREE.BufferGeometry,
): Promise<string> {
  return putNativeSoup(core, expandGeometryToTriangleSoup(geometry));
}

/**
 * Puts a triangle soup (nine floats per triangle) into the store and returns its id, for a
 * caller that has to change the positions first, such as scaling them to printed size.
 */
export async function putNativeSoup(core: TauriCoreModule, soup: Float32Array): Promise<string> {
  const client = await openNativeMeshClient(core);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);
  return core.invoke<string>('mesh_store_put', bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-mesh-client-id': client,
    },
  });
}

/**
 * Reads a stored mesh's positions. With `release`, the entry is dropped as it is read, and
 * the bytes leave Rust without a copy; that is how a result is collected.
 */
export async function readNativeMesh(
  core: TauriCoreModule,
  meshId: string,
  { release = false }: { release?: boolean } = {},
): Promise<Float32Array> {
  try {
    const bytes = await core.invoke<ArrayBuffer | Uint8Array | number[]>('mesh_store_read', {
      meshId,
      release,
    });
    return decodeF32(bytes, 'mesh_store_read');
  } catch (error) {
    return rethrowNativeMeshStoreError(error);
  }
}

/**
 * Reads a stored buffer (or a soup) as raw bytes, copied into a buffer of its own so a typed
 * view of any element size lines up. With `release`, the entry is dropped as it is read.
 */
export async function readNativeBuffer(
  core: TauriCoreModule,
  bufferId: string,
  { release = false }: { release?: boolean } = {},
): Promise<ArrayBuffer> {
  try {
    const bytes = await core.invoke<ArrayBuffer | Uint8Array | number[]>('mesh_store_read', {
      meshId: bufferId,
      release,
    });
    const u8 = bytes instanceof ArrayBuffer || Array.isArray(bytes)
      ? new Uint8Array(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : null;
    if (!u8) throw new Error('mesh_store_read returned unexpected type');
    const copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return copy.buffer;
  } catch (error) {
    return rethrowNativeMeshStoreError(error);
  }
}

/** Drops ids. One already gone is not an error. */
export async function dropNativeMeshes(core: TauriCoreModule, meshIds: string[]): Promise<void> {
  if (meshIds.length === 0) return;
  await core.invoke<number>('mesh_store_drop', { meshIds });
}

/**
 * The result id a command reported as `meshId` in its JSON. Throws when it is missing, which
 * means the command ran on the staging register instead of the store.
 */
export function resultMeshId(commandResult: unknown, command: string): string {
  const meshId = commandResult != null && typeof commandResult === 'object'
    ? (commandResult as { meshId?: unknown }).meshId
    : undefined;
  if (typeof meshId !== 'string' || meshId.length === 0) {
    throw new Error(`${command} returned no meshId: it did not run on the native mesh store`);
  }
  return meshId;
}

/** Collects a command's result: reads its positions and drops the entry. */
export function takeResultPositions(
  core: TauriCoreModule,
  commandResult: unknown,
  command: string,
): Promise<Float32Array> {
  return readNativeMesh(core, resultMeshId(commandResult, command), { release: true });
}

/**
 * Puts a geometry into the store for the length of `pass`, and drops it afterwards whether
 * the pass succeeds or not. Results the pass collects are its own to drop.
 */
export async function withNativeMesh<T>(
  core: TauriCoreModule,
  geometry: THREE.BufferGeometry,
  pass: (meshId: string) => Promise<T>,
): Promise<T> {
  const meshId = await putNativeMesh(core, geometry);
  try {
    return await pass(meshId);
  } catch (error) {
    return rethrowNativeMeshStoreError(error);
  } finally {
    await dropNativeMeshes(core, [meshId]).catch(() => undefined);
  }
}

/**
 * Puts a triangle soup into the store for the length of `pass`, as `withNativeMesh` does for a
 * geometry. A pass that consumes its input (the island and overhang scans) leaves nothing to
 * drop; one that fails before it does still has its soup dropped.
 */
export async function withNativeSoup<T>(
  core: TauriCoreModule,
  soup: Float32Array,
  pass: (meshId: string) => Promise<T>,
): Promise<T> {
  const meshId = await putNativeSoup(core, soup);
  try {
    return await pass(meshId);
  } catch (error) {
    return rethrowNativeMeshStoreError(error);
  } finally {
    await dropNativeMeshes(core, [meshId]).catch(() => undefined);
  }
}

/** The store's counters: entries, bytes, peak, evictions and expired reads. */
export interface NativeMeshStoreStats {
  entries: number;
  bytes: number;
  peakBytes: number;
  budgetBytes: number;
  evictions: number;
  expiredReads: number;
}

export function nativeMeshStoreStats(core: TauriCoreModule): Promise<NativeMeshStoreStats> {
  return core.invoke<NativeMeshStoreStats>('mesh_store_stats');
}
