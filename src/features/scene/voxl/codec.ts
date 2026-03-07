import type { SupportBraceState } from '@/supports/SupportTypes/SupportBrace/types';
import type { DragonfruitImportFormat, SupportState, Vec3 } from '@/supports/types';
import { unzlibSync, zlibSync } from 'fflate';
import {
  VOXL_MAGIC,
  VOXL_VERSION,
  type BuildVoxlDocumentInput,
  type SerializeVoxlOptions,
  type VoxlCompressedDocumentEnvelopeV1,
  type VoxlDocumentV1,
  type VoxlModelEntry,
  type VoxlModelRuntimeLike,
  type VoxlVec3,
} from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  throw new Error('Base64 encoding is unavailable in this environment.');
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, '');

  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }

  throw new Error('Base64 decoding is unavailable in this environment.');
}

function encodeRleU8(input: Uint8Array): Uint8Array {
  if (input.length === 0) return new Uint8Array();

  const output: number[] = [];
  let runValue = input[0];
  let runCount = 1;

  for (let i = 1; i < input.length; i += 1) {
    const value = input[i];
    if (value === runValue && runCount < 255) {
      runCount += 1;
    } else {
      output.push(runCount, runValue);
      runValue = value;
      runCount = 1;
    }
  }

  output.push(runCount, runValue);
  return new Uint8Array(output);
}

function decodeRleU8(encoded: Uint8Array, expectedSize: number): Uint8Array {
  if (!Number.isFinite(expectedSize) || expectedSize <= 0 || !Number.isInteger(expectedSize)) {
    throw new Error('Invalid VOXL compressed payload expected size.');
  }

  if (encoded.length % 2 !== 0) {
    throw new Error('Invalid VOXL compressed payload (RLE pair mismatch).');
  }

  const out = new Uint8Array(expectedSize);
  let outIndex = 0;

  for (let i = 0; i < encoded.length; i += 2) {
    const count = encoded[i];
    const value = encoded[i + 1];

    if (count <= 0) {
      throw new Error('Invalid VOXL compressed payload (zero run length).');
    }

    const next = outIndex + count;
    if (next > expectedSize) {
      throw new Error('Invalid VOXL compressed payload (run exceeds expected size).');
    }

    out.fill(value, outIndex, next);
    outIndex = next;
  }

  if (outIndex !== expectedSize) {
    throw new Error('Invalid VOXL compressed payload (decoded size mismatch).');
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function tryInflateCompressedEnvelope(root: unknown): Partial<VoxlDocumentV1> | null {
  const maybeEnvelope = asRecord(root);
  if (!maybeEnvelope) return null;
  if (maybeEnvelope.magic !== VOXL_MAGIC || maybeEnvelope.version !== VOXL_VERSION) return null;

  const compression = asRecord(maybeEnvelope.compression);
  if (!compression) return null;

  if (compression.kind !== 'document-json-utf8') {
    throw new Error(`Unsupported VOXL compression kind: ${String(compression.kind)}.`);
  }

  const encoding = compression.encoding;
  if (encoding !== 'base64-raw' && encoding !== 'base64-rle-u8' && encoding !== 'base64-zlib') {
    throw new Error(`Unsupported VOXL document compression encoding: ${String(encoding)}.`);
  }

  const payloadBase64 = compression.payloadBase64;
  if (typeof payloadBase64 !== 'string' || payloadBase64.trim().length === 0) {
    throw new Error('Invalid VOXL compressed envelope: missing payloadBase64.');
  }

  const uncompressedSizeBytes = compression.uncompressedSizeBytes;
  if (!Number.isFinite(uncompressedSizeBytes) || (uncompressedSizeBytes as number) <= 0 || !Number.isInteger(uncompressedSizeBytes)) {
    throw new Error('Invalid VOXL compressed envelope: uncompressedSizeBytes must be a positive integer.');
  }

  const encodedBytes = base64ToBytes(payloadBase64);
  let decodedBytes: Uint8Array;
  if (encoding === 'base64-rle-u8') {
    decodedBytes = decodeRleU8(encodedBytes, uncompressedSizeBytes as number);
  } else if (encoding === 'base64-zlib') {
    decodedBytes = unzlibSync(encodedBytes);
  } else {
    decodedBytes = encodedBytes;
  }

  if (decodedBytes.length !== uncompressedSizeBytes) {
    throw new Error('Invalid VOXL compressed envelope: decoded size mismatch.');
  }

  const innerJson = textDecoder.decode(decodedBytes);
  const inner = JSON.parse(innerJson) as Partial<VoxlDocumentV1>;
  return inner;
}

function toVec3(value: { x: number; y: number; z: number }): VoxlVec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function ensureFiniteVec3(value: VoxlVec3, label: string): VoxlVec3 {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) {
    throw new Error(`Invalid ${label} vector in VOXL payload.`);
  }
  return value;
}

function mapModelToVoxl(model: VoxlModelRuntimeLike): VoxlModelEntry {
  return {
    id: model.id,
    name: model.name,
    visible: Boolean(model.visible),
    color: model.color,
    polygonCount: Math.max(0, Math.floor(model.polygonCount || 0)),
    fileSizeBytes: typeof model.fileSizeBytes === 'number' && Number.isFinite(model.fileSizeBytes)
      ? Math.max(0, Math.floor(model.fileSizeBytes))
      : undefined,
    transform: {
      position: toVec3(model.transform.position),
      rotation: toVec3(model.transform.rotation),
      scale: toVec3(model.transform.scale),
    },
    mesh: model.mesh ?? {
      mode: 'external-file',
      fileName: model.name,
    },
  };
}

function emptyVec3(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

export function buildSupportExportFromStores(
  supportState: SupportState,
  supportBraceState: SupportBraceState,
  source = 'dragonfruit-voxl',
): DragonfruitImportFormat {
  const supportBraces = Object.values(supportBraceState.supportBraces)
    .map((supportBrace) => {
      const root = supportBraceState.roots[supportBrace.rootId];
      const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
      if (!root || !hostKnot) return null;
      return {
        root,
        hostKnot,
        supportBrace,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    version: 1,
    meta: {
      source,
      objectCenter: emptyVec3(),
      updatedAt: Date.now(),
    },
    roots: Object.values(supportState.roots),
    trunks: Object.values(supportState.trunks),
    branches: Object.values(supportState.branches),
    leaves: Object.values(supportState.leaves),
    twigs: Object.values(supportState.twigs),
    sticks: Object.values(supportState.sticks),
    braces: Object.values(supportState.braces),
    knots: Object.values(supportState.knots),
    supportBraces,
  };
}

export function buildVoxlDocumentV1(input: BuildVoxlDocumentInput): VoxlDocumentV1 {
  const nowIso = new Date().toISOString();
  const models = input.models.map(mapModelToVoxl);

  return {
    magic: VOXL_MAGIC,
    version: VOXL_VERSION,
    meta: {
      generator: input.meta?.generator ?? 'DragonFruit',
      generatorVersion: input.meta?.generatorVersion,
      createdAt: nowIso,
      updatedAt: nowIso,
      units: 'mm',
      coordinateSystem: 'right-handed-z-up',
    },
    scene: {
      activeModelId: input.activeModelId,
      selectedModelIds: [...input.selectedModelIds],
    },
    models,
    supports: input.supports,
    extensions: input.extensions,
  };
}

export function serializeVoxlDocument(document: VoxlDocumentV1, pretty = true, options?: SerializeVoxlOptions): string {
  const rawJson = JSON.stringify(document, null, pretty ? 2 : 0);
  const compressionMode = options?.compression ?? 'auto';

  if (compressionMode === 'none') {
    return rawJson;
  }

  const rawBytes = textEncoder.encode(rawJson);
  const rleBytes = encodeRleU8(rawBytes);
  const zlibBytes = zlibSync(rawBytes, { level: 9 });

  let encoding: 'base64-raw' | 'base64-rle-u8' | 'base64-zlib' = 'base64-raw';
  let payloadBytes: Uint8Array = rawBytes;

  if (compressionMode === 'rle-u8') {
    encoding = 'base64-rle-u8';
    payloadBytes = rleBytes;
  } else if (compressionMode === 'zlib') {
    encoding = 'base64-zlib';
    payloadBytes = zlibBytes;
  } else {
    const candidates: Array<{ encoding: 'base64-raw' | 'base64-rle-u8' | 'base64-zlib'; bytes: Uint8Array }> = [
      { encoding: 'base64-raw', bytes: rawBytes },
      { encoding: 'base64-rle-u8', bytes: rleBytes },
      { encoding: 'base64-zlib', bytes: zlibBytes },
    ];

    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      if (candidates[i].bytes.length < best.bytes.length) {
        best = candidates[i];
      }
    }

    encoding = best.encoding;
    payloadBytes = best.bytes;
  }

  const envelope: VoxlCompressedDocumentEnvelopeV1 = {
    magic: VOXL_MAGIC,
    version: VOXL_VERSION,
    compression: {
      kind: 'document-json-utf8',
      encoding,
      payloadBase64: bytesToBase64(payloadBytes),
      uncompressedSizeBytes: rawBytes.length,
    },
  };

  return JSON.stringify(envelope, null, pretty ? 2 : 0);
}

export function parseVoxlDocument(json: string): VoxlDocumentV1 {
  const root = JSON.parse(json) as unknown;
  const inflated = tryInflateCompressedEnvelope(root);
  const parsed = (inflated ?? root) as Partial<VoxlDocumentV1>;

  if (parsed.magic !== VOXL_MAGIC) {
    throw new Error('Invalid VOXL magic header.');
  }
  if (parsed.version !== VOXL_VERSION) {
    throw new Error(`Unsupported VOXL version: ${String(parsed.version)}.`);
  }
  if (!parsed.meta || !parsed.scene || !Array.isArray(parsed.models) || !parsed.supports) {
    throw new Error('Invalid VOXL document structure.');
  }

  for (const model of parsed.models) {
    if (!model?.id || !model?.name || !model?.transform) {
      throw new Error('VOXL model entry is missing required fields.');
    }

    ensureFiniteVec3(model.transform.position, 'model.position');
    ensureFiniteVec3(model.transform.rotation, 'model.rotation');
    ensureFiniteVec3(model.transform.scale, 'model.scale');

    if (model.mesh?.mode === 'embedded-file') {
      if (typeof model.mesh.dataBase64 !== 'string' || model.mesh.dataBase64.trim().length === 0) {
        throw new Error(`VOXL model "${model.name}" has embedded mesh mode but missing dataBase64 payload.`);
      }

      const encoding = model.mesh.dataEncoding ?? 'base64-raw';
      if (encoding !== 'base64-raw' && encoding !== 'base64-rle-u8') {
        throw new Error(`VOXL model "${model.name}" has unsupported mesh encoding: ${encoding}.`);
      }

      if (encoding === 'base64-rle-u8') {
        const size = model.mesh.uncompressedSizeBytes;
        if (!Number.isFinite(size) || (size as number) <= 0 || !Number.isInteger(size)) {
          throw new Error(`VOXL model "${model.name}" is missing a valid uncompressedSizeBytes for RLE payload.`);
        }
      }

      if (typeof model.mesh.sha256 === 'string' && model.mesh.sha256.length > 0) {
        if (!/^[a-fA-F0-9]{64}$/.test(model.mesh.sha256)) {
          throw new Error(`VOXL model "${model.name}" has invalid sha256 format.`);
        }
      }
    }
  }

  return parsed as VoxlDocumentV1;
}
