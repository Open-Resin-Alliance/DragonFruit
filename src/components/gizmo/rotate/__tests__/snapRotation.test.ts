import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  snapAngle,
  SNAP_COARSE,
  SNAP_FINE,
  getSnapTicks,
  ringLocalAngle,
  nearestTickRad,
  shortestAngleDelta,
  spokeRingAngle,
  objectAngleForRingAngle,
  parseSnapTickConfig,
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

  it("treats a zero major interval as that tier being disabled", () => {
    const ticks = getSnapTicks({ majorDeg: 0, mediumDeg: 15, minorDeg: 5 });
    assert.equal(ticks.length, 72);
    assert.equal(ticks.filter((t) => t.tier === "major").length, 0);
    // The positions that would have been major fall back to medium.
    assert.equal(ticks.find((t) => t.deg === 45)?.tier, "medium");
  });

  it("treats a zero medium interval as that tier being disabled", () => {
    const ticks = getSnapTicks({ majorDeg: 45, mediumDeg: 0, minorDeg: 5 });
    assert.equal(ticks.filter((t) => t.tier === "medium").length, 0);
    assert.equal(ticks.find((t) => t.deg === 45)?.tier, "major");
    assert.equal(ticks.find((t) => t.deg === 15)?.tier, "minor");
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

  it("collapses negative zero so a flipped 0 stays Object.is-equal to 0", () => {
    // -0 would not compare equal under Object.is, which node:assert/strict uses.
    assert.equal(ringLocalAngle(0, -1), 0);
    assert.ok(!Object.is(ringLocalAngle(0, -1), -0));
  });

  it("round-trips through a flip back to the original angle", () => {
    const angle = (37 * Math.PI) / 180;
    assert.ok(
      Math.abs(ringLocalAngle(ringLocalAngle(angle, -1), -1) - angle) < 1e-12,
    );
  });
});

const deg = (d: number) => (d * Math.PI) / 180;
const closeTo = (actual: number, expected: number, tol = 1e-9) =>
  Math.abs(actual - expected) < tol;

describe("nearestTickRad", () => {
  it("returns the tick itself when the angle is already on one", () => {
    assert.ok(closeTo(nearestTickRad(deg(0), DEFAULT_SNAP_TICK_CONFIG), deg(0)));
    assert.ok(closeTo(nearestTickRad(deg(45), DEFAULT_SNAP_TICK_CONFIG), deg(45)));
  });

  it("snaps to the nearer neighbour", () => {
    assert.ok(closeTo(nearestTickRad(deg(2), DEFAULT_SNAP_TICK_CONFIG), deg(0)));
    assert.ok(closeTo(nearestTickRad(deg(3), DEFAULT_SNAP_TICK_CONFIG), deg(5)));
    assert.ok(closeTo(nearestTickRad(deg(47), DEFAULT_SNAP_TICK_CONFIG), deg(45)));
  });

  it("wraps forward past the last tick rather than snapping backwards", () => {
    // 358 is nearer to 360 (= 0) than to 355.
    assert.ok(closeTo(nearestTickRad(deg(358), DEFAULT_SNAP_TICK_CONFIG), deg(0)));
  });

  it("normalises negative angles into one revolution", () => {
    assert.ok(closeTo(nearestTickRad(deg(-3), DEFAULT_SNAP_TICK_CONFIG), deg(355)));
    assert.ok(closeTo(nearestTickRad(deg(-2), DEFAULT_SNAP_TICK_CONFIG), deg(0)));
  });

  it("always lands on a real tick from the same set", () => {
    const tickDegrees = new Set(
      getSnapTicks(DEFAULT_SNAP_TICK_CONFIG).map((t) => t.deg),
    );
    for (let d = -720; d <= 720; d += 7) {
      const landed = nearestTickRad(deg(d), DEFAULT_SNAP_TICK_CONFIG);
      const landedDeg = Math.round((landed * 180) / Math.PI) % 360;
      assert.ok(
        tickDegrees.has(landedDeg),
        `input ${d}deg landed on ${landedDeg}deg, which is not a tick`,
      );
    }
  });
});

describe("shortestAngleDelta", () => {
  it("is zero between identical angles", () => {
    assert.equal(shortestAngleDelta(deg(30), deg(30)), 0);
  });

  it("takes the short way across the wrap boundary", () => {
    // 350 -> 10 is +20, not -340.
    assert.ok(closeTo(shortestAngleDelta(deg(350), deg(10)), deg(20)));
    assert.ok(closeTo(shortestAngleDelta(deg(10), deg(350)), deg(-20)));
  });

  it("is signed by direction", () => {
    assert.ok(shortestAngleDelta(deg(0), deg(90)) > 0);
    assert.ok(shortestAngleDelta(deg(90), deg(0)) < 0);
  });

  it("never exceeds half a revolution", () => {
    for (let a = -360; a <= 360; a += 13) {
      for (let b = -360; b <= 360; b += 29) {
        const d = shortestAngleDelta(deg(a), deg(b));
        assert.ok(
          Math.abs(d) <= Math.PI + 1e-9,
          `${a} -> ${b} produced ${d}, longer than half a revolution`,
        );
      }
    }
  });
});

describe("spokeRingAngle / objectAngleForRingAngle", () => {
  it("round-trips an object angle through the ring frame and back", () => {
    for (const flip of [1, -1]) {
      for (let d = -350; d <= 350; d += 17) {
        const object = deg(d);
        const ring = spokeRingAngle(object, flip);
        const back = objectAngleForRingAngle(ring, flip);
        assert.ok(
          closeTo(back, object, 1e-12),
          `flip ${flip}, ${d}deg round-tripped to ${(back * 180) / Math.PI}deg`,
        );
      }
    }
  });

  it("follows the object's rotation direction", () => {
    // A positive object rotation moves the spoke positively in the ring frame.
    // Ground truth for this lives in the registration suite, which rotates a
    // point with THREE and measures where it lands. Do NOT borrow the drag
    // path's -1 axisSign here: that compensates for the model applying an
    // emitted delta with the opposite sign, and currentAngleRad is already an
    // actual rotation, so applying it again mirrors the dial.
    assert.ok(spokeRingAngle(deg(30), 1) > 0);
    assert.ok(spokeRingAngle(deg(30), -1) < 0);
  });

  it("sends a clicked tick to an object angle that lands back on that tick", () => {
    for (const flip of [1, -1]) {
      for (const tickDeg of [0, 45, 90, 175, 270, 355]) {
        const target = objectAngleForRingAngle(deg(tickDeg), flip);
        const landed = nearestTickRad(spokeRingAngle(target, flip));
        assert.ok(
          closeTo(landed, deg(tickDeg), 1e-9),
          `flip ${flip}: clicking ${tickDeg}deg landed on ${(landed * 180) / Math.PI}deg`,
        );
      }
    }
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

describe("parseSnapTickConfig", () => {
  it("falls back to the default when nothing is stored", () => {
    assert.deepEqual(parseSnapTickConfig(null), DEFAULT_SNAP_TICK_CONFIG);
    assert.deepEqual(parseSnapTickConfig(""), DEFAULT_SNAP_TICK_CONFIG);
  });

  it("falls back rather than throwing on malformed json", () => {
    // A corrupt value must not brick the gizmo on load.
    assert.deepEqual(parseSnapTickConfig("{not json"), DEFAULT_SNAP_TICK_CONFIG);
    assert.deepEqual(parseSnapTickConfig("[]"), DEFAULT_SNAP_TICK_CONFIG);
    assert.deepEqual(parseSnapTickConfig("null"), DEFAULT_SNAP_TICK_CONFIG);
  });

  it("accepts a well-formed config", () => {
    assert.deepEqual(
      parseSnapTickConfig(
        JSON.stringify({ majorDeg: 90, mediumDeg: 30, minorDeg: 10 }),
      ),
      { majorDeg: 90, mediumDeg: 30, minorDeg: 10 },
    );
  });

  it("rejects a minor increment that getSnapTicks would throw on", () => {
    // 7 does not divide 360. Storing it would make every ring throw on render.
    assert.deepEqual(
      parseSnapTickConfig(
        JSON.stringify({ majorDeg: 45, mediumDeg: 15, minorDeg: 7 }),
      ),
      DEFAULT_SNAP_TICK_CONFIG,
    );
    assert.deepEqual(
      parseSnapTickConfig(
        JSON.stringify({ majorDeg: 45, mediumDeg: 15, minorDeg: 0 }),
      ),
      DEFAULT_SNAP_TICK_CONFIG,
    );
  });

  it("rejects non-numeric or missing fields", () => {
    assert.deepEqual(
      parseSnapTickConfig(JSON.stringify({ majorDeg: "45", mediumDeg: 15, minorDeg: 5 })),
      DEFAULT_SNAP_TICK_CONFIG,
    );
    assert.deepEqual(
      parseSnapTickConfig(JSON.stringify({ majorDeg: 45 })),
      DEFAULT_SNAP_TICK_CONFIG,
    );
  });

  it("always returns a config getSnapTicks can consume", () => {
    for (const raw of [null, "{}", "garbage", JSON.stringify({ minorDeg: 7 })]) {
      assert.doesNotThrow(() => getSnapTicks(parseSnapTickConfig(raw)));
    }
  });
});
