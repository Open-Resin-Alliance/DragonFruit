import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  snapAngle,
  SNAP_COARSE,
  SNAP_FINE,
  ringLocalAngle,
  spokeRingAngle,
  objectAngleForRingAngle,
  getRingTicks,
  getSpokeAngles,
  nearestRingTickRad,
  shortestAngleDelta,
  parseSnapDialConfig,
  DEFAULT_SNAP_DIAL_CONFIG,
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

  it("sends a ring angle to an object angle whose spoke lands back on it", () => {
    for (const flip of [1, -1]) {
      for (const tickDeg of [0, 45, 90, 175, 270, 355]) {
        const target = objectAngleForRingAngle(deg(tickDeg), flip);
        const landed = spokeRingAngle(target, flip);
        const gap = Math.abs(
          Math.atan2(Math.sin(landed - deg(tickDeg)), Math.cos(landed - deg(tickDeg))),
        );
        assert.ok(
          gap < 1e-9,
          `flip ${flip}: ${tickDeg}deg landed ${(landed * 180) / Math.PI}deg`,
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

// ─── Faithful dial model (dragonfruit-103-2) ────────────────────────────────

describe("getRingTicks", () => {
  it("produces one tick per short increment for the reference anatomy", () => {
    assert.equal(getRingTicks(DEFAULT_SNAP_DIAL_CONFIG).length, 72, "360 / 5");
  });

  it("classifies long ticks every 10 degrees and short elsewhere", () => {
    const ticks = getRingTicks(DEFAULT_SNAP_DIAL_CONFIG);
    assert.equal(ticks.filter((t) => t.tier === "long").length, 36, "360/10");
    assert.equal(ticks.filter((t) => t.tier === "short").length, 36);
    const byDeg = new Map(ticks.map((t) => [t.deg, t.tier]));
    assert.equal(byDeg.get(0), "long");
    assert.equal(byDeg.get(10), "long");
    assert.equal(byDeg.get(45), "short", "45 is NOT a ring tier in the faithful anatomy");
    assert.equal(byDeg.get(5), "short");
  });

  it("orders ascending from 0, stays below 360, keeps rad consistent", () => {
    const ticks = getRingTicks(DEFAULT_SNAP_DIAL_CONFIG);
    const degs = ticks.map((t) => t.deg);
    assert.deepEqual(degs, [...degs].sort((a, b) => a - b));
    assert.equal(degs[0], 0);
    assert.ok(degs[degs.length - 1] < 360);
    for (const t of ticks) {
      assert.ok(Math.abs(t.rad - (t.deg * Math.PI) / 180) < 1e-12);
    }
  });

  it("treats a zero long interval as that tier disabled", () => {
    const ticks = getRingTicks({ ringShortDeg: 5, ringLongDeg: 0, spokeDeg: 45 });
    assert.equal(ticks.length, 72);
    assert.equal(ticks.filter((t) => t.tier === "long").length, 0);
  });

  it("rejects a short increment that is non-positive or does not divide 360", () => {
    assert.throws(() => getRingTicks({ ringShortDeg: 0, ringLongDeg: 10, spokeDeg: 45 }));
    assert.throws(() => getRingTicks({ ringShortDeg: 7, ringLongDeg: 10, spokeDeg: 45 }));
  });
});

describe("getSpokeAngles", () => {
  it("produces 8 spokes at 45 degrees, ascending from 0", () => {
    const spokes = getSpokeAngles(DEFAULT_SNAP_DIAL_CONFIG);
    assert.equal(spokes.length, 8);
    spokes.forEach((rad, i) => {
      assert.ok(closeTo(rad, (i * 45 * Math.PI) / 180), `spoke ${i}`);
    });
  });

  it("is symmetric under negation, so the spoke set is flip-invariant", () => {
    const spokes = getSpokeAngles(DEFAULT_SNAP_DIAL_CONFIG);
    const norm = (r: number) => (((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    const set = spokes.map((r) => Math.round((norm(r) * 180) / Math.PI));
    for (const r of spokes) {
      const neg = Math.round((norm(-r) * 180) / Math.PI) % 360;
      assert.ok(set.includes(neg), `negated spoke ${neg} not in set`);
    }
  });

  it("treats zero spacing as disabled", () => {
    assert.deepEqual(getSpokeAngles({ ringShortDeg: 5, ringLongDeg: 10, spokeDeg: 0 }), []);
  });
});

describe("parseSnapDialConfig", () => {
  it("falls back to the default on empty, garbage, or malformed input", () => {
    assert.deepEqual(parseSnapDialConfig(null), DEFAULT_SNAP_DIAL_CONFIG);
    assert.deepEqual(parseSnapDialConfig("{not json"), DEFAULT_SNAP_DIAL_CONFIG);
    assert.deepEqual(parseSnapDialConfig("[]"), DEFAULT_SNAP_DIAL_CONFIG);
  });

  it("rejects the LEGACY persisted shape so stale configs reset cleanly", () => {
    assert.deepEqual(
      parseSnapDialConfig(JSON.stringify({ majorDeg: 45, mediumDeg: 15, minorDeg: 5 })),
      DEFAULT_SNAP_DIAL_CONFIG,
    );
  });

  it("accepts a well-formed config and rejects a non-divisor short step", () => {
    assert.deepEqual(
      parseSnapDialConfig(JSON.stringify({ ringShortDeg: 10, ringLongDeg: 30, spokeDeg: 90 })),
      { ringShortDeg: 10, ringLongDeg: 30, spokeDeg: 90 },
    );
    assert.deepEqual(
      parseSnapDialConfig(JSON.stringify({ ringShortDeg: 7, ringLongDeg: 10, spokeDeg: 45 })),
      DEFAULT_SNAP_DIAL_CONFIG,
    );
  });

  it("always returns a config getRingTicks can consume", () => {
    for (const raw of [null, "{}", "garbage", JSON.stringify({ ringShortDeg: 7 })]) {
      assert.doesNotThrow(() => getRingTicks(parseSnapDialConfig(raw)));
    }
  });
});

describe("nearestRingTickRad", () => {
  it("returns the tick itself when already on one and snaps to the nearer neighbour", () => {
    assert.ok(closeTo(nearestRingTickRad(deg(45)), deg(45)));
    assert.ok(closeTo(nearestRingTickRad(deg(2)), deg(0)));
    assert.ok(closeTo(nearestRingTickRad(deg(3)), deg(5)));
  });

  it("wraps forward past the last tick and normalises negatives", () => {
    assert.ok(closeTo(nearestRingTickRad(deg(358)), deg(0)));
    assert.ok(closeTo(nearestRingTickRad(deg(-3)), deg(355)));
  });

  it("always lands on a member of the ring tick set", () => {
    const tickDegs = new Set(getRingTicks(DEFAULT_SNAP_DIAL_CONFIG).map((t) => t.deg));
    for (let d = -720; d <= 720; d += 7) {
      const landedDeg = Math.round((nearestRingTickRad(deg(d)) * 180) / Math.PI) % 360;
      assert.ok(tickDegs.has(landedDeg), `${d}deg landed off-set at ${landedDeg}`);
    }
  });
});

describe("shortestAngleDelta", () => {
  it("takes the short way across the wrap boundary, signed by direction", () => {
    assert.ok(closeTo(shortestAngleDelta(deg(350), deg(10)), deg(20)));
    assert.ok(closeTo(shortestAngleDelta(deg(10), deg(350)), deg(-20)));
    assert.equal(shortestAngleDelta(deg(30), deg(30)), 0);
  });

  it("never exceeds half a revolution", () => {
    for (let a = -360; a <= 360; a += 13) {
      for (let b = -360; b <= 360; b += 29) {
        assert.ok(Math.abs(shortestAngleDelta(deg(a), deg(b))) <= Math.PI + 1e-9);
      }
    }
  });
});
