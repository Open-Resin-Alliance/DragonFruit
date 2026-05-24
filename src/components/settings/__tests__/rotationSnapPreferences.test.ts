import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ROTATION_SNAP_SETTINGS,
  ROTATION_SNAP_PRESETS,
  normalizeRotationSnapSettings,
  toSnapTickConfig,
  getRotationSnapIncrements,
  getRotationSnapPresetId,
  type RotationSnapSettings,
  type SnapTierRole,
} from "@/components/settings/rotationSnapPreferences";
import { getSnapTicks, SNAP_COARSE, SNAP_FINE } from "@/components/gizmo/rotate/snapRotation";

const degOf = (s: RotationSnapSettings, role: SnapTierRole): number => {
  const tier = s.tiers.find((t) => t.role === role);
  assert.ok(tier, `missing role ${role}`);
  return tier.degrees;
};

describe("normalizeRotationSnapSettings", () => {
  it("round-trips the default settings", () => {
    assert.deepEqual(
      normalizeRotationSnapSettings(DEFAULT_ROTATION_SNAP_SETTINGS),
      DEFAULT_ROTATION_SNAP_SETTINGS,
    );
  });

  it("falls back to default for null / non-object / malformed input", () => {
    assert.deepEqual(normalizeRotationSnapSettings(null), DEFAULT_ROTATION_SNAP_SETTINGS);
    assert.deepEqual(normalizeRotationSnapSettings("nope"), DEFAULT_ROTATION_SNAP_SETTINGS);
    assert.deepEqual(normalizeRotationSnapSettings({}), DEFAULT_ROTATION_SNAP_SETTINGS);
    assert.deepEqual(normalizeRotationSnapSettings({ tiers: [] }), DEFAULT_ROTATION_SNAP_SETTINGS);
  });

  it("accepts arbitrary whole-degree intervals (need not divide 360)", () => {
    const arbitrary = {
      tiers: [
        { degrees: 7, lengthMult: 1, role: "coarse" },
        { degrees: 13, lengthMult: 0.6, role: "fine" },
        { degrees: 2, lengthMult: 0.3, role: "visual" },
      ],
    };
    const n = normalizeRotationSnapSettings(arbitrary);
    assert.equal(degOf(n, "coarse"), 7);
    assert.equal(degOf(n, "fine"), 13);
    assert.equal(degOf(n, "visual"), 2);
  });

  it("rejects non-positive, non-integer, or out-of-range degrees", () => {
    const mk = (deg: unknown) => ({
      tiers: [
        { degrees: deg, lengthMult: 1, role: "coarse" },
        { degrees: 15, lengthMult: 0.6, role: "fine" },
        { degrees: 5, lengthMult: 0.3, role: "visual" },
      ],
    });
    for (const bad of [0, -5, 7.5, 361, Number.NaN]) {
      assert.deepEqual(
        normalizeRotationSnapSettings(mk(bad)),
        DEFAULT_ROTATION_SNAP_SETTINGS,
        `degrees=${String(bad)} should be rejected`,
      );
    }
  });

  it("rejects missing or duplicate roles", () => {
    const dup = {
      tiers: [
        { degrees: 45, lengthMult: 1, role: "coarse" },
        { degrees: 15, lengthMult: 0.6, role: "coarse" }, // duplicate role
        { degrees: 5, lengthMult: 0.3, role: "visual" },
      ],
    };
    assert.deepEqual(normalizeRotationSnapSettings(dup), DEFAULT_ROTATION_SNAP_SETTINGS);
  });

  it("derives lengthMult from role, ignoring any supplied lengthMult", () => {
    const weird = {
      tiers: [
        { degrees: 45, lengthMult: 99, role: "coarse" },
        { degrees: 15, lengthMult: 99, role: "fine" },
        { degrees: 5, lengthMult: 99, role: "visual" },
      ],
    };
    const n = normalizeRotationSnapSettings(weird);
    const lenOf = (role: SnapTierRole) => {
      const t = n.tiers.find((x) => x.role === role);
      assert.ok(t);
      return t.lengthMult;
    };
    assert.equal(lenOf("coarse"), 1.0);
    assert.equal(lenOf("fine"), 0.6);
    assert.equal(lenOf("visual"), 0.3);
  });

  it("ACCEPTS a non-nesting custom config (45/10/5) — Custom mode is intentionally free", () => {
    const nonNesting = {
      tiers: [
        { degrees: 45, lengthMult: 1, role: "coarse" },
        { degrees: 10, lengthMult: 0.6, role: "fine" }, // divides 360 but does not nest in 45
        { degrees: 5, lengthMult: 0.3, role: "visual" },
      ],
    };
    assert.equal(degOf(normalizeRotationSnapSettings(nonNesting), "fine"), 10);
  });
});

describe("rotation snap presets", () => {
  it("Standard preset equals the default (45/15/5)", () => {
    assert.deepEqual(ROTATION_SNAP_PRESETS.standard, DEFAULT_ROTATION_SNAP_SETTINGS);
  });

  it("every built-in preset is nesting-valid (visual | fine | coarse | 360) and normalizes unchanged", () => {
    for (const preset of Object.values(ROTATION_SNAP_PRESETS)) {
      assert.equal(360 % degOf(preset, "coarse"), 0);
      assert.equal(degOf(preset, "coarse") % degOf(preset, "fine"), 0);
      assert.equal(degOf(preset, "fine") % degOf(preset, "visual"), 0);
      assert.deepEqual(normalizeRotationSnapSettings(preset), preset);
    }
  });
});

describe("toSnapTickConfig + getSnapTicks integration", () => {
  it("maps roles to tick config (coarse->major, fine->medium, visual->minor)", () => {
    assert.deepEqual(toSnapTickConfig(ROTATION_SNAP_PRESETS.fine), {
      majorDeg: 15,
      mediumDeg: 5,
      minorDeg: 1,
    });
  });

  it("getSnapTicks(Fine 15/5/1) yields 360 ticks classified by the configured tiers", () => {
    const ticks = getSnapTicks(toSnapTickConfig(ROTATION_SNAP_PRESETS.fine));
    assert.equal(ticks.length, 360);
    const counts = ticks.reduce(
      (acc, t) => {
        acc[t.tier] += 1;
        return acc;
      },
      { major: 0, medium: 0, minor: 0 } as Record<string, number>,
    );
    // major = multiples of 15 (24); medium = multiples of 5 not 15 (48); minor = rest (288)
    assert.deepEqual(counts, { major: 24, medium: 48, minor: 288 });
  });
});

describe("getRotationSnapPresetId", () => {
  it("identifies the built-in presets", () => {
    assert.equal(getRotationSnapPresetId(ROTATION_SNAP_PRESETS.standard), "standard");
    assert.equal(getRotationSnapPresetId(ROTATION_SNAP_PRESETS.fine), "fine");
  });

  it("returns 'custom' for arbitrary configs", () => {
    const custom = normalizeRotationSnapSettings({
      tiers: [
        { degrees: 30, lengthMult: 1, role: "coarse" },
        { degrees: 10, lengthMult: 0.6, role: "fine" },
        { degrees: 2, lengthMult: 0.3, role: "visual" },
      ],
    });
    assert.equal(getRotationSnapPresetId(custom), "custom");
  });
});

describe("getRotationSnapIncrements", () => {
  it("default increments equal SNAP_COARSE / SNAP_FINE so #39 snapping cannot regress", () => {
    const inc = getRotationSnapIncrements(DEFAULT_ROTATION_SNAP_SETTINGS);
    assert.ok(Math.abs(inc.coarse - SNAP_COARSE) < 1e-12, `coarse ${inc.coarse}`);
    assert.ok(Math.abs(inc.fine - SNAP_FINE) < 1e-12, `fine ${inc.fine}`);
  });
});
