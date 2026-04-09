import type { DragonfruitImportFormat } from '@/supports/types';

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
};

export type VoxlModelEntry = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
  fileSizeBytes?: number;
  transform: VoxlModelTransform;
  mesh: VoxlMeshRef;
};

export type VoxlMeta = {
  generator: string;
  generatorVersion?: string;
  createdAt: string;
  updatedAt: string;
  units: VoxlUnits;
  coordinateSystem: VoxlCoordinateSystem;
};

export type VoxlSceneState = {
  activeModelId: string | null;
  selectedModelIds: string[];
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
};

export type VoxlModelRuntimeLike = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
  fileSizeBytes?: number;
  transform: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  };
  mesh?: VoxlMeshRef;
};

export type BuildVoxlDocumentInput = {
  models: VoxlModelRuntimeLike[];
  activeModelId: string | null;
  selectedModelIds: string[];
  supports: DragonfruitImportFormat;
  meta?: Partial<Pick<VoxlMeta, 'generator' | 'generatorVersion'>>;
  extensions?: Record<string, unknown>;
};

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
  /** The container format version that was actually read (1 or 2). */
  sourceVersion: number;
};
