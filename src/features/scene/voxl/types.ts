import type { DragonfruitImportFormat } from '@/supports/types';
import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import type { MeshHealthReport } from '@/utils/meshRepair';

export const VOXL_MAGIC = 'VOXL' as const;
export const VOXL_VERSION = 1 as const;

export type VoxlUnits = 'mm';
export type VoxlCoordinateSystem = 'right-handed-z-up';

export type VoxlMeshMode = 'none' | 'external-file' | 'embedded-file' | 'embedded-chunk';

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
  uncompressedSizeBytes?: number;
  sha256?: string;
  /**
   * For `embedded-chunk` models: the MESH-chunk ordinal this model's geometry
   * lives in. Present only on DUPLICATE models that share another model's
   * chunk (identical-geometry dedup); absent means "my own model index" (the
   * legacy 1:1 mapping). Files that use this carry container version 3 — the
   * compat floor rises to the reader generation that understands chunk sharing.
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
  /**
   * The plate this model stands on. Written only when it is not the scene's
   * first plate, so a single-plate scene's bytes are unchanged, and a reader
   * that ignores it places every model on one plate.
   */
  plateId?: string;
  transform: VoxlModelTransform;
  /**
   * The model tracks the scene's lift distance after transforms. Written only
   * when true, so an ordinary scene's bytes are unchanged; a reader that ignores
   * it keeps the stored transform, which is where the model was saved.
   */
  autoLift?: boolean;
  /** The bottom auto-lift returns the model to when it is turned off. */
  liftRestoreMm?: number;
  mesh: VoxlMeshRef;
  meshModifiers?: ModelMeshModifiers;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
  /**
   * The material this model prints in on a multi-tank printer (see
   * `LoadedModel.materialProfileId`). Additive: a reader that ignores it prints the
   * model in the plate's material.
   */
  materialProfileId?: string;
  /** The mesh colour the material assignment replaced, restored when it is cleared. */
  materialBaseColor?: string;
  /** Per-body material assignment, aligned with the model's body meshes (V3.4). */
  bodyMaterialProfileIds?: Array<string | null>;
  /** Per-body resolved colour, aligned with the model's body meshes (V3.4). */
  bodyColors?: Array<string | null>;
  /** How many body meshes this model carries in its `BODY` chunk (V3.4). */
  bodyCount?: number;
  /**
   * Baked mesh classification (V3.3): the native classify-only report for the
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
  /**
   * The printer the scene was written for, embedded whole. A scene therefore
   * does not depend on that profile being installed wherever it is opened: an
   * import can add it from the file when this machine does not have it.
   */
  printer?: VoxlPrinterBundle;
};

/**
 * The printer definition inside an embedded bundle. Only what a reader matches
 * on and compares is typed; the rest of the profile library's shape travels
 * untouched and is read by `importPrinterBundle`.
 */
export type VoxlPrinterProfile = {
  name?: string;
  officialPresetId?: string;
  buildVolumeMm?: { width: number; depth: number; height: number };
  [key: string]: unknown;
};

/**
 * The printer bundle a scene carries.
 *
 * This is the profile library's own export shape, minus what is not a fact about
 * the printer:
 *
 * - the export timestamp, which changes on every save and would defeat the
 *   autosave write-skip (the fingerprint is built from chunk content);
 * - the network and connection fields, which are session state and carry a LAN
 *   address and device ids;
 * - an uploaded photo, which is a data URL and would be duplicated into every
 *   save. A factory printer's image is a bundled asset path and is kept.
 */
export type VoxlPrinterBundle = {
  version: number;
  printer: VoxlPrinterProfile;
  materials: unknown[];
};

/** One build plate the scene holds. */
export type VoxlPlate = {
  /** Stable identity, so a plate keeps it across save and load. */
  id: string;
  /** What the user called it. Absent means the plate is unnamed. */
  name?: string;
};

export type VoxlSceneState = {
  activeModelId: string | null;
  selectedModelIds: string[];
  /**
   * The scene's build plates, in display order. Optional and additive: a reader
   * that ignores it sees every model as belonging to one plate, which is what a
   * scene written before plates existed actually had.
   */
  plates?: VoxlPlate[];
  /**
   * Which plate was being worked on. Optional, and a reader that ignores it can
   * fall back to the first plate; it is a cursor, not a fact about the geometry.
   */
  activePlateId?: string;
  /**
   * What the user called this build plate, shown on the plate itself. Kept for
   * a scene with exactly one plate, where it is that plate's name, so a reader
   * that only knows this field still shows it; `plates` is canonical.
   */
  plateName?: string;
};

export type VoxlDocumentV1 = {
  magic: typeof VOXL_MAGIC;
  version: typeof VOXL_VERSION;
  meta: VoxlMeta;
  scene: VoxlSceneState;
  models: VoxlModelEntry[];
  supports: DragonfruitImportFormat;
  extensions?: Record<string, unknown>;
  /** Material profiles the scene references (V3.4 `MATP` chunk), ids preserved. */
  materials?: unknown[];
};

export type VoxlModelRuntimeLike = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
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
  /** See `VoxlModelEntry.autoLift`. */
  autoLift?: boolean;
  /** See `VoxlModelEntry.liftRestoreMm`. */
  liftRestoreMm?: number;
  mesh?: VoxlMeshRef;
  meshModifiers?: ModelMeshModifiers;
  /** See `VoxlModelEntry.plateId`. */
  plateId?: string;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
  /** See `VoxlModelEntry.materialProfileId`. */
  materialProfileId?: string;
  /** See `VoxlModelEntry.materialBaseColor`. */
  materialBaseColor?: string;
  /** Body meshes to write into this model's `BODY` chunk (V3.5). */
  bodies?: Array<{ positions: Float32Array; index?: Uint32Array | null }>;
  /**
   * The merged geometry's centre when the bodies were captured. Stored in the
   * `BODY` header so a reader can put the bodies back into the space its own
   * (re-processed) merged mesh ended up in.
   */
  bodyCenter?: { x: number; y: number; z: number };
  /** See `VoxlModelEntry.bodyMaterialProfileIds`. */
  bodyMaterialProfileIds?: Array<string | null>;
  /** See `VoxlModelEntry.bodyColors`. */
  bodyColors?: Array<string | null>;
  /** See `VoxlModelEntry.classification` (V3.3). */
  classification?: MeshHealthReport;
};

export type BuildVoxlDocumentInput = {
  models: VoxlModelRuntimeLike[];
  activeModelId: string | null;
  selectedModelIds: string[];
  /** The scene's plates. Omitted writes a scene with no plate list at all. */
  plates?: VoxlPlate[];
  /** Which plate was active. Omitted writes no cursor. */
  activePlateId?: string;
  supports: DragonfruitImportFormat;
  meta?: Partial<Pick<VoxlMeta, 'generator' | 'generatorVersion' | 'printer'>>;
  extensions?: Record<string, unknown>;
  /** Material profiles the scene references (V3.4 `MATP` chunk). */
  materials?: unknown[];
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
/** Where a model's mesh chunk sits inside the container it was read from. */
export type VoxlMeshRange = {
  /** Byte offset of the chunk's data in the file. */
  offset: number;
  /** Length of the stored (compressed) bytes. */
  compressedSize: number;
  /** Length once decompressed, as the directory records it. */
  uncompressedSize: number;
  /** The container's compression code: 0 none, 1 zlib. */
  compression: number;
};

export type ParsedVoxlResult = {
  /** The parsed document normalised to V1 schema shape. */
  document: VoxlDocumentV1;
  /** Pre-decoded mesh bytes keyed by model ID (populated for V2 files, and empty
   *  for the models a deferred parse left to the native loader by range). */
  meshBytes: Map<string, Uint8Array>;
  /**
   * Mesh chunk locations keyed by model ID, when the parse deferred them
   * (`deferMeshChunks`): the native loader reads and inflates these itself, so a
   * scene load never holds 677 MB of mesh bytes in the webview. A model with a
   * range has no entry in `meshBytes`, and a caller that cannot reach the file
   * (no path) must parse without deferring.
   */
  meshRanges?: Map<string, VoxlMeshRange>;
  /** Pre-decoded original full-res mesh bytes keyed by model ID (if ORIG chunk present). */
  originalMeshBytes?: Map<string, Uint8Array>;
  /** Pre-compressed original mesh chunks for lazy decompression. */
  originalMeshChunks?: Map<string, PrecompressedChunk>;
  /** The detected layout revision of a binary file (2.1 inline, 3.1 chunked), or 1 for V1 JSON. */
  sourceVersion: number;
  /** Raw `BODY` chunk payloads keyed by model ID (V3.4). */
  bodyChunks?: Map<string, Uint8Array>;
};
