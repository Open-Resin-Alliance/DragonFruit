import JSZip from 'jszip';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import {
  getSavedSlicingPerformanceSettings,
  type PngCompressionStrategy,
} from '@/components/settings/performancePreferences';
import { getSnapshot as getSupportSnapshot } from '@/supports/state';
import { getKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
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
import type { ContactDisk } from '@/supports/types';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getBezierPointAtT } from '@/supports/Curves/BezierUtils';
import { getTrunkSegmentEndpoints, getBranchSegmentEndpoints } from '@/supports/SupportPrimitives/Knot/knotUtils';
import { resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';

const MAX_CANVAS_PIXELS = 24_000_000;
const DEFAULT_MESH_CHUNK_TARGET_BYTES = 64 * 1024 * 1024;
const MIN_MESH_CHUNK_TARGET_BYTES = 16 * 1024 * 1024;
const MAX_MESH_CHUNK_TARGET_BYTES = 256 * 1024 * 1024;

type EdgeKey = string;

function edgeKey(a: number, b: number): EdgeKey {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function edgeLen(a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export type RasterLayerZipExportOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  outputMode?: 'download' | 'return';
  abortSignal?: AbortSignal;
  onProgress?: (done: number, total: number, phase: string) => void;
  flushBinaryMeshChunk?: (chunk: Uint8Array) => Promise<void>;
  meshChunkTargetBytes?: number;
};

function normalizeMeshChunkTargetBytes(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MESH_CHUNK_TARGET_BYTES;
  }

  const rounded = Math.floor(value as number);
  return Math.max(
    MIN_MESH_CHUNK_TARGET_BYTES,
    Math.min(MAX_MESH_CHUNK_TARGET_BYTES, rounded),
  );
}

function createAbortError(message = 'Slicing canceled by user.'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function emitMeshPrepDiagnostic(
  phase: string,
  done: number,
  total: number,
  extra?: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('dragonfruit:slicing-progress', {
    detail: {
      phase,
      done,
      total,
      ...extra,
    },
  }));
}

export type RasterLayerZipArtifact = {
  blob: Blob;
  outputName: string;
  totalLayers: number;
};

type RasterizedLayerEntry = {
  name: string;
  blob: Blob;
};

type RasterizationResult = {
  settings: EffectiveSettings;
  totalLayers: number;
  tallestObjectHeightMm: number;
  visibleModels: LoadedModel[];
  layerEntries: RasterizedLayerEntry[];
  manifest: Record<string, unknown>;
};

export type RasterizedLayerStackForWasm = {
  widthPx: number;
  heightPx: number;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
  layerPngs: Uint8Array[];
  metadataJson: string;
};

export type SolidSliceMeshForWasm = {
  sourceWidthPx: number;
  sourceHeightPx: number;
  widthPx: number;
  heightPx: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  computeBackend: 'auto' | 'cpu' | 'gpu';
  pngCompressionStrategy: PngCompressionStrategy;
  bvhAccelerationEnabled: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  modelTriangleCount: number;
  buildWidthMm: number;
  buildDepthMm: number;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
  trianglesXYZ: Float32Array;
  meshBounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  metadataJson: string;
};

type RasterTriangle = {
  zMin: number;
  zMax: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
};

type WorldTriangle = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  zMin: number;
  zMax: number;
};

export type ProjectedCrossSectionContext = {
  triangles: WorldTriangle[];
  quantizedBucketsByStep: Map<string, ProjectedCrossSectionQuantizedBuckets>;
};

type ProjectedCrossSectionQuantizedBuckets = {
  stepMm: number;
  baseLayer: number;
  buckets: number[][];
};

type SliceSegment2D = {
  x1: number;
  y1: number;
  dxDy: number;
  yMin: number;
  yMax: number;
  wind: number;
};

type EffectiveSettings = {
  widthPx: number;
  heightPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  mirrorX: boolean;
  mirrorY: boolean;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
};

function resolvePluginPackedWidth(printerProfile: PrinterProfile): {
  widthPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
} {
  const sourceResolutionX = Math.max(1, Math.round(printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(printerProfile.display.resolutionY));

  const explicitBitDepth = Number(printerProfile.bitDepth?.bits);
  let bitDepth = Number.isFinite(explicitBitDepth) && explicitBitDepth > 0
    ? Math.round(explicitBitDepth)
    : 0;

  if (bitDepth <= 0) {
    const fingerprint = [
      printerProfile.name,
      printerProfile.manufacturer,
      printerProfile.officialPresetId,
      printerProfile.id,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    if (/\b3\s*[-_ ]?bit\b|\b3b\b|16k3b|gray3/.test(fingerprint)) {
      bitDepth = 3;
    } else if (/\b8\s*[-_ ]?bit\b|\b8b\b|rgb8/.test(fingerprint)) {
      bitDepth = 8;
    } else {
      const divisibleBy2 = sourceResolutionX % 2 === 0;
      const divisibleBy3 = sourceResolutionX % 3 === 0;

      if (divisibleBy2 && !divisibleBy3) {
        bitDepth = 3;
      } else if (divisibleBy3 && !divisibleBy2) {
        bitDepth = 8;
      } else if (divisibleBy2 && divisibleBy3) {
        // Ambiguous resolution: prefer Mono/3-bit path for Athena-class NanoDLP printers.
        bitDepth = /rgb|color/.test(fingerprint) ? 8 : 3;
      } else {
        // Failsafe: NanoDLP path should remain packed; default to 3-bit packing.
        bitDepth = 3;
      }
    }
  }

  const isLikely16kClass = sourceResolutionX >= 15000 && sourceResolutionX <= 15400;
  // Align with proven VoxelShift mapping for Athena-class 16K panels:
  // - 16K 8-bit path uses 15120 subpixels -> 5040 RGB pixels
  // - 16K 3-bit path uses 15136 subpixels -> 7568 grayscale pixels
  // This also fixes legacy profiles persisted with 15120 on 3-bit mode.
  const canonicalSourceResolutionX = isLikely16kClass
    ? (bitDepth === 3 ? 15136 : bitDepth === 8 ? 15120 : sourceResolutionX)
    : sourceResolutionX;

  if (bitDepth === 8) {
    // NanoDLP RGB 8-bit path packs 3 subpixels into 1 RGB output pixel on X.
    return {
      widthPx: Math.max(1, Math.floor(canonicalSourceResolutionX / 3)),
      sourceResolutionX: canonicalSourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'rgb8_div3',
    };
  }

  if (bitDepth === 3) {
    // NanoDLP 3-bit path packs 2 source subpixels into 1 grayscale output pixel on X.
    return {
      widthPx: Math.max(1, Math.floor(canonicalSourceResolutionX / 2)),
      sourceResolutionX: canonicalSourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'gray3_div2',
    };
  }

  // Unknown/unsupported bit-depth values still default to 3-bit packed path for NanoDLP.
  return {
    widthPx: Math.max(1, Math.floor(canonicalSourceResolutionX / 2)),
    sourceResolutionX: canonicalSourceResolutionX,
    sourceResolutionY,
    xPackingMode: 'gray3_div2',
  };
}

function clampLayerIndex(index: number, totalLayers: number): number {
  if (index < 0) return 0;
  if (index >= totalLayers) return totalLayers - 1;
  return index;
}

function buildLayerTriangleBuckets(
  triangles: RasterTriangle[],
  totalLayers: number,
  layerHeightMm: number,
): number[][] {
  const buckets: number[][] = Array.from({ length: totalLayers }, () => []);

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    if (tri.zMax < 0) continue;

    const startLayer = clampLayerIndex(Math.floor(tri.zMin / layerHeightMm), totalLayers);
    const endLayer = clampLayerIndex(Math.floor(tri.zMax / layerHeightMm), totalLayers);

    for (let layer = startLayer; layer <= endLayer; layer += 1) {
      buckets[layer].push(triIndex);
    }
  }

  return buckets;
}

function shouldEmitProgress(layerIndex: number, totalLayers: number): boolean {
  if (layerIndex === 0) return true;
  if (layerIndex === totalLayers - 1) return true;
  return layerIndex % 10 === 9;
}

function sameIndexSet(a: number[] | null, b: number[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function safeFilenameBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'slice_export';
  const cleaned = trimmed.replace(/[^a-z0-9-_]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'slice_export';
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { msSaveOrOpenBlob?: (payload: Blob, name?: string) => boolean })
    : null;

  if (nav?.msSaveOrOpenBlob) {
    nav.msSaveOrOpenBlob(blob, filename);
    return;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Browser download APIs are unavailable in this runtime.');
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body?.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

class TriangleFloatCollector {
  private data: Float32Array;

  private cursor = 0;

  private triangleCountValue = 0;

  private maxZValue = -Infinity;

  private minXValue = Infinity;

  private minYValue = Infinity;

  private minZValue = Infinity;

  private maxXValue = -Infinity;

  private maxYValue = -Infinity;
  
  private flushCallback?: (chunk: Uint8Array) => Promise<void>;
  
  private flushChain: Promise<void> = Promise.resolve();
  
  private chunkElementLimit = Number.POSITIVE_INFINITY;

  constructor(
    initialTriangleCapacity: number,
    flushCallback?: (chunk: Uint8Array) => Promise<void>,
    chunkTargetBytes?: number,
  ) {
    const safeTriangleCapacity = Math.max(1, Math.floor(initialTriangleCapacity));
    this.data = new Float32Array(safeTriangleCapacity * 9);
    this.flushCallback = flushCallback;

    if (flushCallback) {
      const normalizedChunkBytes = normalizeMeshChunkTargetBytes(chunkTargetBytes);
      this.chunkElementLimit = Math.max(
        9,
        Math.floor(normalizedChunkBytes / Float32Array.BYTES_PER_ELEMENT),
      );
    }
  }

  get triangleCount(): number {
    return this.triangleCountValue;
  }

  get maxZ(): number {
    return this.maxZValue;
  }

  get meshBounds() {
    return {
      minX: this.minXValue,
      minY: this.minYValue,
      minZ: this.minZValue,
      maxX: this.maxXValue,
      maxY: this.maxYValue,
      maxZ: this.maxZValue,
    };
  }

  pushTriangle(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    this.ensureCapacity(9);
    const base = this.cursor;
    this.data[base] = ax;
    this.data[base + 1] = ay;
    this.data[base + 2] = az;
    this.data[base + 3] = bx;
    this.data[base + 4] = by;
    this.data[base + 5] = bz;
    this.data[base + 6] = cx;
    this.data[base + 7] = cy;
    this.data[base + 8] = cz;
    this.cursor = base + 9;
    this.triangleCountValue += 1;

    const triMaxZ = Math.max(az, bz, cz);
    if (triMaxZ > this.maxZValue) {
      this.maxZValue = triMaxZ;
    }

    const triMinX = Math.min(ax, bx, cx);
    const triMinY = Math.min(ay, by, cy);
    const triMinZ = Math.min(az, bz, cz);
    const triMaxX = Math.max(ax, bx, cx);
    const triMaxY = Math.max(ay, by, cy);

    if (triMinX < this.minXValue) this.minXValue = triMinX;
    if (triMinY < this.minYValue) this.minYValue = triMinY;
    if (triMinZ < this.minZValue) this.minZValue = triMinZ;
    if (triMaxX > this.maxXValue) this.maxXValue = triMaxX;
    if (triMaxY > this.maxYValue) this.maxYValue = triMaxY;
  }

  appendWorldTriangles(triangles: WorldTriangle[]): void {
    for (let i = 0; i < triangles.length; i += 1) {
      const tri = triangles[i];
      this.pushTriangle(
        tri.ax,
        tri.ay,
        tri.az,
        tri.bx,
        tri.by,
        tri.bz,
        tri.cx,
        tri.cy,
        tri.cz,
      );
    }
  }

  async finalize(): Promise<Float32Array> {
    if (this.flushCallback) {
      if (this.cursor > 0) {
        const remaining = new Uint8Array(this.data.buffer, this.data.byteOffset, this.cursor * 4);
        this.flushChain = this.flushChain.then(() => this.flushCallback!(remaining));
        this.cursor = 0;
      }
      await this.flushChain;
      return new Float32Array(0); // Sent gradually!
    }

    if (this.cursor === this.data.length) {
      return this.data;
    }
    return this.data.slice(0, this.cursor);
  }

  private ensureCapacity(additionalFloats: number): void {
    const required = this.cursor + additionalFloats;

    if (this.flushCallback && required >= this.chunkElementLimit) {
      const chunk = new Uint8Array(this.data.buffer, this.data.byteOffset, this.cursor * 4);
      this.flushChain = this.flushChain.then(() => this.flushCallback!(chunk));
      
      this.data = new Float32Array(this.chunkElementLimit);
      this.cursor = 0;
      return;
    }

    if (required <= this.data.length) return;

    let nextLength = Math.max(this.data.length * 2, 9);
    while (nextLength < required) {
      nextLength *= 2;
    }

    const next = new Float32Array(nextLength);
    next.set(this.data);
    this.data = next;
  }
}

function composeModelMatrix(transform: LoadedModel['transform']): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(transform.rotation);
  return new THREE.Matrix4().compose(transform.position, q, transform.scale);
}

function pushWorldTriangle(
  triangles: WorldTriangle[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const zMin = Math.min(az, bz, cz);
  const zMax = Math.max(az, bz, cz);
  triangles.push({ ax, ay, az, bx, by, bz, cx, cy, cz, zMin, zMax });
}

type TriangleSink = WorldTriangle[] | TriangleFloatCollector;

function pushTriangleIntoSink(
  sink: TriangleSink,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  if (sink instanceof TriangleFloatCollector) {
    sink.pushTriangle(ax, ay, az, bx, by, bz, cx, cy, cz);
    return;
  }

  pushWorldTriangle(sink, ax, ay, az, bx, by, bz, cx, cy, cz);
}

function appendGeometryTriangles(
  sink: TriangleSink,
  geometry: THREE.BufferGeometry,
  matrix?: THREE.Matrix4,
): void {
  const position = geometry.getAttribute('position');
  if (!position) return;

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  const writeTri = (a: number, b: number, c: number) => {
    v0.set(position.getX(a), position.getY(a), position.getZ(a));
    v1.set(position.getX(b), position.getY(b), position.getZ(b));
    v2.set(position.getX(c), position.getY(c), position.getZ(c));

    if (matrix) {
      v0.applyMatrix4(matrix);
      v1.applyMatrix4(matrix);
      v2.applyMatrix4(matrix);
    }

    pushTriangleIntoSink(sink, v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
  };

  const index = geometry.getIndex();
  if (index) {
    const idx = index.array;
    for (let i = 0; i < idx.length; i += 3) {
      writeTri(Number(idx[i]), Number(idx[i + 1]), Number(idx[i + 2]));
    }
    return;
  }

  for (let i = 0; i + 2 < position.count; i += 3) {
    writeTri(i, i + 1, i + 2);
  }
}

function appendGeometryWorldTriangles(
  triangles: WorldTriangle[],
  geometry: THREE.BufferGeometry,
  matrix?: THREE.Matrix4,
): void {
  appendGeometryTriangles(triangles, geometry, matrix);
}

function createFrustumGeometryBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radiusStart: number,
  radiusEnd: number,
  radialSegments = 12,
): THREE.BufferGeometry | null {
  const dir = end.clone().sub(start);
  const length = dir.length();
  if (!Number.isFinite(length) || length <= 1e-6) return null;

  const r0 = Math.max(0.001, radiusStart);
  const r1 = Math.max(0.001, radiusEnd);
  const geom = new THREE.CylinderGeometry(r1, r0, length, radialSegments, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const m = new THREE.Matrix4().compose(
    start.clone().add(end).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  geom.applyMatrix4(m);
  return geom;
}

function getDiskTipCenter(disk: ContactDisk): THREE.Vector3 {
  const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
  return new THREE.Vector3(
    disk.pos.x + disk.surfaceNormal.x * thickness,
    disk.pos.y + disk.surfaceNormal.y * thickness,
    disk.pos.z + disk.surfaceNormal.z * thickness,
  );
}

type SupportSliceTessellation = {
  shaftRadialSegments: number;
  bezierRadialSegments: number;
  bezierSteps: number;
  rootRadialSegments: number;
  contactConeRadialSegments: number;
};

function resolveSupportSliceTessellation(
  supportState: ReturnType<typeof getSupportSnapshot>,
  kickstandState: ReturnType<typeof getKickstandSnapshot>,
): SupportSliceTessellation {
  let segmentCount = 0;
  for (const trunk of Object.values(supportState.trunks)) segmentCount += trunk.segments.length;
  for (const branch of Object.values(supportState.branches)) segmentCount += branch.segments.length;
  for (const twig of Object.values(supportState.twigs)) segmentCount += twig.segments.length;
  for (const stick of Object.values(supportState.sticks)) segmentCount += stick.segments.length;
  for (const kickstand of Object.values(kickstandState.kickstands)) segmentCount += kickstand.segments.length;

  const primitiveCount = segmentCount
    + Object.keys(supportState.roots).length
    + Object.keys(supportState.leaves).length
    + Object.keys(supportState.braces).length;

  if (segmentCount >= 20_000 || primitiveCount >= 24_000) {
    return {
      shaftRadialSegments: 3,
      bezierRadialSegments: 3,
      bezierSteps: 4,
      rootRadialSegments: 4,
      contactConeRadialSegments: 4,
    };
  }

  if (segmentCount >= 8_000 || primitiveCount >= 10_000) {
    return {
      shaftRadialSegments: 6,
      bezierRadialSegments: 6,
      bezierSteps: 6,
      rootRadialSegments: 8,
      contactConeRadialSegments: 6,
    };
  }

  if (segmentCount >= 3_000 || primitiveCount >= 4_000) {
    return {
      shaftRadialSegments: 8,
      bezierRadialSegments: 7,
      bezierSteps: 8,
      rootRadialSegments: 10,
      contactConeRadialSegments: 8,
    };
  }

  return {
    shaftRadialSegments: 12,
    bezierRadialSegments: 10,
    bezierSteps: 12,
    rootRadialSegments: 14,
    contactConeRadialSegments: 12,
  };
}

function appendSegmentPrimitive(
  sink: TriangleSink,
  start: THREE.Vector3,
  end: THREE.Vector3,
  diameter: number,
  segment?: { type?: string; controlPoint1?: { x: number; y: number; z: number }; controlPoint2?: { x: number; y: number; z: number } },
  tessellation?: { shaftRadialSegments?: number; bezierRadialSegments?: number; bezierSteps?: number },
): void {
  const radius = Math.max(0.001, diameter * 0.5);
  const shaftRadialSegments = Math.max(3, Math.floor(tessellation?.shaftRadialSegments ?? 12));
  const bezierRadialSegments = Math.max(3, Math.floor(tessellation?.bezierRadialSegments ?? 10));
  const bezierSteps = Math.max(2, Math.floor(tessellation?.bezierSteps ?? 12));

  if (segment?.type === 'bezier' && segment.controlPoint1 && segment.controlPoint2) {
    const p0 = { x: start.x, y: start.y, z: start.z };
    const p1 = segment.controlPoint1;
    const p2 = segment.controlPoint2;
    const p3 = { x: end.x, y: end.y, z: end.z };

    let prev = new THREE.Vector3(start.x, start.y, start.z);
    for (let i = 1; i <= bezierSteps; i += 1) {
      const t = i / bezierSteps;
      const p = getBezierPointAtT(p0, p1, p2, p3, t);
      const cur = new THREE.Vector3(p.x, p.y, p.z);
      const g = createFrustumGeometryBetween(prev, cur, radius, radius, bezierRadialSegments);
      if (g) {
        appendGeometryTriangles(sink, g);
        g.dispose();
      }
      prev = cur;
    }
    return;
  }

  const geom = createFrustumGeometryBetween(start, end, radius, radius, shaftRadialSegments);
  if (!geom) return;
  appendGeometryTriangles(sink, geom);
  geom.dispose();
}

function appendContactConePrimitive(
  sink: TriangleSink,
  cone: {
    pos: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    surfaceNormal?: { x: number; y: number; z: number };
    diskLengthOverride?: number;
    profile: { contactDiameterMm: number; bodyDiameterMm: number; type?: string; diskThicknessMm?: number; maxStandoffMm?: number; standoffAngleThreshold?: number };
  },
  radialSegments = 12,
): void {
  const socket = getFinalSocketPosition(cone as any);
  const start = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
  const end = new THREE.Vector3(socket.x, socket.y, socket.z);
  const g = createFrustumGeometryBetween(
    start,
    end,
    Math.max(0.05, cone.profile.contactDiameterMm * 0.5),
    Math.max(0.05, cone.profile.bodyDiameterMm * 0.5),
    Math.max(4, Math.floor(radialSegments)),
  );
  if (!g) return;
  appendGeometryTriangles(sink, g);
  g.dispose();
}

function buildSupportAndRaftWorldTriangles(
  visibleModelIds: Set<string>,
  collector?: TriangleFloatCollector,
): WorldTriangle[] {
  if (visibleModelIds.size === 0) return [];

  const out: WorldTriangle[] = [];
  const supportState = getSupportSnapshot();
  const kickstandState = getKickstandSnapshot();
  const sink: TriangleSink = collector ?? out;
  const raftSettings = getRaftSettings();
  const hasSolidBottom = raftSettings.bottomMode === 'solid';
  const raftThickness = raftSettings.thickness;
  const tessellation = resolveSupportSliceTessellation(supportState, kickstandState);
  const segmentTessellation = {
    shaftRadialSegments: tessellation.shaftRadialSegments,
    bezierRadialSegments: tessellation.bezierRadialSegments,
    bezierSteps: tessellation.bezierSteps,
  };
  const visibleRootIds = new Set<string>();
  const rootModelKeyById = new Map<string, string>();

  for (const trunk of Object.values(supportState.trunks)) {
    if (!visibleModelIds.has(trunk.modelId)) continue;
    visibleRootIds.add(trunk.rootId);
    if (!rootModelKeyById.has(trunk.rootId)) {
      rootModelKeyById.set(trunk.rootId, trunk.modelId);
    }
  }

  for (const kickstand of Object.values(kickstandState.kickstands)) {
    if (!visibleModelIds.has(kickstand.modelId)) continue;
    visibleRootIds.add(kickstand.rootId);
    if (!rootModelKeyById.has(kickstand.rootId)) {
      rootModelKeyById.set(kickstand.rootId, kickstand.modelId);
    }
  }

  const rootTopRadiusByRootId = new Map<string, number>();
  for (const trunk of Object.values(supportState.trunks)) {
    const firstDiameter = trunk.segments[0]?.diameter;
    if (Number.isFinite(firstDiameter) && firstDiameter! > 0) {
      rootTopRadiusByRootId.set(trunk.rootId, Math.max(0.05, firstDiameter! * 0.5));
    }
  }
  for (const kickstand of Object.values(kickstandState.kickstands)) {
    const firstDiameter = kickstand.segments[0]?.diameter;
    if (Number.isFinite(firstDiameter) && firstDiameter! > 0) {
      rootTopRadiusByRootId.set(kickstand.rootId, Math.max(0.05, firstDiameter! * 0.5));
    }
  }

  for (const root of Object.values(supportState.roots)) {
    const rootVisibleByModel = visibleModelIds.has(root.modelId);
    const rootVisibleByLink = visibleRootIds.has(root.id);
    if (!rootVisibleByModel && !rootVisibleByLink) continue;

    // Mirror proxy hasSolidBottom logic: collapse disk height and shift root up so it
    // sits flush on top of the solid raft rather than extending through it.
    const effectiveDiskHeight = hasSolidBottom ? 0.05 : Math.max(0.01, root.diskHeight);
    const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;
    const base = new THREE.Vector3(
      root.transform.pos.x,
      root.transform.pos.y,
      root.transform.pos.z + verticalOffset,
    );
    const rootRadius = Math.max(0.05, root.diameter * 0.5);
    const topRadius = rootTopRadiusByRootId.get(root.id) ?? Math.max(0.05, rootRadius * 0.45);
    const diskTop = base.clone().add(new THREE.Vector3(0, 0, effectiveDiskHeight));
    const coneTop = diskTop.clone().add(new THREE.Vector3(0, 0, Math.max(0.01, root.coneHeight)));

    const diskGeom = createFrustumGeometryBetween(base, diskTop, rootRadius, rootRadius, tessellation.rootRadialSegments);
    if (diskGeom) {
      appendGeometryTriangles(sink, diskGeom);
      diskGeom.dispose();
    }

    const coneGeom = createFrustumGeometryBetween(diskTop, coneTop, rootRadius, topRadius, tessellation.rootRadialSegments);
    if (coneGeom) {
      appendGeometryTriangles(sink, coneGeom);
      coneGeom.dispose();
    }
  }

  for (const trunk of Object.values(supportState.trunks)) {
    if (!visibleModelIds.has(trunk.modelId)) continue;
    const root = supportState.roots[trunk.rootId];
    if (!root) continue;

    for (let i = 0; i < trunk.segments.length; i += 1) {
      const seg = trunk.segments[i];
      const endpoints = getTrunkSegmentEndpoints(trunk, seg, i, root);
      if (!endpoints) continue;
      appendSegmentPrimitive(
        sink,
        new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z),
        new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z),
        Math.max(0.05, seg.diameter),
        seg as any,
        segmentTessellation,
      );
    }

    if (trunk.contactCone) {
      appendContactConePrimitive(sink, trunk.contactCone as any, tessellation.contactConeRadialSegments);
    }
  }

  for (const branch of Object.values(supportState.branches)) {
    const modelId = branch.modelId;
    if (!modelId || !visibleModelIds.has(modelId)) continue;
    const parentKnot = supportState.knots[branch.parentKnotId];
    if (!parentKnot) continue;

    for (let i = 0; i < branch.segments.length; i += 1) {
      const seg = branch.segments[i];
      const endpoints = getBranchSegmentEndpoints(branch, seg, i, parentKnot);
      if (!endpoints) continue;
      appendSegmentPrimitive(
        sink,
        new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z),
        new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z),
        Math.max(0.05, seg.diameter),
        seg as any,
        segmentTessellation,
      );
    }

    if (branch.contactCone) {
      appendContactConePrimitive(sink, branch.contactCone as any, tessellation.contactConeRadialSegments);
    }
  }

  for (const twig of Object.values(supportState.twigs)) {
    if (!visibleModelIds.has(twig.modelId)) continue;
    for (const seg of twig.segments) {
      const start = seg.bottomJoint
        ? new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z)
        : getDiskTipCenter(twig.contactDiskA);
      const end = seg.topJoint
        ? new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z)
        : getDiskTipCenter(twig.contactDiskB);
      appendSegmentPrimitive(sink, start, end, Math.max(0.05, seg.diameter), seg as any, segmentTessellation);
    }
  }

  for (const stick of Object.values(supportState.sticks)) {
    if (!visibleModelIds.has(stick.modelId)) continue;
    for (const seg of stick.segments) {
      const start = seg.bottomJoint
        ? new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z)
        : new THREE.Vector3(...Object.values(getFinalSocketPosition(stick.contactConeA)) as [number, number, number]);
      const end = seg.topJoint
        ? new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z)
        : new THREE.Vector3(...Object.values(getFinalSocketPosition(stick.contactConeB)) as [number, number, number]);
      appendSegmentPrimitive(sink, start, end, Math.max(0.05, seg.diameter), seg as any, segmentTessellation);
    }

    appendContactConePrimitive(sink, stick.contactConeA as any, tessellation.contactConeRadialSegments);
    appendContactConePrimitive(sink, stick.contactConeB as any, tessellation.contactConeRadialSegments);
  }

  for (const brace of Object.values(supportState.braces)) {
    const modelId = brace.modelId;
    if (!modelId || !visibleModelIds.has(modelId)) continue;
    const startKnot = supportState.knots[brace.startKnotId];
    const endKnot = supportState.knots[brace.endKnotId];
    if (!startKnot || !endKnot) continue;
    // Mirror renderer: derive visual diameter from host knot diameters, not raw profile.diameter.
    const profileDiameter = Math.max(0.001, brace.profile?.diameter ?? 1);
    const startHostDia = Math.max(0.05, (startKnot.diameter ?? (profileDiameter + 0.1)) - 0.1);
    const endHostDia = Math.max(0.05, (endKnot.diameter ?? (profileDiameter + 0.1)) - 0.1);
    const braceDiameter = (startHostDia + endHostDia) * 0.5;
    appendSegmentPrimitive(
      sink,
      new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z),
      new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z),
      braceDiameter,
      brace.curve as any,
      segmentTessellation,
    );
  }

  for (const leaf of Object.values(supportState.leaves)) {
    const modelId = leaf.modelId;
    if (!modelId || !visibleModelIds.has(modelId)) continue;
    appendContactConePrimitive(sink, leaf.contactCone as any, tessellation.contactConeRadialSegments);
  }

  for (const kickstand of Object.values(kickstandState.kickstands)) {
    const modelId = kickstand.modelId;
    if (!modelId || !visibleModelIds.has(modelId)) continue;
    const root = kickstandState.roots[kickstand.rootId];
    const hostKnot = kickstandState.knots[kickstand.hostKnotId];
    if (!root || !hostKnot) continue;

    let currentStart = new THREE.Vector3(
      root.transform.pos.x,
      root.transform.pos.y,
      root.transform.pos.z + root.diskHeight + root.coneHeight,
    );

    for (const seg of kickstand.segments) {
      const endPoint = seg.topJoint
        ? new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z)
        : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);
      appendSegmentPrimitive(sink, currentStart, endPoint, Math.max(0.05, seg.diameter), seg as any, segmentTessellation);
      currentStart = endPoint;
    }
  }

  // raftSettings already resolved at top of function; reuse it.
  const raft = raftSettings;
  if (raft.bottomMode !== 'off') {
    const rootsByModel = new Map<string, Array<{ x: number; y: number; r: number }>>();
    for (const root of Object.values(supportState.roots)) {
      const rootVisibleByModel = visibleModelIds.has(root.modelId);
      const rootVisibleByLink = visibleRootIds.has(root.id);
      if (!rootVisibleByModel && !rootVisibleByLink) continue;

      const modelKey = rootModelKeyById.get(root.id) ?? root.modelId ?? `__root_${root.id}`;
      const arr = rootsByModel.get(modelKey) ?? [];
      arr.push({ x: root.transform.pos.x, y: root.transform.pos.y, r: root.diameter * 0.5 });
      rootsByModel.set(modelKey, arr);
    }

    for (const circles of rootsByModel.values()) {
      if (circles.length === 0) continue;
      const clampedChamfer = Math.min(90, Math.max(45, raft.chamferAngle));
      const chamferInset = raft.bottomMode === 'line'
        ? Math.max(0, raft.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - clampedChamfer))
        : 0;
      const profile = computeFootprint(circles as any, {
        marginMm: 0.2 + chamferInset,
        samplesPerCircle: 24,
      });
      if (!profile || profile.length < 3) continue;

      if (raft.bottomMode === 'solid') {
        const baseMesh = generateChamferedBase(profile, {
          thickness: raft.thickness,
          chamferAngle: raft.chamferAngle,
        });
        appendGeometryTriangles(sink, baseMesh.geometry);

        if (raft.wallEnabled) {
          const useCrenels = raft.crenulationSpacing > 0 && raft.crenulationGapWidth > 0;
          const wallMesh = useCrenels
            ? generateCrenelatedWallManual(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              crenulationGapWidth: raft.crenulationGapWidth,
              crenulationSpacing: raft.crenulationSpacing,
              thickness: raft.thickness,
              chamferAngle: raft.chamferAngle,
            })
            : generatePerimeterWall(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              thickness: raft.thickness,
            });
          appendGeometryTriangles(sink, wallMesh.geometry);
        }
      } else if (raft.bottomMode === 'line') {
        const nodes2d = circles.map((c) => new THREE.Vector2(c.x, c.y));
        const hasBorderRing = !!profile && profile.length >= 3;

        const hull = convexHull2d(nodes2d);
        const hullIndices: number[] = hull.map((hp) => {
          let best = 0;
          let bestD2 = Infinity;
          for (let i = 0; i < nodes2d.length; i += 1) {
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
          for (let i = 0; i < hullIndices.length; i += 1) {
            const a = hullIndices[i];
            const b = hullIndices[(i + 1) % hullIndices.length];
            if (a !== b) hullEdges.push([a, b]);
          }
        }

        const hullEdgeSet = new Set<EdgeKey>();
        for (const [a, b] of hullEdges) hullEdgeSet.add(edgeKey(a, b));

        const tris = delaunayTriangulate2d(nodes2d);

        const nn = new Array(nodes2d.length).fill(Infinity);
        for (let i = 0; i < nodes2d.length; i += 1) {
          for (let j = 0; j < nodes2d.length; j += 1) {
            if (i === j) continue;
            nn[i] = Math.min(nn[i], edgeLen(nodes2d[i], nodes2d[j]));
          }
          if (!Number.isFinite(nn[i])) nn[i] = 0;
        }

        const keepFactor = 3.2;
        const absMaxLen = 120;
        const edges = new Set<EdgeKey>();
        const edgePairs: Array<[number, number]> = [];

        if (!hasBorderRing) {
          for (const [a, b] of hullEdges) {
            const key = edgeKey(a, b);
            if (!edges.has(key)) {
              edges.add(key);
              edgePairs.push([a, b]);
            }
          }
        }

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

        const beamHeight = Math.max(0.01, raft.lineHeightMm);

        const unionEdges: Array<[THREE.Vector2, THREE.Vector2]> = edgePairs.map(([a, b]) => [nodes2d[a], nodes2d[b]]);
        const unionMesh = generateUnionedLineRaftMesh(unionEdges, {
          widthMm: raft.lineWidthMm,
          heightMm: beamHeight,
          borderProfile: null,
        });

        const unionPositionAttribute = unionMesh.geometry.getAttribute('position');
        const unionHasGeometry = !!unionPositionAttribute && unionPositionAttribute.count > 0;
        if (unionHasGeometry) {
          appendGeometryTriangles(sink, unionMesh.geometry);
        } else {
          for (const [a, b] of edgePairs) {
            const start = new THREE.Vector3(nodes2d[a].x, nodes2d[a].y, 0);
            const end = new THREE.Vector3(nodes2d[b].x, nodes2d[b].y, 0);
            const beam = generateChamferedBeam(start, end, {
              widthMm: raft.lineWidthMm,
              heightMm: beamHeight,
              chamferAngleDeg: 90,
            });
            appendGeometryTriangles(sink, beam.geometry);
          }
        }

        const borderMesh = generatePerimeterBorderBeam(profile, {
          widthMm: raft.lineWidthMm,
          heightMm: raft.lineHeightMm,
          chamferAngleDeg: raft.chamferAngle,
        });
        appendGeometryTriangles(sink, borderMesh.geometry);

        if (raft.wallEnabled) {
          const useCrenels = raft.crenulationSpacing > 0 && raft.crenulationGapWidth > 0;
          const wallMesh = useCrenels
            ? generateCrenelatedWallManual(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              crenulationGapWidth: raft.crenulationGapWidth,
              crenulationSpacing: raft.crenulationSpacing,
              thickness: raft.lineHeightMm,
              chamferAngle: raft.chamferAngle,
            })
            : generatePerimeterWall(profile, {
              wallHeight: raft.wallHeight,
              wallThickness: raft.wallThickness,
              thickness: raft.lineHeightMm,
            });
          appendGeometryTriangles(sink, wallMesh.geometry);
        }
      }
    }
  }

  return out;
}

function mirrorWorldX(xMm: number, mirrorX: boolean): number {
  return mirrorX ? -xMm : xMm;
}

function mirrorWorldY(yMm: number, mirrorY: boolean): number {
  return mirrorY ? -yMm : yMm;
}

function toPixelX(xMm: number, minX: number, widthMm: number, widthPx: number): number {
  const normalized = (xMm - minX) / widthMm;
  return normalized * (widthPx - 1);
}

function toPixelY(yMm: number, minY: number, depthMm: number, heightPx: number): number {
  // Canvas Y increases downward, build plate Y increases upward.
  const base = 1 - ((yMm - minY) / depthMm);
  return base * (heightPx - 1);
}

function getCanvas(widthPx: number, heightPx: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(widthPx, heightPx);
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    return canvas;
  }

  throw new Error('No canvas implementation available in this runtime.');
}

async function nanodlpPackRgbaToPngBlob(
  sourceRgba: Uint8ClampedArray,
  sourceWidthPx: number,
  sourceHeightPx: number,
  outputWidthPx: number,
  packingMode: EffectiveSettings['xPackingMode'],
): Promise<Blob> {
  const outCanvas = getCanvas(outputWidthPx, sourceHeightPx);
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!outCtx) {
    throw new Error('Failed to create 2D context for NanoDLP packing.');
  }

  const outImage = new ImageData(outputWidthPx, sourceHeightPx);
  const out = outImage.data;

  if (packingMode === 'rgb8_div3') {
    const requiredSubpixels = outputWidthPx * 3;
    const padTotal = Math.max(0, requiredSubpixels - sourceWidthPx);
    const padLeft = Math.floor(padTotal / 2);

    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = x * 3 - padLeft;
        const pOut = (outRow + x) * 4;
        const r = sx >= 0 && sx < sourceWidthPx ? sourceRgba[(srcRow + sx) * 4] : 0;
        const g = sx + 1 >= 0 && sx + 1 < sourceWidthPx ? sourceRgba[(srcRow + sx + 1) * 4] : 0;
        const b = sx + 2 >= 0 && sx + 2 < sourceWidthPx ? sourceRgba[(srcRow + sx + 2) * 4] : 0;
        out[pOut] = r;
        out[pOut + 1] = g;
        out[pOut + 2] = b;
        out[pOut + 3] = 255;
      }
    }
  } else if (packingMode === 'gray3_div2') {
    const requiredSubpixels = outputWidthPx * 2;
    const padTotal = Math.max(0, requiredSubpixels - sourceWidthPx);
    const padLeft = Math.floor(padTotal / 2);

    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = x * 2 - padLeft;
        const a = sx >= 0 && sx < sourceWidthPx ? sourceRgba[(srcRow + sx) * 4] : 0;
        const b = sx + 1 >= 0 && sx + 1 < sourceWidthPx ? sourceRgba[(srcRow + sx + 1) * 4] : 0;
        const gray = ((a + b) >> 1);
        const pOut = (outRow + x) * 4;
        out[pOut] = gray;
        out[pOut + 1] = gray;
        out[pOut + 2] = gray;
        out[pOut + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = Math.min(sourceWidthPx - 1, x);
        const gray = sourceRgba[(srcRow + sx) * 4];
        const pOut = (outRow + x) * 4;
        out[pOut] = gray;
        out[pOut + 1] = gray;
        out[pOut + 2] = gray;
        out[pOut + 3] = 255;
      }
    }
  }

  outCtx.putImageData(outImage, 0, 0);
  return canvasToPngBlob(outCanvas);
}

async function canvasToPngBlob(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode layer image to PNG.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function buildTriangles(
  models: LoadedModel[],
  settings: EffectiveSettings,
  printer: PrinterProfile,
): RasterTriangle[] {
  const widthMm = Math.max(1, printer.buildVolumeMm.width);
  const depthMm = Math.max(1, printer.buildVolumeMm.depth);
  const minX = -widthMm * 0.5;
  const minY = -depthMm * 0.5;

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  const triangles: RasterTriangle[] = [];

  for (const model of models) {
    const matrix = composeModelMatrix(model.transform);
    const center = model.geometry.center;
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!position) continue;

    const readVertex = (vertexIndex: number, target: THREE.Vector3) => {
      target.set(
        position.getX(vertexIndex) - center.x,
        position.getY(vertexIndex) - center.y,
        position.getZ(vertexIndex) - center.z,
      );
      target.applyMatrix4(matrix);
      return target;
    };

    if (index) {
      const idx = index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = Number(idx[i]);
        const b = Number(idx[i + 1]);
        const c = Number(idx[i + 2]);

        readVertex(a, v0);
        readVertex(b, v1);
        readVertex(c, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        const v0x = mirrorWorldX(v0.x, settings.mirrorX);
        const v0y = mirrorWorldY(v0.y, settings.mirrorY);
        const v1x = mirrorWorldX(v1.x, settings.mirrorX);
        const v1y = mirrorWorldY(v1.y, settings.mirrorY);
        const v2x = mirrorWorldX(v2.x, settings.mirrorX);
        const v2y = mirrorWorldY(v2.y, settings.mirrorY);

        triangles.push({
          zMin,
          zMax,
          x1: toPixelX(v0x, minX, widthMm, settings.widthPx),
          y1: toPixelY(v0y, minY, depthMm, settings.heightPx),
          x2: toPixelX(v1x, minX, widthMm, settings.widthPx),
          y2: toPixelY(v1y, minY, depthMm, settings.heightPx),
          x3: toPixelX(v2x, minX, widthMm, settings.widthPx),
          y3: toPixelY(v2y, minY, depthMm, settings.heightPx),
        });
      }
    } else {
      const count = position.count;
      for (let i = 0; i < count; i += 3) {
        readVertex(i, v0);
        readVertex(i + 1, v1);
        readVertex(i + 2, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        const v0x = mirrorWorldX(v0.x, settings.mirrorX);
        const v0y = mirrorWorldY(v0.y, settings.mirrorY);
        const v1x = mirrorWorldX(v1.x, settings.mirrorX);
        const v1y = mirrorWorldY(v1.y, settings.mirrorY);
        const v2x = mirrorWorldX(v2.x, settings.mirrorX);
        const v2y = mirrorWorldY(v2.y, settings.mirrorY);

        triangles.push({
          zMin,
          zMax,
          x1: toPixelX(v0x, minX, widthMm, settings.widthPx),
          y1: toPixelY(v0y, minY, depthMm, settings.heightPx),
          x2: toPixelX(v1x, minX, widthMm, settings.widthPx),
          y2: toPixelY(v1y, minY, depthMm, settings.heightPx),
          x3: toPixelX(v2x, minX, widthMm, settings.widthPx),
          y3: toPixelY(v2y, minY, depthMm, settings.heightPx),
        });
      }
    }
  }

  return triangles;
}

function buildWorldTriangles(models: LoadedModel[]): WorldTriangle[] {
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  const triangles: WorldTriangle[] = [];

  for (const model of models) {
    const matrix = composeModelMatrix(model.transform);
    const center = model.geometry.center;
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!position) continue;

    const readVertex = (vertexIndex: number, target: THREE.Vector3) => {
      target.set(
        position.getX(vertexIndex) - center.x,
        position.getY(vertexIndex) - center.y,
        position.getZ(vertexIndex) - center.z,
      );
      target.applyMatrix4(matrix);
      return target;
    };

    if (index) {
      const idx = index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = Number(idx[i]);
        const b = Number(idx[i + 1]);
        const c = Number(idx[i + 2]);

        readVertex(a, v0);
        readVertex(b, v1);
        readVertex(c, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          ax: v0.x,
          ay: v0.y,
          az: v0.z,
          bx: v1.x,
          by: v1.y,
          bz: v1.z,
          cx: v2.x,
          cy: v2.y,
          cz: v2.z,
          zMin,
          zMax,
        });
      }
    } else {
      const count = position.count;
      for (let i = 0; i < count; i += 3) {
        readVertex(i, v0);
        readVertex(i + 1, v1);
        readVertex(i + 2, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          ax: v0.x,
          ay: v0.y,
          az: v0.z,
          bx: v1.x,
          by: v1.y,
          bz: v1.z,
          cx: v2.x,
          cy: v2.y,
          cz: v2.z,
          zMin,
          zMax,
        });
      }
    }
  }

  const visibleModelIds = new Set(models.filter((model) => model.visible).map((model) => model.id));
  const supportAndRaftTriangles = buildSupportAndRaftWorldTriangles(visibleModelIds);
  // Avoid stack overflow from spreading huge arrays - push one by one instead
  for (let i = 0; i < supportAndRaftTriangles.length; i++) {
    triangles.push(supportAndRaftTriangles[i]);
  }

  return triangles;
}

function appendModelWorldTrianglesToCollector(
  models: LoadedModel[],
  collector: TriangleFloatCollector,
): void {
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  for (const model of models) {
    const matrix = composeModelMatrix(model.transform);
    const center = model.geometry.center;
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!position) continue;

    const readVertex = (vertexIndex: number, target: THREE.Vector3) => {
      target.set(
        position.getX(vertexIndex) - center.x,
        position.getY(vertexIndex) - center.y,
        position.getZ(vertexIndex) - center.z,
      );
      target.applyMatrix4(matrix);
      return target;
    };

    if (index) {
      const idx = index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = Number(idx[i]);
        const b = Number(idx[i + 1]);
        const c = Number(idx[i + 2]);

        readVertex(a, v0);
        readVertex(b, v1);
        readVertex(c, v2);

        collector.pushTriangle(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    } else {
      const count = position.count;
      for (let i = 0; i < count; i += 3) {
        readVertex(i, v0);
        readVertex(i + 1, v1);
        readVertex(i + 2, v2);

        collector.pushTriangle(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    }
  }
}

function countModelWorldTriangles(models: LoadedModel[]): number {
  let count = 0;

  for (const model of models) {
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    if (!position) continue;

    const index = geometry.getIndex();
    if (index) {
      count += Math.floor(index.count / 3);
    } else {
      count += Math.floor(position.count / 3);
    }
  }

  return count;
}

export function buildProjectedCrossSectionZRange(models: LoadedModel[]): { min: number; max: number } | null {
  const visibleModels = models.filter((model) => model.visible);
  if (visibleModels.length === 0) return null;

  const triangles = buildWorldTriangles(visibleModels);
  if (triangles.length === 0) return null;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < triangles.length; i += 1) {
    minZ = Math.min(minZ, triangles[i].zMin);
    maxZ = Math.max(maxZ, triangles[i].zMax);
  }

  if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) return null;
  return { min: minZ, max: maxZ };
}

function layerRangeForTriangle(tri: WorldTriangle, layerHeightMm: number, totalLayers: number): [number, number] | null {
  if (totalLayers <= 0 || layerHeightMm <= 0) return null;

  const last = totalLayers - 1;
  const start = Math.ceil((tri.zMin / layerHeightMm) - 0.5);
  const end = Math.floor((tri.zMax / layerHeightMm) - 0.5);

  if (end < 0 || start > last) return null;

  const clampedStart = Math.max(0, Math.min(last, start));
  const clampedEnd = Math.max(0, Math.min(last, end));
  if (clampedEnd < clampedStart) return null;
  return [clampedStart, clampedEnd];
}

function buildLayerWorldTriangleBuckets(
  triangles: WorldTriangle[],
  totalLayers: number,
  layerHeightMm: number,
): number[][] {
  const buckets: number[][] = Array.from({ length: totalLayers }, () => []);

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    const range = layerRangeForTriangle(tri, layerHeightMm, totalLayers);
    if (!range) continue;

    const [start, end] = range;
    for (let layer = start; layer <= end; layer += 1) {
      buckets[layer].push(triIndex);
    }
  }

  return buckets;
}

function buildProjectedCrossSectionQuantizedBuckets(
  triangles: WorldTriangle[],
  stepMm: number,
): ProjectedCrossSectionQuantizedBuckets {
  const safeStepMm = Math.max(0.0001, stepMm);
  const eps = 1e-6;
  let minLayer = Infinity;
  let maxLayer = -Infinity;

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    const start = Math.ceil((tri.zMin - eps) / safeStepMm);
    const end = Math.floor((tri.zMax + eps) / safeStepMm);
    if (end < start) continue;
    if (start < minLayer) minLayer = start;
    if (end > maxLayer) maxLayer = end;
  }

  if (!Number.isFinite(minLayer) || !Number.isFinite(maxLayer)) {
    return {
      stepMm: safeStepMm,
      baseLayer: 0,
      buckets: [],
    };
  }

  const buckets = Array.from({ length: Math.max(0, maxLayer - minLayer + 1) }, () => [] as number[]);

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    const start = Math.ceil((tri.zMin - eps) / safeStepMm);
    const end = Math.floor((tri.zMax + eps) / safeStepMm);
    if (end < start) continue;

    for (let layer = start; layer <= end; layer += 1) {
      buckets[layer - minLayer].push(triIndex);
    }
  }

  return {
    stepMm: safeStepMm,
    baseLayer: minLayer,
    buckets,
  };
}

function getProjectedCrossSectionTriangleIndicesAtZ(
  context: ProjectedCrossSectionContext,
  zMm: number,
  quantizedStepMm?: number,
): number[] | null {
  if (!Number.isFinite(quantizedStepMm) || !quantizedStepMm || quantizedStepMm <= 0) {
    return null;
  }

  const safeStepMm = Math.max(0.0001, quantizedStepMm);
  const bucketKey = safeStepMm.toFixed(5);
  let bucketSet = context.quantizedBucketsByStep.get(bucketKey);
  if (!bucketSet) {
    bucketSet = buildProjectedCrossSectionQuantizedBuckets(context.triangles, safeStepMm);
    context.quantizedBucketsByStep.set(bucketKey, bucketSet);
  }

  const layerIndex = Math.round(zMm / safeStepMm);
  const bucketIndex = layerIndex - bucketSet.baseLayer;
  if (bucketIndex < 0 || bucketIndex >= bucketSet.buckets.length) {
    return [];
  }

  return bucketSet.buckets[bucketIndex];
}

function edgePlaneIntersectionXY(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  z: number,
): [number, number] | null {
  const dz1 = az - z;
  const dz2 = bz - z;
  const crosses = (dz1 <= 0 && dz2 > 0) || (dz2 <= 0 && dz1 > 0);
  if (!crosses) return null;

  const denom = bz - az;
  if (Math.abs(denom) < 1e-8) return null;

  const t = (z - az) / denom;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

function pushDistinctPoint(points: Array<[number, number]>, point: [number, number]): void {
  const eps = 1e-5;
  for (let i = 0; i < points.length; i += 1) {
    if (Math.abs(points[i][0] - point[0]) <= eps && Math.abs(points[i][1] - point[1]) <= eps) {
      return;
    }
  }
  points.push(point);
}

function buildLayerSegmentsFromWorldTriangles(
  triangles: WorldTriangle[],
  triangleIndices: number[],
  zMm: number,
  settings: EffectiveSettings,
  printer: PrinterProfile,
): SliceSegment2D[] {
  const widthMm = Math.max(1, printer.buildVolumeMm.width);
  const depthMm = Math.max(1, printer.buildVolumeMm.depth);
  const minX = -widthMm * 0.5;
  const minY = -depthMm * 0.5;

  const segments: SliceSegment2D[] = [];

  for (let i = 0; i < triangleIndices.length; i += 1) {
    const tri = triangles[triangleIndices[i]];
    if (zMm < tri.zMin || zMm > tri.zMax) continue;

    const ux = tri.bx - tri.ax;
    const uy = tri.by - tri.ay;
    const uz = tri.bz - tri.az;
    const vx = tri.cx - tri.ax;
    const vy = tri.cy - tri.ay;
    const vz = tri.cz - tri.az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    // Line-of-intersection direction for tri plane ∩ z=const plane (n × +Z)
    const dirX = ny;
    const dirY = -nx;

    const points: Array<[number, number]> = [];
    const p01 = edgePlaneIntersectionXY(tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, zMm);
    if (p01) pushDistinctPoint(points, p01);

    const p12 = edgePlaneIntersectionXY(tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz, zMm);
    if (p12) pushDistinctPoint(points, p12);

    const p20 = edgePlaneIntersectionXY(tri.cx, tri.cy, tri.cz, tri.ax, tri.ay, tri.az, zMm);
    if (p20) pushDistinctPoint(points, p20);

    if (points.length < 2) continue;

    let p1 = points[0];
    let p2 = points[1];
    if (Math.abs(dirX) > 1e-10 || Math.abs(dirY) > 1e-10) {
      const segX = p2[0] - p1[0];
      const segY = p2[1] - p1[1];
      if ((segX * dirX + segY * dirY) < 0) {
        p1 = points[1];
        p2 = points[0];
      }
    }

    const p1xMm = mirrorWorldX(p1[0], settings.mirrorX);
    const p1yMm = mirrorWorldY(p1[1], settings.mirrorY);
    const p2xMm = mirrorWorldX(p2[0], settings.mirrorX);
    const p2yMm = mirrorWorldY(p2[1], settings.mirrorY);

    const x1 = toPixelX(p1xMm, minX, widthMm, settings.widthPx);
    const y1 = toPixelY(p1yMm, minY, depthMm, settings.heightPx);
    const x2 = toPixelX(p2xMm, minX, widthMm, settings.widthPx);
    const y2 = toPixelY(p2yMm, minY, depthMm, settings.heightPx);

    const dy = y2 - y1;
    if (Math.abs(dy) < 1e-8) continue;
    const wind = dy > 0 ? 1 : -1;

    segments.push({
      x1,
      y1,
      dxDy: (x2 - x1) / dy,
      yMin: Math.min(y1, y2),
      yMax: Math.max(y1, y2),
      wind,
    });
  }

  return segments;
}

function buildRowSegmentBuckets(heightPx: number, segments: SliceSegment2D[]): number[][] {
  const rowBuckets: number[][] = Array.from({ length: heightPx }, () => []);
  const Y_EPSILON = 1e-9;

  for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
    const seg = segments[segIndex];
    // Strict half-open ownership: ySample in [yMin, yMax)
    const rowStart = Math.ceil(seg.yMin - 0.5);
    const rowEnd = Math.ceil(seg.yMax - 0.5 - Y_EPSILON) - 1;

    if (rowEnd < 0 || rowStart >= heightPx) continue;

    const start = Math.max(0, Math.min(heightPx - 1, rowStart));
    const end = Math.max(0, Math.min(heightPx - 1, rowEnd));
    for (let row = start; row <= end; row += 1) {
      rowBuckets[row].push(segIndex);
    }
  }

  return rowBuckets;
}

function rasterizeSolidSegmentsToImage(
  widthPx: number,
  heightPx: number,
  segments: SliceSegment2D[],
  imageData: ImageData,
  baseOpaqueBlack: Uint8ClampedArray,
): void {
  const data = imageData.data;
  data.set(baseOpaqueBlack);

  const rowBuckets = buildRowSegmentBuckets(heightPx, segments);
  const intersections: Array<{ x: number; wind: number }> = [];
  const X_EPSILON = 1e-6;

  for (let y = 0; y < heightPx; y += 1) {
    intersections.length = 0;
    const ySample = y + 0.5;

    const rowSegs = rowBuckets[y];
    for (let i = 0; i < rowSegs.length; i += 1) {
      const seg = segments[rowSegs[i]];
      const x = seg.x1 + (ySample - seg.y1) * seg.dxDy;
      if (!Number.isFinite(x)) continue;
      intersections.push({ x, wind: seg.wind });
    }

    if (intersections.length === 0) continue;
    intersections.sort((a, b) => a.x - b.x);

    let winding = 0;
    let i = 0;
    while (i < intersections.length) {
      const x = intersections[i].x;
      let deltaWind = 0;
      while (i < intersections.length && Math.abs(intersections[i].x - x) <= X_EPSILON) {
        deltaWind += intersections[i].wind;
        i += 1;
      }

      winding += deltaWind;
      if (winding === 0 || i >= intersections.length) continue;

      const nextX = intersections[i].x;
      if (Math.abs(nextX - x) <= X_EPSILON) continue;
      const xStart = Math.ceil(Math.max(0, Math.min(x, nextX)));
      const xEnd = Math.floor(Math.min(widthPx - 1, Math.max(x, nextX)));

      if (xEnd >= xStart) {
        let pixelIndex = (y * widthPx + xStart) * 4;
        for (let x = xStart; x <= xEnd; x += 1) {
          data[pixelIndex] = 255;
          data[pixelIndex + 1] = 255;
          data[pixelIndex + 2] = 255;
          pixelIndex += 4;
        }
      }
    }
  }
}

function resolveEffectiveSettings(options: RasterLayerZipExportOptions): EffectiveSettings {
  const sourceResolutionX = Math.max(1, Math.round(options.printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(options.printerProfile.display.resolutionY));

  const resolvedFormat = resolveSlicingFormatDefinition({
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
  });
  const usesPluginOwnedEncoding = resolvedFormat.ownership === 'plugin';

  const packed = usesPluginOwnedEncoding
    ? resolvePluginPackedWidth(options.printerProfile)
    : {
      widthPx: sourceResolutionX,
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'none' as const,
    };

  let widthPx = packed.widthPx;
  let heightPx = packed.sourceResolutionY;

  const pixelCount = widthPx * heightPx;
  if (pixelCount > MAX_CANVAS_PIXELS && !usesPluginOwnedEncoding) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixelCount);
    widthPx = Math.max(1, Math.floor(widthPx * scale));
    heightPx = Math.max(1, Math.floor(heightPx * scale));
  }

  const layerHeightMm = Math.max(0.001, Number(options.materialProfile.layerHeightMm) || 0.05);

  return {
    widthPx,
    heightPx,
    sourceResolutionX: packed.sourceResolutionX,
    sourceResolutionY: packed.sourceResolutionY,
    xPackingMode: packed.xPackingMode,
    mirrorX: options.printerProfile.display.mirrorX === true,
    mirrorY: options.printerProfile.display.mirrorY === true,
    layerHeightMm,
    totalLayers: 1,
    tallestObjectHeightMm: layerHeightMm,
  };
}

async function rasterizeLayerStack(options: RasterLayerZipExportOptions): Promise<RasterizationResult> {
  throwIfAborted(options.abortSignal);
  const visibleModels = options.models.filter((model) => model.visible);
  if (visibleModels.length === 0) {
    throw new Error('No visible models available for slicing.');
  }

  const settings = resolveEffectiveSettings(options);
  const triangles = buildWorldTriangles(visibleModels);
  if (triangles.length === 0) {
    throw new Error('Unable to prepare world-space triangles from visible models.');
  }

  let maxZ = 0;
  for (let i = 0; i < triangles.length; i += 1) {
    maxZ = Math.max(maxZ, triangles[i].zMax);
  }

  const buildHeight = Math.max(0, maxZ);
  const maxBuildHeight = Math.max(0, Number(options.printerProfile.buildVolumeMm.height) || 0);
  const tallestObjectHeightMm = Math.min(buildHeight, maxBuildHeight);
  const totalLayers = Math.max(1, Math.ceil(tallestObjectHeightMm / settings.layerHeightMm));

  const rasterWidthPx = settings.sourceResolutionX;
  const rasterHeightPx = settings.sourceResolutionY;

  const canvas = getCanvas(rasterWidthPx, rasterHeightPx);
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error('Failed to create 2D rendering context for slicing.');
  }

  const layerTriangleBuckets = buildLayerWorldTriangleBuckets(triangles, totalLayers, settings.layerHeightMm);
  let emptyLayerPngBlob: Blob | null = null;
  let previousLayerTriangleIndices: number[] | null = null;
  let previousLayerPngBlob: Blob | null = null;
  const baseOpaqueBlack = new Uint8ClampedArray(rasterWidthPx * rasterHeightPx * 4);
  for (let i = 3; i < baseOpaqueBlack.length; i += 4) {
    baseOpaqueBlack[i] = 255;
  }
  const reusableImageData = new ImageData(rasterWidthPx, rasterHeightPx);
  reusableImageData.data.set(baseOpaqueBlack);
  ctx.putImageData(reusableImageData, 0, 0);
  const layerEntries: RasterizedLayerEntry[] = [];

  for (let layerIndex = 0; layerIndex < totalLayers; layerIndex += 1) {
    throwIfAborted(options.abortSignal);
    const zStart = layerIndex * settings.layerHeightMm;
    const zSample = (layerIndex + 0.5) * settings.layerHeightMm;

    const activeTriangleIndices = layerTriangleBuckets[layerIndex];
    let pngBlob: Blob;

    if (activeTriangleIndices.length === 0) {
      if (!emptyLayerPngBlob) {
        reusableImageData.data.set(baseOpaqueBlack);
        ctx.putImageData(reusableImageData, 0, 0);
        if (settings.xPackingMode === 'none') {
          emptyLayerPngBlob = await canvasToPngBlob(canvas);
        } else {
          emptyLayerPngBlob = await nanodlpPackRgbaToPngBlob(
            reusableImageData.data,
            rasterWidthPx,
            rasterHeightPx,
            settings.widthPx,
            settings.xPackingMode,
          );
        }
      }
      pngBlob = emptyLayerPngBlob;
    } else if (sameIndexSet(previousLayerTriangleIndices, activeTriangleIndices) && previousLayerPngBlob) {
      pngBlob = previousLayerPngBlob;
    } else {
      const segments = buildLayerSegmentsFromWorldTriangles(
        triangles,
        activeTriangleIndices,
        zSample,
          {
            ...settings,
            widthPx: rasterWidthPx,
            heightPx: rasterHeightPx,
          },
        options.printerProfile,
      );

      if (segments.length === 0) {
        if (!emptyLayerPngBlob) {
          reusableImageData.data.set(baseOpaqueBlack);
          ctx.putImageData(reusableImageData, 0, 0);
          if (settings.xPackingMode === 'none') {
            emptyLayerPngBlob = await canvasToPngBlob(canvas);
          } else {
            emptyLayerPngBlob = await nanodlpPackRgbaToPngBlob(
              reusableImageData.data,
              rasterWidthPx,
              rasterHeightPx,
              settings.widthPx,
              settings.xPackingMode,
            );
          }
        }
        pngBlob = emptyLayerPngBlob;
      } else {
        rasterizeSolidSegmentsToImage(
          rasterWidthPx,
          rasterHeightPx,
          segments,
          reusableImageData,
          baseOpaqueBlack,
        );
        if (settings.xPackingMode === 'none') {
          ctx.putImageData(reusableImageData, 0, 0);
          pngBlob = await canvasToPngBlob(canvas);
        } else {
          pngBlob = await nanodlpPackRgbaToPngBlob(
            reusableImageData.data,
            rasterWidthPx,
            rasterHeightPx,
            settings.widthPx,
            settings.xPackingMode,
          );
        }
      }
    }

    previousLayerTriangleIndices = activeTriangleIndices;
    previousLayerPngBlob = pngBlob;

    const layerUm = Math.round(zStart * 1000);
    const layerName = `layer_${String(layerIndex).padStart(5, '0')}_z_${String(layerUm).padStart(6, '0')}um.png`;
    layerEntries.push({ name: layerName, blob: pngBlob });

    if (shouldEmitProgress(layerIndex, totalLayers)) {
      options.onProgress?.(layerIndex + 1, totalLayers, 'Rasterizing layers');
    }

    if (layerIndex % 16 === 15) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      throwIfAborted(options.abortSignal);
    }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: 'raster_layer_zip_solid_v1',
    notes: [
      'JS fallback generates solid cross-sections via plane intersections and scanline fill.',
      'Used when plugin-owned WASM encoding path is unavailable or fails.',
    ],
    printer: {
      id: options.printerProfile.id,
      name: options.printerProfile.name,
      resolutionX: options.printerProfile.display.resolutionX,
      resolutionY: options.printerProfile.display.resolutionY,
      buildVolumeMm: options.printerProfile.buildVolumeMm,
      bitDepth: options.printerProfile.bitDepth,
      outputFormat: options.printerProfile.display.outputFormat,
      mirrorX: options.printerProfile.display.mirrorX === true,
      mirrorY: options.printerProfile.display.mirrorY === true,
    },
    material: {
      id: options.materialProfile.id,
      name: options.materialProfile.name,
      layerHeightMm: options.materialProfile.layerHeightMm,
      normalExposureSec: options.materialProfile.normalExposureSec,
      bottomExposureSec: options.materialProfile.bottomExposureSec,
      bottomLayerCount: options.materialProfile.bottomLayerCount,
      liftDistanceMm: options.materialProfile.liftDistanceMm,
      liftSpeedMmMin: options.materialProfile.liftSpeedMmMin,
      retractSpeedMmMin: options.materialProfile.retractSpeedMmMin,
    },
    effective: {
      widthPx: settings.widthPx,
      heightPx: settings.heightPx,
      sourceResolutionX: settings.sourceResolutionX,
      sourceResolutionY: settings.sourceResolutionY,
      xPackingMode: settings.xPackingMode,
      mirrorX: settings.mirrorX,
      mirrorY: settings.mirrorY,
      layerHeightMm: settings.layerHeightMm,
      totalLayers,
      tallestObjectHeightMm,
    },
    models: visibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      polygonCount: model.polygonCount,
      transform: {
        position: { x: model.transform.position.x, y: model.transform.position.y, z: model.transform.position.z },
        rotation: { x: model.transform.rotation.x, y: model.transform.rotation.y, z: model.transform.rotation.z },
        scale: { x: model.transform.scale.x, y: model.transform.scale.y, z: model.transform.scale.z },
      },
    })),
  };

  emitMeshPrepDiagnostic('Mesh prep: complete', 4, 4, {
    triangleFloatCount: triangles.length * 9,
    totalLayers,
  });

  return {
    settings,
    totalLayers,
    tallestObjectHeightMm,
    visibleModels,
    layerEntries,
    manifest,
  };
}

export async function rasterizeLayersForWasm(options: RasterLayerZipExportOptions): Promise<RasterizedLayerStackForWasm> {
  const rasterized = await rasterizeLayerStack(options);
  const layerPngs: Uint8Array[] = [];

  for (let i = 0; i < rasterized.layerEntries.length; i += 1) {
    const bytes = new Uint8Array(await rasterized.layerEntries[i].blob.arrayBuffer());
    layerPngs.push(bytes);
  }

  return {
    widthPx: rasterized.settings.widthPx,
    heightPx: rasterized.settings.heightPx,
    layerHeightMm: rasterized.settings.layerHeightMm,
    totalLayers: rasterized.totalLayers,
    tallestObjectHeightMm: rasterized.tallestObjectHeightMm,
    layerPngs,
    metadataJson: JSON.stringify(rasterized.manifest),
  };
}

export async function buildSolidSliceMeshForWasm(options: RasterLayerZipExportOptions): Promise<SolidSliceMeshForWasm> {
  const visibleModels = options.models.filter((model) => model.visible);
  if (visibleModels.length === 0) {
    throw new Error('No visible models available for slicing.');
  }

  emitMeshPrepDiagnostic('Mesh prep: start', 0, 4, {
    visibleModelCount: visibleModels.length,
  });

  const settings = resolveEffectiveSettings(options);
  const perfSettings = getSavedSlicingPerformanceSettings();
  const modelTriangleCount = countModelWorldTriangles(visibleModels);
  const collector = new TriangleFloatCollector(
    modelTriangleCount + 4096,
    options.flushBinaryMeshChunk,
    options.meshChunkTargetBytes,
  );

  appendModelWorldTrianglesToCollector(visibleModels, collector);
  emitMeshPrepDiagnostic('Mesh prep: models', 1, 4, {
    modelTriangleEstimate: modelTriangleCount,
    triangleCountAfterModels: collector.triangleCount,
  });

  const visibleModelIds = new Set(visibleModels.map((model) => model.id));
  buildSupportAndRaftWorldTriangles(visibleModelIds, collector);
  emitMeshPrepDiagnostic('Mesh prep: supports', 2, 4, {
    triangleCountAfterSupports: collector.triangleCount,
  });

  if (collector.triangleCount === 0) {
    throw new Error('Unable to prepare world-space triangles from visible models.');
  }

  const maxZ = Number.isFinite(collector.maxZ)
    ? Math.max(0, collector.maxZ)
    : 0;

  const buildHeight = maxZ;
  const maxBuildHeight = Math.max(0, Number(options.printerProfile.buildVolumeMm.height) || 0);
  const tallestObjectHeightMm = Math.min(buildHeight, maxBuildHeight);
  const totalLayers = Math.max(1, Math.ceil(tallestObjectHeightMm / settings.layerHeightMm));

  const trianglesXYZ = await collector.finalize();
  emitMeshPrepDiagnostic('Mesh prep: finalize', 3, 4, {
    triangleFloatCount: trianglesXYZ.length,
    triangleBytes: trianglesXYZ.byteLength,
    totalLayers,
  });

  const manifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    mode: 'wasm_solid_slice_v0',
    notes: [
      'Solid cross-sections are generated in Rust/WASM from transformed triangle meshes.',
      'Container packaging is encoded by plugin-owned format encoders.',
    ],
    printer: {
      id: options.printerProfile.id,
      name: options.printerProfile.name,
      resolutionX: options.printerProfile.display.resolutionX,
      resolutionY: options.printerProfile.display.resolutionY,
      buildVolumeMm: options.printerProfile.buildVolumeMm,
      bitDepth: options.printerProfile.bitDepth,
      outputFormat: options.printerProfile.display.outputFormat,
      mirrorX: options.printerProfile.display.mirrorX === true,
      mirrorY: options.printerProfile.display.mirrorY === true,
    },
    material: {
      id: options.materialProfile.id,
      name: options.materialProfile.name,
      layerHeightMm: options.materialProfile.layerHeightMm,
      normalExposureSec: options.materialProfile.normalExposureSec,
      bottomExposureSec: options.materialProfile.bottomExposureSec,
      bottomLayerCount: options.materialProfile.bottomLayerCount,
      liftDistanceMm: options.materialProfile.liftDistanceMm,
      liftSpeedMmMin: options.materialProfile.liftSpeedMmMin,
      retractSpeedMmMin: options.materialProfile.retractSpeedMmMin,
    },
    effective: {
      widthPx: settings.widthPx,
      heightPx: settings.heightPx,
      sourceResolutionX: settings.sourceResolutionX,
      sourceResolutionY: settings.sourceResolutionY,
      xPackingMode: settings.xPackingMode,
      mirrorX: settings.mirrorX,
      mirrorY: settings.mirrorY,
      layerHeightMm: settings.layerHeightMm,
      totalLayers,
      tallestObjectHeightMm,
    },
    models: visibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      polygonCount: model.polygonCount,
      transform: {
        position: { x: model.transform.position.x, y: model.transform.position.y, z: model.transform.position.z },
        rotation: { x: model.transform.rotation.x, y: model.transform.rotation.y, z: model.transform.rotation.z },
        scale: { x: model.transform.scale.x, y: model.transform.scale.y, z: model.transform.scale.z },
      },
    })),
  };

  return {
    sourceWidthPx: settings.sourceResolutionX,
    sourceHeightPx: settings.sourceResolutionY,
    widthPx: settings.widthPx,
    heightPx: settings.heightPx,
    xPackingMode: settings.xPackingMode,
    // Backend selection is managed internally by the slicing engine.
    computeBackend: 'auto',
    pngCompressionStrategy: perfSettings.pngCompressionStrategy,
    bvhAccelerationEnabled: perfSettings.bvhAccelerationEnabled,
    mirrorX: settings.mirrorX,
    mirrorY: settings.mirrorY,
    modelTriangleCount,
    buildWidthMm: Math.max(1, options.printerProfile.buildVolumeMm.width),
    buildDepthMm: Math.max(1, options.printerProfile.buildVolumeMm.depth),
    layerHeightMm: settings.layerHeightMm,
    totalLayers,
    tallestObjectHeightMm,
    trianglesXYZ,
    meshBounds: collector.meshBounds,
    metadataJson: JSON.stringify(manifest),
  };
}

export function buildProjectedCrossSectionLoopsAtZ(options: {
  models: LoadedModel[];
  zMm: number;
}): THREE.Vector2[][] {
  const context = buildProjectedCrossSectionContext(options.models);
  if (!context) return [];

  return buildProjectedCrossSectionLoopsAtZFromContext({
    context,
    zMm: options.zMm,
  });
}

export function buildProjectedCrossSectionContext(models: LoadedModel[]): ProjectedCrossSectionContext | null {
  const visibleModels = models.filter((model) => model.visible);
  if (visibleModels.length === 0) return null;

  const triangles = buildWorldTriangles(visibleModels);
  if (triangles.length === 0) return null;

  return {
    triangles,
    quantizedBucketsByStep: new Map(),
  };
}

export function buildProjectedCrossSectionLoopsAtZFromContext(options: {
  context: ProjectedCrossSectionContext;
  zMm: number;
  quantizedStepMm?: number;
}): THREE.Vector2[][] {
  const triangles = options.context.triangles;
  if (triangles.length === 0) return [];

  const zMm = options.zMm + 1e-5;
  const triangleIndices = getProjectedCrossSectionTriangleIndicesAtZ(
    options.context,
    options.zMm,
    options.quantizedStepMm,
  );
  const segments: Array<[[number, number], [number, number]]> = [];

  const triangleCount = triangleIndices ? triangleIndices.length : triangles.length;
  for (let i = 0; i < triangleCount; i += 1) {
    const tri = triangleIndices ? triangles[triangleIndices[i]] : triangles[i];
    if (zMm < tri.zMin || zMm > tri.zMax) continue;

    const ux = tri.bx - tri.ax;
    const uy = tri.by - tri.ay;
    const uz = tri.bz - tri.az;
    const vx = tri.cx - tri.ax;
    const vy = tri.cy - tri.ay;
    const vz = tri.cz - tri.az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    // Line-of-intersection direction for tri plane ∩ z=const plane (n × +Z)
    const dirX = ny;
    const dirY = -nx;

    const points: Array<[number, number]> = [];
    const p01 = edgePlaneIntersectionXY(tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, zMm);
    if (p01) pushDistinctPoint(points, p01);

    const p12 = edgePlaneIntersectionXY(tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz, zMm);
    if (p12) pushDistinctPoint(points, p12);

    const p20 = edgePlaneIntersectionXY(tri.cx, tri.cy, tri.cz, tri.ax, tri.ay, tri.az, zMm);
    if (p20) pushDistinctPoint(points, p20);

    if (points.length === 2) {
      let p1 = points[0];
      let p2 = points[1];
      if (Math.abs(dirX) > 1e-10 || Math.abs(dirY) > 1e-10) {
        const segX = p2[0] - p1[0];
        const segY = p2[1] - p1[1];
        if ((segX * dirX + segY * dirY) < 0) {
          p1 = points[1];
          p2 = points[0];
        }
      }
      segments.push([p1, p2]);
    }
  }

  const loops: THREE.Vector2[][] = [];
  const pointsEqual = (a: [number, number], b: [number, number], eps = 1e-5) => (
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
  );

  while (segments.length > 0) {
    const [start, end] = segments.shift()!;
    const loop: Array<[number, number]> = [start, end];

    let changed = true;
    while (changed && segments.length > 0) {
      changed = false;

      for (let s = 0; s < segments.length; s += 1) {
        const [a, b] = segments[s];
        const first = loop[0];
        const last = loop[loop.length - 1];

        if (pointsEqual(last, a)) {
          loop.push(b);
          segments.splice(s, 1);
          changed = true;
          break;
        }
        if (pointsEqual(last, b)) {
          loop.push(a);
          segments.splice(s, 1);
          changed = true;
          break;
        }
        if (pointsEqual(first, a)) {
          loop.unshift(b);
          segments.splice(s, 1);
          changed = true;
          break;
        }
        if (pointsEqual(first, b)) {
          loop.unshift(a);
          segments.splice(s, 1);
          changed = true;
          break;
        }
      }
    }

    if (loop.length >= 3) {
      loops.push(loop.map(([x, y]) => new THREE.Vector2(x, y)));
    }
  }

  return loops;
}

export async function exportRasterLayerZip(options: RasterLayerZipExportOptions): Promise<RasterLayerZipArtifact> {
  throwIfAborted(options.abortSignal);
  const rasterized = await rasterizeLayerStack(options);

  const zip = new JSZip();
  const zipFolder = zip.folder('layers');
  if (!zipFolder) {
    throw new Error('Failed to initialize layers folder in ZIP.');
  }

  for (let i = 0; i < rasterized.layerEntries.length; i += 1) {
    throwIfAborted(options.abortSignal);
    const layer = rasterized.layerEntries[i];
    zipFolder.file(layer.name, layer.blob);
  }

  zip.file('manifest.json', JSON.stringify(rasterized.manifest, null, 2));

  options.onProgress?.(rasterized.totalLayers, rasterized.totalLayers, 'Compressing ZIP');
  throwIfAborted(options.abortSignal);

  const outputBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'STORE',
  });

  throwIfAborted(options.abortSignal);

  const outputName = `${safeFilenameBase(options.filenameBase)}_layers.zip`;
  if (options.outputMode !== 'return') {
    triggerBlobDownload(outputBlob, outputName);
  }

  return {
    blob: outputBlob,
    outputName,
    totalLayers: rasterized.totalLayers,
  };
}
