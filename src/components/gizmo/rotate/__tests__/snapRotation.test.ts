import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  snapAngle,
  SNAP_COARSE,
  SNAP_FINE,
  getSnapTicks,
  ringLocalAngle,
  DEFAULT_SNAP_TICK_CONFIG,
  type SnapTickConfig,
} from "../snapRotation";

describe("snapAngle", () => {
  it("snaps 0 to 0", () => {
    assert.equal(snapAngle(0, SNAP_COARSE), 0);
  });

  it("snaps below midpoint to lower increment (PI/9 → 0 for 45° grid)", () => {
    // PI/9 ≈ 20° < 22.5° midpoint → rounds down to 0
    assert.equal(snapAngle(Math.PI / 9, SNAP_COARSE), 0);
  });

  it("snaps above midpoint to upper increment (PI/3 → PI/4 for 45° grid)", () => {
    // PI/3 ≈ 60° > 22.5° midpoint → rounds up to PI/4 (45°)
    assert.equal(snapAngle(Math.PI / 3, SNAP_COARSE), Math.PI / 4);
  });

  it("snaps negative angles correctly (-PI/3 → -PI/4 for 45° grid)", () => {
    assert.equal(snapAngle(-Math.PI / 3, SNAP_COARSE), -Math.PI / 4);
  });

  it("snaps full rotation (2*PI → 2*PI for 45° grid)", () => {
    const result = snapAngle(2 * Math.PI, SNAP_COARSE);
    assert.ok(
      Math.abs(result - 2 * Math.PI) < 1e-10,
      `Expected ~2*PI, got ${result}`,
    );
  });

  it("snaps PI exactly for fine grid (PI/12)", () => {
    const result = snapAngle(Math.PI, SNAP_FINE);
    assert.ok(
      Math.abs(result - Math.PI) < 1e-10,
      `Expected ~PI, got ${result}`,
    );
  });

  it("snaps to fine grid increments (PI/6 → PI/6 for 15° grid)", () => {
    const result = snapAngle(Math.PI / 6, SNAP_FINE);
    assert.ok(
      Math.abs(result - Math.PI / 6) < 1e-10,
      `Expected ~PI/6, got ${result}`,
    );
  });
});

describe("snap constants", () => {
  it("SNAP_COARSE is 45 degrees in radians", () => {
    assert.ok(
      Math.abs(SNAP_COARSE - Math.PI / 4) < 1e-10,
      `Expected PI/4, got ${SNAP_COARSE}`,
    );
  });

  it("SNAP_FINE is 15 degrees in radians", () => {
    assert.ok(
      Math.abs(SNAP_FINE - Math.PI / 12) < 1e-10,
      `Expected PI/12, got ${SNAP_FINE}`,
    );
  });
});

describe("getSnapTicks", () => {
  it("produces one tick per minor increment around the full circle", () => {
    const ticks = getSnapTicks(DEFAULT_SNAP_TICK_CONFIG);
    assert.equal(ticks.length, 72, "360 / 5 = 72 ticks for the default config");
  });

  it("emits each degree exactly once, so overlapping tiers do not duplicate", () => {
    const ticks = getSnapTicks(DEFAULT_SNAP_TICK_CONFIG);
    const degrees = ticks.map((t) => t.deg);
    assert.equal(
      new Set(degrees).size,
      degrees.length,
      "0, 45, 90... are multiples of all three tiers and must not be emitted per-tier",
    );
  });

  it("orders ticks ascending from 0 and stays below 360", () => {
    const ticks = getSnapTicks(DEFAULT_SNAP_TICK_CONFIG);
    const degrees = ticks.map((t) => t.deg);
    assert.deepEqual(degrees, [...degrees].sort((a, b) => a - b));
    assert.equal(degrees[0], 0);
    assert.ok(degrees[degrees.length - 1] < 360, "360 duplicates 0");
  });

  it("classifies a degree by its largest matching tier", () => {
    const byDeg = new Map(
      getSnapTicks(DEFAULT_SNAP_TICK_CONFIG).map((t) => [t.deg, t.tier]),
    );
    // 45 is a multiple of 45, 15 and 5 — the largest tier wins.
    assert.equal(byDeg.get(0), "major");
    assert.equal(byDeg.get(45), "major");
    assert.equal(byDeg.get(90), "major");
    assert.equal(byDeg.get(15), "medium");
    assert.equal(byDeg.get(30), "medium");
    assert.equal(byDeg.get(5), "minor");
    assert.equal(byDeg.get(10), "minor");
  });

  it("splits the default tiers 8 major / 16 medium / 48 minor", () => {
    const ticks = getSnapTicks(DEFAULT_SNAP_TICK_CONFIG);
    const count = (tier: string) => ticks.filter((t) => t.tier === tier).length;
    assert.equal(count("major"), 8, "360/45");
    assert.equal(count("medium"), 16, "360/15 minus the 8 that are also major");
    assert.equal(count("minor"), 48, "360/5 minus the 24 that are 15-multiples");
  });

  it("keeps rad consistent with deg", () => {
    for (const tick of getSnapTicks(DEFAULT_SNAP_TICK_CONFIG)) {
      assert.ok(
        Math.abs(tick.rad - (tick.deg * Math.PI) / 180) < 1e-12,
        `rad/deg mismatch at ${tick.deg}`,
      );
    }
  });

  it("honours a custom tier config", () => {
    const config: SnapTickConfig = { majorDeg: 90, mediumDeg: 30, minorDeg: 10 };
    const ticks = getSnapTicks(config);
    assert.equal(ticks.length, 36, "360 / 10");
    const byDeg = new Map(ticks.map((t) => [t.deg, t.tier]));
    assert.equal(byDeg.get(90), "major");
    assert.equal(byDeg.get(30), "medium");
    assert.equal(byDeg.get(10), "minor");
    assert.equal(byDeg.get(45), undefined, "45 is not a multiple of 10");
  });

  it("rejects a non-positive minor increment rather than looping forever", () => {
    assert.throws(() =>
      getSnapTicks({ majorDeg: 45, mediumDeg: 15, minorDeg: 0 }),
    );
    assert.throws(() =>
      getSnapTicks({ majorDeg: 45, mediumDeg: 15, minorDeg: -5 }),
    );
  });

  it("rejects a minor increment that does not divide 360", () => {
    // 7 would leave an uneven gap between the last tick and 0.
    assert.throws(() =>
      getSnapTicks({ majorDeg: 45, mediumDeg: 15, minorDeg: 7 }),
    );
  });
});

describe("ringLocalAngle", () => {
  it("passes the object angle through when the axis is not flipped", () => {
    assert.equal(ringLocalAngle(Math.PI / 4, 1), Math.PI / 4);
    assert.equal(ringLocalAngle(-Math.PI / 3, 1), -Math.PI / 3);
    assert.equal(ringLocalAngle(0, 1), 0);
  });

  it("negates the object angle when the axis is flipped", () => {
    // HolePunchGizmo passes axisVisualFlip={{ y: -1 }} because displayY = -cutterY.
    // Without this the dial mirrors and clicking +45 rotates -45.
    assert.equal(ringLocalAngle(Math.PI / 4, -1), -Math.PI / 4);
    assert.equal(ringLocalAngle(-Math.PI / 3, -1), Math.PI / 3);
  });

  it("round-trips through a flip back to the original angle", () => {
    const angle = (37 * Math.PI) / 180;
    assert.ok(
      Math.abs(ringLocalAngle(ringLocalAngle(angle, -1), -1) - angle) < 1e-12,
    );
  });
});

describe("transition tolerance", () => {
  it("coarse-to-fine transition from aligned position produces no jump", () => {
    // lastSnapped = PI/4 (45°), rawAccumulated resets to PI/4
    // snapAngle(PI/4, SNAP_FINE) should equal PI/4 (since PI/4 = 3*PI/12)
    const lastSnapped = Math.PI / 4;
    const result = snapAngle(lastSnapped, SNAP_FINE);
    assert.ok(
      Math.abs(result - lastSnapped) < 1e-10,
      `Expected no jump, got delta ${result - lastSnapped}`,
    );
  });

  it("transition quantization error is within half-increment", () => {
    // Worst case: value exactly at midpoint between two fine grid lines
    const halfFine = SNAP_FINE / 2;
    const testAngle = SNAP_FINE * 2.5; // exactly between 2*SNAP_FINE and 3*SNAP_FINE
    const result = snapAngle(testAngle, SNAP_FINE);
    const error = Math.abs(result - testAngle);
    assert.ok(
      error <= halfFine + 1e-10,
      `Quantization error ${error} exceeds half-increment ${halfFine}`,
    );
  });
});
