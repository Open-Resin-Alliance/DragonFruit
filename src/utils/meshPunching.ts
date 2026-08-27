import * as THREE from 'three';
import {
  loadTauriCore,
  readPositionsFromCommand,
  stageGeometryToStagedMesh,
} from './tauriMeshBridge';

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
  const positions = await readPositionsFromCommand(core.invoke, 'mesh_repair_read_positions');
  return { report, positions };
}

export async function stagePunchSource(
  geometry: THREE.BufferGeometry,
  sourceKey: string,
): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) return false;

  if (stagedPunchSourceKey === sourceKey) {
    return true;
  }

  await stageGeometryToStagedMesh(core.invoke, geometry);
  await core.invoke('mesh_punch_capture_staged_source');
  stagedPunchSourceKey = sourceKey;
  return true;
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
