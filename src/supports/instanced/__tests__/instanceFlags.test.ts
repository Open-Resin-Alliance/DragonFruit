import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  INSTANCE_FLAG_COLLIDING,
  INSTANCE_FLAG_COLLISION_ACCEPTED,
  INSTANCE_FLAG_DIM,
  INSTANCE_FLAG_DISK_SHADE,
  INSTANCE_FLAG_GHOST,
  INSTANCE_FLAG_HIDDEN_IN_NAV,
  INSTANCE_FLAG_HIDDEN_IN_PICK,
  INSTANCE_FLAG_HOVERED,
  INSTANCE_FLAG_INTERIOR,
  INSTANCE_FLAG_MARQUEE,
  INSTANCE_FLAG_OUT_OF_BOUNDS,
  INSTANCE_FLAG_PREVIEW,
  INSTANCE_FLAG_SCENERY,
  INSTANCE_FLAG_SELECTED,
  INSTANCE_FLAG_VISIBLE,
  INSTANCE_FLAGS,
  INSTANCE_LOD_MAX,
  INSTANCE_PROFILE_DISK,
  INSTANCE_PROFILE_SPHERE,
  INSTANCE_SEG_KIND_CURVED,
  INSTANCE_TYPE_CONE,
  getInstanceFlag,
  packInstanceFlags,
  readLod,
  readProfile,
  readSegKind,
  readType,
  setInstanceFlag,
  setLod,
  setProfile,
  setSegKind,
  setType,
} from '../instanceFlags';
import type { InstanceFlagFields } from '../instanceFlags';

type BooleanFlagName = Exclude<keyof InstanceFlagFields, 'profile' | 'segKind' | 'type' | 'lod'>;

/** Every boolean state, with the bit it is documented to occupy. */
const BITS: readonly (readonly [BooleanFlagName, number, number])[] = [
  ['visible', INSTANCE_FLAG_VISIBLE, 0],
  ['selected', INSTANCE_FLAG_SELECTED, 1],
  ['hovered', INSTANCE_FLAG_HOVERED, 2],
  ['marquee', INSTANCE_FLAG_MARQUEE, 3],
  ['dim', INSTANCE_FLAG_DIM, 4],
  ['scenery', INSTANCE_FLAG_SCENERY, 5],
  ['colliding', INSTANCE_FLAG_COLLIDING, 6],
  ['collisionAccepted', INSTANCE_FLAG_COLLISION_ACCEPTED, 7],
  ['interior', INSTANCE_FLAG_INTERIOR, 8],
  ['diskShade', INSTANCE_FLAG_DISK_SHADE, 9],
  ['hiddenInPick', INSTANCE_FLAG_HIDDEN_IN_PICK, 10],
  ['preview', INSTANCE_FLAG_PREVIEW, 11],
  ['ghost', INSTANCE_FLAG_GHOST, 22],
  ['outOfBounds', INSTANCE_FLAG_OUT_OF_BOUNDS, 23],
  ['hiddenInNav', INSTANCE_FLAG_HIDDEN_IN_NAV, 24],
];

/** Pack one boolean state and nothing else. */
function packedAlone(name: BooleanFlagName): number {
  const fields: InstanceFlagFields = {};
  fields[name] = true;
  return packInstanceFlags(fields);
}

const ALL_SET: InstanceFlagFields = {
  visible: true,
  selected: true,
  hovered: true,
  marquee: true,
  dim: true,
  scenery: true,
  colliding: true,
  collisionAccepted: true,
  interior: true,
  diskShade: true,
  hiddenInPick: true,
  preview: true,
  ghost: true,
  outOfBounds: true,
  hiddenInNav: true,
  profile: INSTANCE_PROFILE_SPHERE,
  segKind: INSTANCE_SEG_KIND_CURVED,
  type: INSTANCE_TYPE_CONE,
  lod: INSTANCE_LOD_MAX,
};

describe('instance flag layout', () => {
  it('places every boolean state at its documented bit', () => {
    for (const [, mask, bit] of BITS) {
      assert.strictEqual(mask, 1 << bit);
    }
    assert.strictEqual(INSTANCE_FLAGS.collisionAccepted, INSTANCE_FLAG_COLLISION_ACCEPTED);
    assert.strictEqual(INSTANCE_FLAGS.hiddenInNav, INSTANCE_FLAG_HIDDEN_IN_NAV);
  });

  it('keeps the enum fields inside their four windows', () => {
    const flags = packInstanceFlags(ALL_SET);

    assert.strictEqual(readProfile(flags), INSTANCE_PROFILE_SPHERE);
    assert.strictEqual(readSegKind(flags), INSTANCE_SEG_KIND_CURVED);
    assert.strictEqual(readType(flags), INSTANCE_TYPE_CONE);
    assert.strictEqual(readLod(flags), INSTANCE_LOD_MAX);
    // The windows must not overlap the neighbouring state bits.
    assert.strictEqual(getInstanceFlag(flags, INSTANCE_FLAG_PREVIEW), true);
    assert.strictEqual(readProfile(packInstanceFlags({ preview: true })), 0);
    assert.strictEqual(readSegKind(packInstanceFlags({ preview: true })), 0);
    assert.strictEqual(readLod(packInstanceFlags({ ghost: true })), 0);
    assert.strictEqual(readType(packInstanceFlags({ preview: true })), 0);
  });

  it('packs each state on its own without touching the others', () => {
    for (const [name, mask] of BITS) {
      const flags = packedAlone(name);

      assert.strictEqual(flags, mask, `${String(name)} alone must be its own bit`);
      assert.strictEqual(getInstanceFlag(flags, mask), true);
      for (const [otherName, otherMask] of BITS) {
        if (otherName === name) continue;
        assert.strictEqual(getInstanceFlag(flags, otherMask), false, `${String(otherName)} must stay clear`);
      }
      assert.strictEqual(readProfile(flags), 0);
      assert.strictEqual(readSegKind(flags), 0);
      assert.strictEqual(readType(flags), 0);
      assert.strictEqual(readLod(flags), 0);
    }
  });

  it('round-trips a fully populated word', () => {
    const flags = packInstanceFlags(ALL_SET);

    for (const [name, mask] of BITS) {
      assert.strictEqual(getInstanceFlag(flags, mask), true, `${String(name)} must survive the pack`);
    }
    assert.strictEqual(flags >>> 0, flags);
    assert.strictEqual(packInstanceFlags({}), 0);
  });
});

describe('instance flag setters', () => {
  it('toggles one bit and leaves the rest of the word alone', () => {
    const full = packInstanceFlags(ALL_SET);
    const cleared = setInstanceFlag(full, INSTANCE_FLAG_VISIBLE, false);

    assert.strictEqual(cleared, full & ~INSTANCE_FLAG_VISIBLE);
    assert.strictEqual(getInstanceFlag(cleared, INSTANCE_FLAG_VISIBLE), false);
    assert.strictEqual(getInstanceFlag(cleared, INSTANCE_FLAG_SELECTED), true);

    const restored = setInstanceFlag(cleared, INSTANCE_FLAG_VISIBLE, true);
    assert.strictEqual(restored, full);
  });

  it('writes each enum field without disturbing the others or the boolean states', () => {
    const full = packInstanceFlags(ALL_SET);

    const legacyProfile = setProfile(full, 0);
    assert.strictEqual(readProfile(legacyProfile), 0);
    assert.strictEqual(readSegKind(legacyProfile), INSTANCE_SEG_KIND_CURVED);
    assert.strictEqual(readType(legacyProfile), INSTANCE_TYPE_CONE);
    assert.strictEqual(readLod(legacyProfile), INSTANCE_LOD_MAX);
    assertBooleansUnchanged(legacyProfile);

    const straight = setSegKind(full, 0);
    assert.strictEqual(readSegKind(straight), 0);
    assert.strictEqual(readProfile(straight), INSTANCE_PROFILE_SPHERE);
    assert.strictEqual(readType(straight), INSTANCE_TYPE_CONE);
    assert.strictEqual(readLod(straight), INSTANCE_LOD_MAX);
    assertBooleansUnchanged(straight);

    const shaftType = setType(full, 0);
    assert.strictEqual(readType(shaftType), 0);
    assert.strictEqual(readProfile(shaftType), INSTANCE_PROFILE_SPHERE);
    assert.strictEqual(readSegKind(shaftType), INSTANCE_SEG_KIND_CURVED);
    assert.strictEqual(readLod(shaftType), INSTANCE_LOD_MAX);
    assertBooleansUnchanged(shaftType);

    const lodFull = setLod(full, 0);
    assert.strictEqual(readLod(lodFull), 0);
    assert.strictEqual(readProfile(lodFull), INSTANCE_PROFILE_SPHERE);
    assert.strictEqual(readSegKind(lodFull), INSTANCE_SEG_KIND_CURVED);
    assert.strictEqual(readType(lodFull), INSTANCE_TYPE_CONE);
    assertBooleansUnchanged(lodFull);
  });

  it('masks an over-wide value into the field instead of bleeding into its neighbours', () => {
    const flags = setType(setProfile(setSegKind(setLod(0, 0b111), 0b111), 0b111), 0b11111);

    assert.strictEqual(readLod(flags), 0b11);
    assert.strictEqual(readProfile(flags), 0b11);
    assert.strictEqual(readSegKind(flags), 0b11);
    assert.strictEqual(readType(flags), 0b1111);
    // Nothing bled past the four windows: no state bit, reserved bit or neighbour.
    assert.strictEqual(flags, (0b11 << 20) | (0b11 << 12) | (0b11 << 14) | (0b1111 << 16));

    assert.strictEqual(readProfile(packInstanceFlags({ profile: INSTANCE_PROFILE_DISK })), INSTANCE_PROFILE_DISK);
    assert.strictEqual(readType(packInstanceFlags({ type: 0b11111 })), 0b1111);
  });

  it('stays an unsigned word, even with the sign bit already set', () => {
    const signed = 0x80000000 | 0;
    const flags = setInstanceFlag(signed, INSTANCE_FLAG_VISIBLE, true);

    assert.strictEqual(flags, 2147483649);
    assert.strictEqual(flags >>> 0, flags);
    assert.strictEqual(getInstanceFlag(flags, INSTANCE_FLAG_VISIBLE), true);
    assert.strictEqual(getInstanceFlag(signed, INSTANCE_FLAG_VISIBLE), false);
    assert.strictEqual(setInstanceFlag(0, INSTANCE_FLAG_GHOST, false), 0);
    assert.strictEqual(packInstanceFlags({ outOfBounds: true, hiddenInNav: true }), INSTANCE_FLAG_OUT_OF_BOUNDS | INSTANCE_FLAG_HIDDEN_IN_NAV);
  });
});

function assertBooleansUnchanged(flags: number): void {
  for (const [name, mask] of BITS) {
    assert.strictEqual(getInstanceFlag(flags, mask), true, `${String(name)} must survive an enum write`);
  }
}
