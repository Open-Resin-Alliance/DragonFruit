import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { isTauriRuntime } from '@/utils/meshRepair';

export type ReconstructionEndpointKind = 'plate' | 'model' | 'support' | 'open';

export type ReconstructionConfidence = {
  primitiveFit: number;
  endpointClassification: number;
  attachmentFit: number;
  topology: number;
  finalConfidence: number;
};

export type ReconstructionVec3 = { x: number; y: number; z: number };

export type ReconstructionAxialCandidate = {
  id: string;
  sourceComponentId: number;
  axis: ReconstructionVec3;
  start: ReconstructionVec3;
  end: ReconstructionVec3;
  shaftStart: ReconstructionVec3;
  shaftEnd: ReconstructionVec3;
  accepted: boolean;
  lengthMm: number;
  shaftLengthMm: number;
  startTransitionLengthMm: number;
  endTransitionLengthMm: number;
  startRadiusMm: number;
  endRadiusMm: number;
  meanRadiusMm: number;
  radialResidualMm: number;
  aspectRatio: number;
  confidence: ReconstructionConfidence;
  rejectionCodes: string[];
};

export type ReconstructionEndpointCandidate = {
  id: string;
  axialCandidateId: string;
  sourceComponentId: number;
  side: 'start' | 'end';
  kind: ReconstructionEndpointKind;
  sourcePosition: ReconstructionVec3;
  resolvedPosition: ReconstructionVec3;
  distanceMm?: number | null;
  surfaceNormal?: ReconstructionVec3 | null;
  modelFaceIndex?: number | null;
  confidence: number;
};

export type ReconstructionRootCandidate = {
  id: string;
  axialCandidateId: string;
  endpointId: string;
  sourceComponentId: number;
  position: ReconstructionVec3;
  diameterMm: number;
  confidence: ReconstructionConfidence;
};

export type ReconstructionContactCandidate = {
  id: string;
  axialCandidateId: string;
  endpointId: string;
  sourceComponentId: number;
  position: ReconstructionVec3;
  surfaceNormal: ReconstructionVec3;
  diameterMm: number;
  modelFaceIndex: number;
  distanceMm: number;
  confidence: ReconstructionConfidence;
};

export type ReconstructionAttachmentCandidate = {
  id: string;
  endpointId: string;
  guestAxialCandidateId: string;
  sourceComponentId: number;
  position: ReconstructionVec3;
  hostAxialCandidateId: string;
  hostT: number;
  distanceMm: number;
  confidence: ReconstructionConfidence;
};

export type ReconstructionTopologyCandidate = {
  id: string;
  kind: 'trunk' | 'branch' | 'brace' | 'unresolved';
  axialCandidateId: string;
  rootIds: string[];
  contactIds: string[];
  attachmentIds: string[];
  confidence: ReconstructionConfidence;
  rejectionCodes: string[];
};

export type SupportReconstructionResult = {
  schemaVersion: number;
  analyzerVersion: string;
  modelTriangleCount: number;
  supportTriangleCount: number;
  components: Array<{
    id: number;
    triangleCount: number;
    vertexCount: number;
    surfaceAreaMm2: number;
    touchesPlate: boolean;
  }>;
  graph: {
    roots: ReconstructionRootCandidate[];
    axialCandidates: ReconstructionAxialCandidate[];
    endpoints: ReconstructionEndpointCandidate[];
    joints: unknown[];
    contacts: ReconstructionContactCandidate[];
    attachments: ReconstructionAttachmentCandidate[];
    topologyCandidates: ReconstructionTopologyCandidate[];
    edges: Array<{ from: string; to: string; kind: string }>;
  };
  coverage: {
    sourceTriangleCount: number;
    matchedTriangleCount: number;
    unmatchedTriangleCount: number;
    surfaceCoverage: number;
  };
  warnings: Array<{
    code: string;
    message: string;
    sourceComponentId?: number | null;
  }>;
  timings: {
    preprocessMs: number;
    componentAnalysisMs: number;
    totalMs: number;
  };
};

type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown> | ArrayBuffer | ArrayBufferView,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

function assertFiniteJson(value: unknown, path = 'result'): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Support reconstruction returned a non-finite number at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteJson(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => assertFiniteJson(entry, `${path}.${key}`));
  }
}

export function normalizeSupportReconstructionResult(value: unknown): SupportReconstructionResult {
  assertFiniteJson(value);
  if (!value || typeof value !== 'object') {
    throw new Error('Support reconstruction returned an invalid result');
  }
  const raw = value as Partial<SupportReconstructionResult>;
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported support reconstruction schema ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.analyzerVersion !== 'string' || !raw.graph || !raw.coverage || !raw.timings) {
    throw new Error('Support reconstruction result is missing required fields');
  }
  const graph = raw.graph as Partial<SupportReconstructionResult['graph']>;
  if (
    !Array.isArray(raw.components)
    || !Array.isArray(raw.warnings)
    || !Array.isArray(graph.roots)
    || !Array.isArray(graph.axialCandidates)
    || !Array.isArray(graph.endpoints)
    || !Array.isArray(graph.contacts)
    || !Array.isArray(graph.attachments)
    || !Array.isArray(graph.topologyCandidates)
    || !Array.isArray(graph.edges)
  ) {
    throw new Error('Support reconstruction result contains invalid collections');
  }
  return value as SupportReconstructionResult;
}

export function transformTriangleSoupToWorld(source: Float32Array, matrix: THREE.Matrix4): Float32Array {
  const output = new Float32Array(source.length);
  const point = new THREE.Vector3();
  for (let offset = 0; offset < source.length; offset += 3) {
    point.set(source[offset], source[offset + 1], source[offset + 2]).applyMatrix4(matrix);
    output[offset] = point.x;
    output[offset + 1] = point.y;
    output[offset + 2] = point.z;
  }
  return output;
}

export function canReconstructClassifiedSupports(model: LoadedModel | null | undefined): boolean {
  const modelTriangleCount = Math.floor(
    model?.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0,
  );
  if (!model || modelTriangleCount <= 0) return false;
  const position = model.geometry.geometry.getAttribute('position');
  return Boolean(position && modelTriangleCount * 9 < position.array.length);
}

export async function reconstructClassifiedSupports(
  model: LoadedModel,
): Promise<SupportReconstructionResult> {
  if (!isTauriRuntime()) {
    throw new Error('Support reconstruction is available in DragonFruit Desktop only.');
  }
  const modelTriangleCount = Math.floor(
    model.geometry.meshDefects?.nativeRepairReport?.model_triangle_count ?? 0,
  );
  const position = model.geometry.geometry.getAttribute('position') as THREE.BufferAttribute | null;
  if (!position || modelTriangleCount <= 0) {
    throw new Error('This mesh does not have a classified model/support split.');
  }
  const rawPositions = position.array instanceof Float32Array
    ? position.array
    : new Float32Array(position.array as unknown as ArrayLike<number>);
  const modelFloatCount = modelTriangleCount * 9;
  if (modelFloatCount >= rawPositions.length || rawPositions.length % 9 !== 0) {
    throw new Error('The classified triangle boundary is invalid.');
  }

  const matrix = new THREE.Matrix4().compose(
    model.transform.position,
    new THREE.Quaternion().setFromEuler(model.transform.rotation),
    model.transform.scale,
  );
  const worldPositions = transformTriangleSoupToWorld(rawPositions, matrix);
  const bytes = new Uint8Array(
    worldPositions.buffer,
    worldPositions.byteOffset,
    worldPositions.byteLength,
  );

  const core = await import('@tauri-apps/api/core');
  const invoke = core.invoke as TauriInvoke;
  await invoke('stage_mesh_binary_set', bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const json = await invoke<string>('mesh_reconstruct_supports_staged', {
    modelFloatCount,
    plateZMm: 0,
    optionsJson: '',
  });
  return normalizeSupportReconstructionResult(JSON.parse(json));
}
