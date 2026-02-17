import * as THREE from 'three';

type BrushListener = () => void;

export type MeshSmoothingBrushState = {
  hoverPoint: THREE.Vector3 | null;
  hoverNormal: THREE.Vector3 | null;
  isStrokeActive: boolean;
  strokeStartPoint: THREE.Vector3 | null;
  strokeLastPoint: THREE.Vector3 | null;
  strokeLastNormal: THREE.Vector3 | null;
  strokePreviewPositions: Float32Array;
  strokePreviewNormals: Float32Array;
  strokePreviewCount: number;
  strokePreviewVersion: number;
};

const MAX_STROKE_PREVIEW_POINTS = 8192;
let strokePreviewPositions = new Float32Array(MAX_STROKE_PREVIEW_POINTS * 3);
let strokePreviewNormals = new Float32Array(MAX_STROKE_PREVIEW_POINTS * 3);
let strokePreviewCount = 0;
let strokePreviewVersion = 0;

function resetStrokePreview(): void {
  strokePreviewCount = 0;
  strokePreviewVersion++;
}

function pushStrokePreview(point: THREE.Vector3, normal: THREE.Vector3 | null): void {
  if (strokePreviewCount >= MAX_STROKE_PREVIEW_POINTS) return;

  const minSpacing = 0.01;
  const minSpacing2 = minSpacing * minSpacing;
  const maxStep = 0.1;

  if (strokePreviewCount > 0) {
    const i3 = (strokePreviewCount - 1) * 3;
    const dx = point.x - strokePreviewPositions[i3 + 0];
    const dy = point.y - strokePreviewPositions[i3 + 1];
    const dz = point.z - strokePreviewPositions[i3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    // Small spacing to avoid excessive instance updates.
    if (d2 < minSpacing2) return;

    const nIn = normal ?? currentState.strokeLastNormal ?? new THREE.Vector3(0, 0, 1);
    const nxIn = nIn.x;
    const nyIn = nIn.y;
    const nzIn = nIn.z;
    const nLen = Math.sqrt(nxIn * nxIn + nyIn * nyIn + nzIn * nzIn) || 1;
    const nxNew = nxIn / nLen;
    const nyNew = nyIn / nLen;
    const nzNew = nzIn / nLen;

    const lastNx = strokePreviewNormals[i3 + 0] ?? 0;
    const lastNy = strokePreviewNormals[i3 + 1] ?? 0;
    const lastNz = strokePreviewNormals[i3 + 2] ?? 1;

    const dist = Math.sqrt(d2);
    if (dist > maxStep) {
      const steps = Math.min(16, Math.ceil(dist / maxStep));
      const x0 = strokePreviewPositions[i3 + 0] ?? 0;
      const y0 = strokePreviewPositions[i3 + 1] ?? 0;
      const z0 = strokePreviewPositions[i3 + 2] ?? 0;

      for (let s = 1; s < steps; s++) {
        if (strokePreviewCount >= MAX_STROKE_PREVIEW_POINTS) break;
        const t = s / steps;
        const wMid = strokePreviewCount * 3;

        strokePreviewPositions[wMid + 0] = x0 + (point.x - x0) * t;
        strokePreviewPositions[wMid + 1] = y0 + (point.y - y0) * t;
        strokePreviewPositions[wMid + 2] = z0 + (point.z - z0) * t;

        // Linear interpolate normals and renormalize.
        const mx = lastNx + (nxNew - lastNx) * t;
        const my = lastNy + (nyNew - lastNy) * t;
        const mz = lastNz + (nzNew - lastNz) * t;
        const mLen = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
        strokePreviewNormals[wMid + 0] = mx / mLen;
        strokePreviewNormals[wMid + 1] = my / mLen;
        strokePreviewNormals[wMid + 2] = mz / mLen;

        strokePreviewCount++;
      }
    }

    // Write the final point.
    const wFinal = strokePreviewCount * 3;
    strokePreviewPositions[wFinal + 0] = point.x;
    strokePreviewPositions[wFinal + 1] = point.y;
    strokePreviewPositions[wFinal + 2] = point.z;
    strokePreviewNormals[wFinal + 0] = nxNew;
    strokePreviewNormals[wFinal + 1] = nyNew;
    strokePreviewNormals[wFinal + 2] = nzNew;

    strokePreviewCount++;
    strokePreviewVersion++;
    return;
  }

  const w = strokePreviewCount * 3;
  strokePreviewPositions[w + 0] = point.x;
  strokePreviewPositions[w + 1] = point.y;
  strokePreviewPositions[w + 2] = point.z;

  const n = normal ?? currentState.strokeLastNormal ?? new THREE.Vector3(0, 0, 1);
  const nx = n.x;
  const ny = n.y;
  const nz = n.z;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  strokePreviewNormals[w + 0] = nx / len;
  strokePreviewNormals[w + 1] = ny / len;
  strokePreviewNormals[w + 2] = nz / len;

  strokePreviewCount++;
  strokePreviewVersion++;
}

let currentState: MeshSmoothingBrushState = {
  hoverPoint: null,
  hoverNormal: null,
  isStrokeActive: false,
  strokeStartPoint: null,
  strokeLastPoint: null,
  strokeLastNormal: null,
  strokePreviewPositions,
  strokePreviewNormals,
  strokePreviewCount,
  strokePreviewVersion,
};

const listeners = new Set<BrushListener>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[MeshSmoothingBrush] listener error', err);
    }
  });
}

export function getMeshSmoothingBrushState(): MeshSmoothingBrushState {
  return currentState;
}

export function subscribeToMeshSmoothingBrushState(listener: BrushListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMeshSmoothingHoverPoint(point: THREE.Vector3 | null): void {
  currentState = {
    ...currentState,
    hoverPoint: point,
    hoverNormal: null,
  };
  notify();
}

export function setMeshSmoothingHover(point: THREE.Vector3 | null, normal: THREE.Vector3 | null): void {
  currentState = {
    ...currentState,
    hoverPoint: point,
    hoverNormal: normal,
  };
  notify();
}

export function beginMeshSmoothingStroke(point: THREE.Vector3, normal: THREE.Vector3 | null): void {
  resetStrokePreview();
  pushStrokePreview(point, normal);
  currentState = {
    ...currentState,
    isStrokeActive: true,
    hoverPoint: point,
    hoverNormal: normal,
    strokeStartPoint: point,
    strokeLastPoint: point,
    strokeLastNormal: normal,
    strokePreviewPositions,
    strokePreviewNormals,
    strokePreviewCount,
    strokePreviewVersion,
  };
  notify();
}

export function updateMeshSmoothingStroke(point: THREE.Vector3, normal: THREE.Vector3 | null): void {
  if (currentState.isStrokeActive) {
    pushStrokePreview(point, normal);
  }
  currentState = {
    ...currentState,
    hoverPoint: point,
    hoverNormal: normal,
    strokeLastPoint: currentState.isStrokeActive ? point : currentState.strokeLastPoint,
    strokeLastNormal: currentState.isStrokeActive ? normal : currentState.strokeLastNormal,
    strokePreviewPositions,
    strokePreviewNormals,
    strokePreviewCount,
    strokePreviewVersion,
  };
  notify();
}

export function endMeshSmoothingStroke(): void {
  if (!currentState.isStrokeActive) return;

  resetStrokePreview();
  currentState = {
    ...currentState,
    isStrokeActive: false,
    strokeStartPoint: null,
    strokeLastPoint: null,
    strokeLastNormal: null,
    strokePreviewPositions,
    strokePreviewNormals,
    strokePreviewCount,
    strokePreviewVersion,
  };
  notify();
}
