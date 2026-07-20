import * as THREE from 'three';
import {
  describeFullResMutatorSpliceError,
  stageFullResMutatorSource,
  type FullResMutatorSource,
} from '@/utils/fullResMutatorStaging';

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView, opts?: { headers?: Record<string, string> }) => Promise<T>;

interface TauriCoreModule {
  invoke: TauriInvoke;
}

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;
let stagedPunchSourceKey: string | null = null;

export interface PunchSpec {
  centerNorm: [number, number, number];
  radiusMm: number;
  radiusYMm?: number;
  direction?: [number, number, number];
  lengthMm?: number;
}

export interface PunchOptions {
  punches: PunchSpec[];
}

export interface PunchReport {
  sourceTriangleCount: number;
  outputTriangleCount: number;
  removedTriangleCount: number;
  punchCount: number;
}

export interface PunchResult {
  report: PunchReport;
  positions: Float32Array;
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke as TauriInvoke }))
      .catch(() => null);
  }
  return tauriCorePromise;
}

async function readStagedPositions(invoke: TauriInvoke): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>('mesh_repair_read_positions');
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error('mesh_repair_read_positions returned unexpected type');
  }

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

async function readPositionsFromCommand(
  invoke: TauriInvoke,
  command: 'mesh_repair_read_positions' | 'mesh_punch_read_positions',
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(command);
  let u8: Uint8Array;
  if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes);
  } else if (bytes instanceof Uint8Array) {
    u8 = bytes;
  } else if (Array.isArray(bytes)) {
    u8 = new Uint8Array(bytes);
  } else {
    throw new Error(`${command} returned unexpected type`);
  }

  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

function expandGeometryToTriangleSoup(geometry: THREE.BufferGeometry): Float32Array {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  const index = geometry.getIndex();

  if (!index) {
    if (positions instanceof Float32Array) return positions;
    return new Float32Array(positions as unknown as ArrayLike<number>);
  }

  const indexArr = index.array as Uint16Array | Uint32Array;
  const out = new Float32Array(indexArr.length * 3);
  for (let i = 0; i < indexArr.length; i += 1) {
    const vi = indexArr[i] * 3;
    const oi = i * 3;
    out[oi] = positions[vi];
    out[oi + 1] = positions[vi + 1];
    out[oi + 2] = positions[vi + 2];
  }
  return out;
}

async function stageGeometryToStagedMesh(
  invoke: TauriInvoke,
  geometry: THREE.BufferGeometry,
): Promise<void> {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!posAttr) throw new Error('stageGeometryToStagedMesh: geometry has no position attribute');

  const soup = expandGeometryToTriangleSoup(geometry);
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength);

  await invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

export async function punchFromGeometry(
  geometry: THREE.BufferGeometry,
  options: PunchOptions,
): Promise<PunchResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  await stageGeometryToStagedMesh(core.invoke, geometry);
  stagedPunchSourceKey = null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_punch_staged', { optionsJson });
  const report = JSON.parse(reportJson) as PunchReport;
  const positions = await readStagedPositions(core.invoke);
  return { report, positions };
}

/** Outcome of staging the punch source (Phase 4 full-res routing). */
export interface PunchSourceStageResult {
  /** False only outside the Tauri runtime (browser fallback). */
  staged: boolean;
  /** True when the full-resolution ORIGINAL file was staged (→ the caller must
   *  clear the native-preview marker; the output is full-res-derived). */
  usedFullRes: boolean;
  /** Present when full-res was requested but the source was missing/stale and
   *  staging fell back to the preview geometry (the user should be warned). */
  degraded?: { reason: string };
}

/**
 * Stages the punch source into the shared staged mesh + captures it as the
 * punch source. When `fullResSource` is provided (a native-preview model with a
 * stored frame datum), the ORIGINAL file is spliced Rust-side in the local
 * frame so the punch consumes full resolution — bytes never enter the WebView
 * (plan §C.2). A missing/stale source degrades to the preview geometry with a
 * reason (never silent). Cached by an effective source key.
 */
export async function stagePunchSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
  fullResSource?: FullResMutatorSource | null,
): Promise<PunchSourceStageResult> {
  const core = await loadTauriCore();
  if (!core) return { staged: false, usedFullRes: false };

  const effectiveKey = fullResSource
    ? `fullres::${fullResSource.sourcePath}::${fullResSource.originalTriangleCount}::${sourceKey}`
    : sourceKey;
  if (stagedPunchSourceKey === effectiveKey) {
    return { staged: true, usedFullRes: Boolean(fullResSource) };
  }

  if (fullResSource) {
    try {
      await stageFullResMutatorSource(core.invoke, fullResSource);
      await core.invoke('mesh_punch_capture_staged_source');
      stagedPunchSourceKey = effectiveKey;
      return { staged: true, usedFullRes: true };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const reason = describeFullResMutatorSpliceError(raw);
      console.warn(
        `[PunchFullRes] full-res source splice failed — punching the reduced preview instead: ${raw}`,
      );
      await stageGeometryToStagedMesh(core.invoke, geometry);
      await core.invoke('mesh_punch_capture_staged_source');
      stagedPunchSourceKey = sourceKey;
      return { staged: true, usedFullRes: false, degraded: { reason } };
    }
  }

  await stageGeometryToStagedMesh(core.invoke, geometry);
  await core.invoke('mesh_punch_capture_staged_source');
  stagedPunchSourceKey = effectiveKey;
  return { staged: true, usedFullRes: false };
}

export async function punchFromCapturedSource(
  options: PunchOptions,
): Promise<PunchResult | null> {
  const core = await loadTauriCore();
  if (!core) return null;

  const optionsJson = JSON.stringify(options);
  const reportJson = await core.invoke<string>('mesh_punch_from_captured_source', { optionsJson });
  const report = JSON.parse(reportJson) as PunchReport;
  const positions = await readPositionsFromCommand(core.invoke, 'mesh_punch_read_positions');
  return { report, positions };
}
