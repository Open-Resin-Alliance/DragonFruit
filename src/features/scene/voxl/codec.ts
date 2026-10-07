import type { DragonfruitImportFormat, SupportState } from '@/supports/types';
import type { ParsedVoxlResult, VoxlPlate, VoxlSceneState } from './types';
import { isVoxlBinaryV2, parseVoxlBinaryV2 } from './codec-v2';
import { importPayloadCollections } from '@/supports/supportCollections';

export function buildSupportExportFromStores(
  supportState: SupportState,
  source = 'dragonfruit-voxl',
): DragonfruitImportFormat {
  const kickstands = Object.values(supportState.kickstands)
    .map((kickstand) => {
      const root = supportState.roots[kickstand.rootId];
      const hostKnot = supportState.knots[kickstand.hostKnotId];
      if (!root || !hostKnot) {
        return null;
      }
      return {
        root,
        hostKnot,
        kickstand,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return {
    version: 1,
    meta: {
      source,
      objectCenter: { x: 0, y: 0, z: 0 },
      updatedAt: Date.now(),
    },
    // Every collection the format carries, walked rather than listed, so a type
    // added to the registry is saved too. `kickstands` is rebuilt above from the
    // root and host knot each one owns, so it is written after the walk.
    ...importPayloadCollections(supportState),
    kickstands,
  };
}

// ─── Obsolete generations ─────────────────────────────────────────────────────

/**
 * Raised when a file is recognisably a VOXL scene from a generation this build
 * no longer reads. V1 — the legacy JSON container — was only ever written by
 * pre-release builds: the first release (`v0.1.3`, 2026-04-15) already wrote the
 * binary container, so no shipped DragonFruit produced one. Callers surface this
 * as a "saved by an unsupported version" prompt instead of a parse failure.
 */
export class VoxlObsoleteVersionError extends Error {
  /** Which legacy shape was recognised. */
  readonly detected: 'v1-json' | 'v1-binary';

  constructor(detected: 'v1-json' | 'v1-binary') {
    super(
      detected === 'v1-json'
        ? 'This scene is a VOXL V1 JSON document, which this version no longer reads.'
        : 'This scene is a VOXL V1 binary container, which this version no longer reads.',
    );
    this.name = 'VoxlObsoleteVersionError';
    this.detected = detected;
  }
}

const VOXL_MAGIC_BYTES = [0x56, 0x4f, 0x58, 0x4c] as const; // "VOXL"
const JSON_OBJECT_BYTE = 0x7b; // '{'

/**
 * Classify bytes as a legacy VOXL generation, or `null` if they are not one.
 *
 * V1 JSON is recognised by its leading `{` — the document, and the compressed
 * envelope, are both JSON objects; V1 binary by the `VOXL` magic with a
 * container version below `2`.
 */
export function detectObsoleteVoxlVersion(data: Uint8Array): 'v1-json' | 'v1-binary' | null {
  const hasMagic =
    data.length >= 4
    && data[0] === VOXL_MAGIC_BYTES[0]
    && data[1] === VOXL_MAGIC_BYTES[1]
    && data[2] === VOXL_MAGIC_BYTES[2]
    && data[3] === VOXL_MAGIC_BYTES[3];

  if (hasMagic) {
    if (data.length < 6) return null;
    const version = data[4] | (data[5] << 8); // uint16 LE
    return version < 2 ? 'v1-binary' : null;
  }

  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    // Skip leading whitespace so a pretty-printed document is still recognised.
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === JSON_OBJECT_BYTE ? 'v1-json' : null;
  }

  return null;
}

// ─── Scene plates ─────────────────────────────────────────────────────────────

/** What a scene state says about its plates, normalised for the caller. */
export type ReadScenePlates = {
  /** The plates the file lists, in order. Empty when the file predates the list. */
  plates: VoxlPlate[];
  /** The older single-plate shorthand, when the file carries no list. */
  legacyName: string | null;
  /** The plate the file had active, when it names one of its own plates. */
  activePlateId: string | null;
};

/**
 * Read the plates a scene state describes. The precedence lives here rather than
 * at each reader, so the older `plateName` shorthand cannot be interpreted two
 * ways: a file with a `plates` list is taken at its word, and a file without one
 * is a single plate whose name, if any, is the shorthand.
 *
 * An empty `plates` list means the file describes one plate that has no identity
 * of its own, and the caller mints one.
 */
export function readScenePlates(scene: VoxlSceneState): ReadScenePlates {
  const plates = (scene.plates ?? [])
    .filter((plate) => typeof plate?.id === 'string' && plate.id.length > 0)
    .map((plate) => ({
      id: plate.id,
      ...(typeof plate.name === 'string' && plate.name.length > 0 ? { name: plate.name } : {}),
    }));

  if (plates.length > 0) {
    const active = scene.activePlateId;
    const activePlateId = active && plates.some((plate) => plate.id === active)
      ? active
      : plates[0].id;
    return { plates, legacyName: null, activePlateId };
  }

  const legacyName = scene.plateName && scene.plateName.length > 0 ? scene.plateName : null;
  return { plates: [], legacyName, activePlateId: null };
}

// ─── Unified Parser ───────────────────────────────────────────────────────────

/**
 * Parse a VOXL scene from raw bytes.
 *
 * Only the binary container (compat floor `2` or `3`) is read. A legacy V1 file
 * raises `VoxlObsoleteVersionError` so the caller can explain it, and anything
 * else is rejected as not a VOXL file.
 *
 * Returns a `ParsedVoxlResult` with the normalised document and the pre-decoded
 * mesh bytes in `meshBytes`.
 */
export function parseVoxlAuto(data: Uint8Array | ArrayBuffer): ParsedVoxlResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.length === 0) {
    throw new Error('Cannot parse empty VOXL file.');
  }

  // Binary container: "VOXL" magic (0x56 0x4F 0x58 0x4C) + version >= 2.
  if (isVoxlBinaryV2(bytes)) {
    return parseVoxlBinaryV2(bytes);
  }

  const obsolete = detectObsoleteVoxlVersion(bytes);
  if (obsolete) {
    throw new VoxlObsoleteVersionError(obsolete);
  }

  throw new Error('Not a VOXL file: the VOXL binary header is missing.');
}
