/**
 * The per-instance flag word of the instanced support renderer.
 *
 * One `uint32` carries the per-primitive state a batch has to know while it
 * writes instance buffers: the discrete appearance states (selection, hover,
 * scenery dimming, ...) and the small enums an instance matrix cannot express
 * (profile, shaft segment kind, primitive type, LOD).
 *
 * Every operation here is pure and allocates nothing: the word is arithmetic
 * state, written once per instance per rebuild and read by the shader-facing
 * layout code.
 *
 * Bit layout (least significant first):
 *
 * | bit(s) | field |
 * | --- | --- |
 * | 0 | VISIBLE |
 * | 1 | SELECTED |
 * | 2 | HOVERED |
 * | 3 | MARQUEE |
 * | 4 | DIM |
 * | 5 | SCENERY |
 * | 6 | COLLIDING |
 * | 7 | COLLISION_ACCEPTED |
 * | 8 | INTERIOR |
 * | 9 | DISK_SHADE |
 * | 10 | HIDDEN_IN_PICK |
 * | 11 | PREVIEW |
 * | 12-13 | PROFILE |
 * | 14-15 | SEG_KIND |
 * | 16-19 | TYPE |
 * | 20-21 | LOD |
 * | 22 | GHOST |
 * | 23 | OUT_OF_BOUNDS |
 * | 24 | HIDDEN_IN_NAV |
 * | 25-31 | unused, reserved |
 *
 * The bit numbering is part of the layout contract: the renderer, the pointer
 * index and the navigation view all read the same word.
 */

/** Bit 0 — the instance is drawn at all. */
export const INSTANCE_FLAG_VISIBLE = 1 << 0;
/** Bit 1 — the instance belongs to the current selection. */
export const INSTANCE_FLAG_SELECTED = 1 << 1;
/** Bit 2 — the instance is under the pointer. */
export const INSTANCE_FLAG_HOVERED = 1 << 2;
/** Bit 3 — the instance is a marquee candidate. */
export const INSTANCE_FLAG_MARQUEE = 1 << 3;
/** Bit 4 — the instance is dimmed rather than tinted. */
export const INSTANCE_FLAG_DIM = 1 << 4;
/** Bit 5 — the instance stands on another bed: scenery, not interactable. */
export const INSTANCE_FLAG_SCENERY = 1 << 5;
/** Bit 6 — the instance is in a collision state, before acceptance. */
export const INSTANCE_FLAG_COLLIDING = 1 << 6;
/** Bit 7 — a collision involving the instance was accepted. */
export const INSTANCE_FLAG_COLLISION_ACCEPTED = 1 << 7;
/** Bit 8 — the instance is inside the cavity / interior view. */
export const INSTANCE_FLAG_INTERIOR = 1 << 8;
/** Bit 9 — the contact primitive draws its disk face (disk profile). */
export const INSTANCE_FLAG_DISK_SHADE = 1 << 9;
/** Bit 10 — the instance is skipped by picking. */
export const INSTANCE_FLAG_HIDDEN_IN_PICK = 1 << 10;
/** Bit 11 — the instance is a placement / hollow preview, not scene state. */
export const INSTANCE_FLAG_PREVIEW = 1 << 11;
/** Bit 22 — the instance is drawn translucent (ghost). */
export const INSTANCE_FLAG_GHOST = 1 << 22;
/** Bit 23 — the instance lies outside the build volume overlay. */
export const INSTANCE_FLAG_OUT_OF_BOUNDS = 1 << 23;
/** Bit 24 — the instance is skipped by the navigation view. */
export const INSTANCE_FLAG_HIDDEN_IN_NAV = 1 << 24;

/** The flag masks, by the name of the state they carry. */
export const INSTANCE_FLAGS = {
  visible: INSTANCE_FLAG_VISIBLE,
  selected: INSTANCE_FLAG_SELECTED,
  hovered: INSTANCE_FLAG_HOVERED,
  marquee: INSTANCE_FLAG_MARQUEE,
  dim: INSTANCE_FLAG_DIM,
  scenery: INSTANCE_FLAG_SCENERY,
  colliding: INSTANCE_FLAG_COLLIDING,
  collisionAccepted: INSTANCE_FLAG_COLLISION_ACCEPTED,
  interior: INSTANCE_FLAG_INTERIOR,
  diskShade: INSTANCE_FLAG_DISK_SHADE,
  hiddenInPick: INSTANCE_FLAG_HIDDEN_IN_PICK,
  preview: INSTANCE_FLAG_PREVIEW,
  ghost: INSTANCE_FLAG_GHOST,
  outOfBounds: INSTANCE_FLAG_OUT_OF_BOUNDS,
  hiddenInNav: INSTANCE_FLAG_HIDDEN_IN_NAV,
} as const;

/** Bit 12-13 — tip profile code. */
export const INSTANCE_PROFILE_SHIFT = 12;
export const INSTANCE_PROFILE_MASK = 0b11;
/** Bit 14-15 — shaft segment kind code. */
export const INSTANCE_SEG_KIND_SHIFT = 14;
export const INSTANCE_SEG_KIND_MASK = 0b11;
/** Bit 16-19 — primitive type code. */
export const INSTANCE_TYPE_SHIFT = 16;
export const INSTANCE_TYPE_MASK = 0b1111;
/** Bit 20-21 — level of detail. */
export const INSTANCE_LOD_SHIFT = 20;
export const INSTANCE_LOD_MASK = 0b11;

/**
 * Profile codes. They mirror the cone group's own profile kind: a legacy tip
 * (no discriminated `type`) is 0, so a word that never set the field reads as
 * legacy rather than as a disk.
 */
export const INSTANCE_PROFILE_LEGACY = 0;
export const INSTANCE_PROFILE_DISK = 1;
export const INSTANCE_PROFILE_SPHERE = 2;

/** Shaft segment kind codes, in the order `ShaftSlotKind` lists them. */
export const INSTANCE_SEG_KIND_STRAIGHT = 0;
export const INSTANCE_SEG_KIND_TAPERED = 1;
export const INSTANCE_SEG_KIND_CURVED = 2;

/** Primitive type codes, in the order `SupportSlotKind` lists them. */
export const INSTANCE_TYPE_SHAFT = 0;
export const INSTANCE_TYPE_JOINT = 1;
export const INSTANCE_TYPE_ROOT = 2;
export const INSTANCE_TYPE_CONE = 3;

/** Highest LOD code the field can hold; level 0 is the only one in use today. */
export const INSTANCE_LOD_FULL = 0;
export const INSTANCE_LOD_MAX = INSTANCE_LOD_MASK;

/** Every state a flag word can carry, as one partial record. */
export type InstanceFlagFields = {
  visible?: boolean;
  selected?: boolean;
  hovered?: boolean;
  marquee?: boolean;
  dim?: boolean;
  scenery?: boolean;
  colliding?: boolean;
  collisionAccepted?: boolean;
  interior?: boolean;
  diskShade?: boolean;
  hiddenInPick?: boolean;
  preview?: boolean;
  ghost?: boolean;
  outOfBounds?: boolean;
  hiddenInNav?: boolean;
  profile?: number;
  segKind?: number;
  type?: number;
  lod?: number;
};

/** The order the boolean fields are packed in, so packing is one loop. */
const BOOLEAN_FIELDS: readonly (readonly [keyof InstanceFlagFields, number])[] = [
  ['visible', INSTANCE_FLAG_VISIBLE],
  ['selected', INSTANCE_FLAG_SELECTED],
  ['hovered', INSTANCE_FLAG_HOVERED],
  ['marquee', INSTANCE_FLAG_MARQUEE],
  ['dim', INSTANCE_FLAG_DIM],
  ['scenery', INSTANCE_FLAG_SCENERY],
  ['colliding', INSTANCE_FLAG_COLLIDING],
  ['collisionAccepted', INSTANCE_FLAG_COLLISION_ACCEPTED],
  ['interior', INSTANCE_FLAG_INTERIOR],
  ['diskShade', INSTANCE_FLAG_DISK_SHADE],
  ['hiddenInPick', INSTANCE_FLAG_HIDDEN_IN_PICK],
  ['preview', INSTANCE_FLAG_PREVIEW],
  ['ghost', INSTANCE_FLAG_GHOST],
  ['outOfBounds', INSTANCE_FLAG_OUT_OF_BOUNDS],
  ['hiddenInNav', INSTANCE_FLAG_HIDDEN_IN_NAV],
];

function setField(flags: number, shift: number, mask: number, value: number): number {
  return ((flags & ~(mask << shift)) | ((value & mask) << shift)) >>> 0;
}

function readField(flags: number, shift: number, mask: number): number {
  return (flags >>> shift) & mask;
}

/** Turn one flag bit on or off, leaving every other bit alone. */
export function setInstanceFlag(flags: number, flag: number, on: boolean): number {
  return on ? (flags | flag) >>> 0 : (flags & ~flag) >>> 0;
}

/** Whether one flag bit is set. */
export function getInstanceFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

/** Set the profile field (bits 12-13); the value is masked to the field width. */
export function setProfile(flags: number, profile: number): number {
  return setField(flags, INSTANCE_PROFILE_SHIFT, INSTANCE_PROFILE_MASK, profile);
}

/** Set the shaft segment kind field (bits 14-15). */
export function setSegKind(flags: number, segKind: number): number {
  return setField(flags, INSTANCE_SEG_KIND_SHIFT, INSTANCE_SEG_KIND_MASK, segKind);
}

/** Set the primitive type field (bits 16-19). */
export function setType(flags: number, type: number): number {
  return setField(flags, INSTANCE_TYPE_SHIFT, INSTANCE_TYPE_MASK, type);
}

/** Set the level-of-detail field (bits 20-21). */
export function setLod(flags: number, lod: number): number {
  return setField(flags, INSTANCE_LOD_SHIFT, INSTANCE_LOD_MASK, lod);
}

export function readProfile(flags: number): number {
  return readField(flags, INSTANCE_PROFILE_SHIFT, INSTANCE_PROFILE_MASK);
}

export function readSegKind(flags: number): number {
  return readField(flags, INSTANCE_SEG_KIND_SHIFT, INSTANCE_SEG_KIND_MASK);
}

export function readType(flags: number): number {
  return readField(flags, INSTANCE_TYPE_SHIFT, INSTANCE_TYPE_MASK);
}

export function readLod(flags: number): number {
  return readField(flags, INSTANCE_LOD_SHIFT, INSTANCE_LOD_MASK);
}

/**
 * Build one flag word from the fields that are present.
 *
 * Omitted fields are their zero value, so a pack is a full overwrite: pass the
 * whole state each time rather than patching an old word.
 */
export function packInstanceFlags(fields: InstanceFlagFields = {}): number {
  let flags = 0;
  for (let i = 0; i < BOOLEAN_FIELDS.length; i += 1) {
    const [name, bit] = BOOLEAN_FIELDS[i];
    if (fields[name] === true) flags |= bit;
  }
  if (fields.profile !== undefined) flags = setProfile(flags, fields.profile);
  if (fields.segKind !== undefined) flags = setSegKind(flags, fields.segKind);
  if (fields.type !== undefined) flags = setType(flags, fields.type);
  if (fields.lod !== undefined) flags = setLod(flags, fields.lod);
  return flags >>> 0;
}
