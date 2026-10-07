import type { DragonfruitImportFormat } from '@/supports/types';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import type { MeshHealthReport } from '@/utils/meshRepair';

export const VOXL_MAGIC = 'VOXL' as const;
export const VOXL_VERSION = 1 as const;

export type VoxlUnits = 'mm';
export type VoxlCoordinateSystem = 'right-handed-z-up';

export type VoxlMeshMode = 'none' | 'external-file' | 'embedded-file' | 'embedded-chunk';
export type VoxlMeshEncoding = 'base64-raw' | 'base64-rle-u8';
export type VoxlDocumentCompressionEncoding = 'base64-raw' | 'base64-rle-u8' | 'base64-zlib';

export type VoxlVec3 = {
  x: number;
  y: number;
  z: number;
};

export type VoxlModelTransform = {
  position: VoxlVec3;
  rotation: VoxlVec3; // Euler radians (XYZ)
  scale: VoxlVec3;
};

export type VoxlMeshRef = {
  mode: VoxlMeshMode;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
  dataEncoding?: VoxlMeshEncoding;
  uncompressedSizeBytes?: number;
  sha256?: string;
  /**
   * For `embedded-chunk` models: the MESH-chunk ordinal this model's geometry
   * lives in. Present only on DUPLICATE models that share another model's
   * chunk (identical-geometry dedup); absent means "my own model index" (the
   * legacy 1:1 mapping). Files that use this carry container version 3.
   */
  chunkIndex?: number;
};

/**
 * Native-preview linkage persisted with a model entry (STL-import
 * decimation remediation Phase 1). The embedded mesh payload of a >6M
 * import is the reduced preview; these fields let a reload re-link the
 * ORIGINAL on-disk source so output paths (slicing, mesh export) can stage
 * full resolution again. Additive + optional: files without them (and
 * older readers, which ignore unknown JSON fields) are unaffected.
 */
export type VoxlNativePreviewRef = {
  originalTriangleCount: number;
  previewTriangleCount: number;
  /** Import-time pre-centering bbox center (raw-file frame) — the frame
   *  datum for `w = M · (v_raw − cPre)` reprojection. */
  cPre?: [number, number, number];
  /** Import-time staleness fingerprint of the source file. */
  sourceFingerprint?: {
    sizeBytes: number;
    mtimeMs: number;
  };
};

export type VoxlModelEntry = {
  /**
   * Which plate this model sits on. VOXL 2.3.
   *
   * Absent in older files, where the scene had one plate, and absent in newer ones
   * for a model on the first plate: the transform is in world space either way, so
   * a reader that ignores this places the model exactly where it was.
   */
  plateId?: string;
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
  fileSizeBytes?: number;
  /** Absolute on-disk path of the original import (native-preview models). */
  sourcePath?: string;
  nativePreview?: VoxlNativePreviewRef;
  /** Reference to original full-resolution sidecar mesh file when not embedded directly in ORIG chunk. */
  originalRef?: VoxlMeshRef;
  /**
   * Set when the writer had to fall back to this model's last committed mesh
   * chunk because a geometry bake was still in flight when the tick's bounded
   * wait expired (Ph0.1 sub-phase D2). The bytes are one operation behind, and
   * recovery says so instead of presenting them as current. Omitted — never
   * written as `false` — so an ordinary scene's bytes are unchanged.
   */
  geometryStale?: boolean;
  transform: VoxlModelTransform;
  mesh: VoxlMeshRef;
  meshModifiers?: ModelMeshModifiers;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
  /**
   * Baked mesh classification (V2.4): the native classify-only report for the
   * exact triangle order stored in this model's `mesh` payload, so a reader can
   * restore the model/support split without re-running the classifier. Purely
   * additive — a reader that ignores it derives the same split by classifying.
   */
  classification?: MeshHealthReport;
};

export type VoxlMeta = {
  generator: string;
  generatorVersion?: string;
  createdAt: string;
  updatedAt: string;
  units: VoxlUnits;
  coordinateSystem: VoxlCoordinateSystem;
};

/**
 * One build plate. A scene may hold several, laid out side by side in world space,
 * with each model belonging to one of them.
 */
export type VoxlPlateEntry = {
  id: string;
  /** What the user called it, shown on the plate itself. */
  name: string;
};

/**
 * The printer a scene was built for. VOXL 2.6.
 *
 * The build volume is stored rather than looked up from `profileId`, and that is the
 * point of the shape: the reason to record the printer at all is to tell whether the
 * plate still fits on the machine it is opened on. A profile that has been edited,
 * renamed, or is not installed on this machine would leave the id with nothing to
 * check, while the volume it was packed against is exactly what the check needs.
 */
export type VoxlPrinterRef = {
  /** The profile that was active at save time, when there was one. */
  profileId?: string;
  /** Its name then, for display. A profile can be renamed after the fact. */
  name?: string;
  buildVolume: {
    widthMm: number;
    depthMm: number;
    maxZMm: number;
    originMode?: 'center' | 'front_left';
    safetyMarginMm?: { front: number; back: number; left: number; right: number };
  };
};

export type VoxlSceneState = {
  activeModelId: string | null;
  selectedModelIds: string[];
  /**
   * What the user called this build plate, shown on the plate itself. Optional
   * and additive: a reader that ignores it derives nothing from it, and an old
   * file without one loads as an unnamed plate rather than as an error.
   *
   * Superseded by `plates` in VOXL 2.3, where it is the name of the *first* plate.
   * Kept because a pre-2.3 file has no plates array and this is all it knows.
   */
  plateName?: string;
  /**
   * The scene's plates, in layout order. VOXL 2.3.
   *
   * Absent in older files, and a reader must treat that as one unnamed plate rather
   * than as an empty scene: the models are still there, they simply all belong to the
   * plate that did not need naming.
   */
  plates?: VoxlPlateEntry[];
  /** Which plate is being worked on. VOXL 2.3. Defaults to the first plate. */
  activePlateId?: string | null;
  /**
   * The printer this scene was packed for. VOXL 2.6.
   *
   * Optional, and absent from every file written before it existed. A reader without
   * it knows only what the scene contains, not what it was built to fit, so it must
   * not assume a mismatch either.
   */
  printer?: VoxlPrinterRef;
};

export type VoxlDocumentV1 = {
  magic: typeof VOXL_MAGIC;
  version: typeof VOXL_VERSION;
  meta: VoxlMeta;
  scene: VoxlSceneState;
  models: VoxlModelEntry[];
  supports: DragonfruitImportFormat;
  extensions?: Record<string, unknown>;
};

export type VoxlCompressionRef = {
  kind: 'document-json-utf8';
  encoding: VoxlDocumentCompressionEncoding;
  payloadBase64: string;
  uncompressedSizeBytes: number;
};

export type VoxlCompressedDocumentEnvelopeV1 = {
  magic: typeof VOXL_MAGIC;
  version: typeof VOXL_VERSION;
  compression: VoxlCompressionRef;
};

export type SerializeVoxlOptions = {
  compression?: 'none' | 'auto' | 'rle-u8' | 'zlib';
  embedOriginalMesh?: boolean;
};

export type VoxlModelRuntimeLike = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
  /** V2.5. Omitted for a model on the first plate. */
  plateId?: string;
  fileSizeBytes?: number;
  sourcePath?: string;
  nativePreview?: VoxlNativePreviewRef;
  originalRef?: VoxlMeshRef;
  /** See `VoxlModelEntry.geometryStale` (Ph0.1 sub-phase D2). */
  geometryStale?: boolean;
  transform: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  };
  mesh?: VoxlMeshRef;
  meshModifiers?: ModelMeshModifiers;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
  /** See `VoxlModelEntry.classification` (V2.4). */
  classification?: MeshHealthReport;
};

export type BuildVoxlDocumentInput = {
  models: VoxlModelRuntimeLike[];
  activeModelId: string | null;
  selectedModelIds: string[];
  /** V2.5. Omitted for a single-plate scene, which writes no plate fields at all. */
  plates?: VoxlPlateEntry[];
  activePlateId?: string | null;
  /** V2.6. The printer the scene was packed for. */
  printer?: VoxlPrinterRef;
  supports: DragonfruitImportFormat;
  meta?: Partial<Pick<VoxlMeta, 'generator' | 'generatorVersion'>>;
  extensions?: Record<string, unknown>;
};

export interface PrecompressedChunk {
  data: Uint8Array;
  compression: number;
  uncompressedSize: number;
}

/**
 * Unified result from parsing any VOXL file (V1 JSON or V2 binary).
 *
 * V2 binary files provide pre-decoded mesh bytes in `meshBytes`,
 * keyed by model ID, so the consumer can skip base64 round-trips.
 */
export type ParsedVoxlResult = {
  /** The parsed document normalised to V1 schema shape. */
  document: VoxlDocumentV1;
  /** Pre-decoded mesh bytes keyed by model ID (populated for V2 files). */
  meshBytes: Map<string, Uint8Array>;
  /** Pre-decoded original full-res mesh bytes keyed by model ID (if ORIG chunk present). */
  originalMeshBytes?: Map<string, Uint8Array>;
  /** Pre-compressed original mesh chunks for lazy decompression. */
  originalMeshChunks?: Map<string, PrecompressedChunk>;
  /** The VOXL format version that was read (e.g. 1, 2.1). */
  sourceVersion: number;
};
