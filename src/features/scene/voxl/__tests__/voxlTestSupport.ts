import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '../types';
import type { DragonfruitImportFormat } from '@/supports/types';

export const EMPTY_SUPPORTS: DragonfruitImportFormat = {
  version: 1,
  meta: { source: 'unit-test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
} as unknown as DragonfruitImportFormat;

export function testModel(id: string, overrides: Partial<VoxlModelRuntimeLike> = {}): VoxlModelRuntimeLike {
  return {
    id,
    name: id,
    visible: true,
    color: '#ffffff',
    polygonCount: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    mesh: { mode: 'embedded-file', fileName: `${id}.stl`, mimeType: 'model/stl' },
    ...overrides,
  };
}

export function testInput(
  models: Array<string | VoxlModelRuntimeLike>,
): BuildVoxlDocumentInput {
  const resolved = models.map((m) => (typeof m === 'string' ? testModel(m) : m));
  return {
    models: resolved,
    activeModelId: resolved[0]?.id ?? null,
    selectedModelIds: [],
    supports: EMPTY_SUPPORTS,
  };
}

/**
 * The META chunk embeds `new Date().toISOString()`, so two serializations of the
 * same scene differ by however many milliseconds elapsed between them. Every
 * byte-identity assertion in this suite is about the CODEC, not the clock —
 * freeze it so the comparison means what it says.
 */
export async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  const frozen = RealDate.parse('2026-07-26T00:00:00.000Z');

  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozen);
      else super(...(args as [number]));
    }

    static now(): number {
      return frozen;
    }
  }

  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Reads the container version from a serialized VOXL document. */
export const readVoxlVersion = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true);

/** Counts chunks of a given 4-char type in a serialized VOXL document. */
export function countVoxlChunks(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkCount = view.getUint32(8, true);
  let n = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const base = 16 + i * 20;
    const tag = String.fromCharCode(bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]);
    if (tag === type) n += 1;
  }
  return n;
}

/** Deterministic pseudo-random bytes — compressible enough to exercise zlib. */
export function meshLike(seed: number, length = 8192): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) & 0x1f; // low entropy → zlib actually shrinks it
  }
  return out;
}
