import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DIAL_ANATOMY,
  DIAL_STEP_DEG,
  MAGNET_ENTER_PX,
  MAGNET_EXIT_PX,
  bandHoldsTier,
  dialSnapCandidate,
  distancePointToLine,
  emittedDeltaForSweep,
  formatSweepDegrees,
  getDialMarks,
  magnetBandForRadius,
  markRadiiForTier,
  polarToLocal,
  rayToRingLocal,
  resolveDialAngle,
  ringGroupEuler,
  shortestAngleDelta,
  stepDialSweep,
  wrapAngle,
  type DialSweep,
  type DialMarkTier,
  type DialSnapTarget,
} from "../rotationDialModel";
import type { GizmoAxis } from "../../types";

const deg = (d: number) => (d * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const closeTo = (actual: number, expected: number, tol = 1e-9) =>
  Math.abs(actual - expected) < tol;

/** A gap function that reports a fixed distance for every mark. */
const gapAlways = (px: number) => () => px;

describe("wrapAngle / shortestAngleDelta", () => {
  it("wraps into (-PI, PI]", () => {
    assert.ok(closeTo(wrapAngle(deg(370)), deg(10)));
    assert.ok(closeTo(wrapAngle(deg(-370)), deg(-10)));
    assert.ok(closeTo(wrapAngle(deg(190)), deg(-170)));
    assert.ok(closeTo(wrapAngle(deg(0)), 0));
  });

  it("never yields negative zero, which would break strict equality downstream", () => {
    assert.ok(!Object.is(wrapAngle(-0), -0));
    assert.equal(wrapAngle(-0), 0);
  });

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

  it("accumulates a full turn when summed over samples, so multi-turn drags keep counting", () => {
    // This is the invariant the drag relies on: the pointer angle is absolute and
    // wrapped, but summing shortest deltas between consecutive samples recovers
    // an unwrapped sweep — including across the +/-180 boundary.
    let previous = 0;
    let accumulated = 0;
    for (let d = 10; d <= 720; d += 10) {
      const sample = wrapAngle(deg(d));
      accumulated += shortestAngleDelta(previous, sample);
      previous = sample;
    }
    assert.ok(closeTo(accumulated, deg(720), 1e-9), `accumulated ${toDeg(accumulated)}deg`);
  });
});

describe("formatSweepDegrees", () => {
  it("signs the sweep and gives two decimals", () => {
    assert.equal(formatSweepDegrees(deg(10)), "+10.00");
    assert.equal(formatSweepDegrees(deg(-10)), "-10.00");
    assert.equal(formatSweepDegrees(deg(47.3)), "+47.30");
    assert.equal(formatSweepDegrees(deg(-3.456)), "-3.46");
  });

  it("never shows a signed zero", () => {
    assert.equal(formatSweepDegrees(0), "0.00");
    assert.equal(formatSweepDegrees(-0), "0.00");
    assert.equal(formatSweepDegrees(deg(-0.001)), "0.00");
  });

  it("NEVER reports an angle beyond one turn, however far the drag went", () => {
    // The regression: the drag accumulates the sweep unwrapped so the handle can
    // keep turning past 180 and across several revolutions. Reporting that raw
    // accumulator printed 540 for a turn and a half, which no other angle in the
    // app does. Every readout has to land inside one turn, like the Transform
    // panel's fields.
    assert.equal(formatSweepDegrees(deg(370)), "+10.00");
    assert.equal(formatSweepDegrees(deg(-370)), "-10.00");
    assert.equal(formatSweepDegrees(deg(540)), "+180.00");
    assert.equal(formatSweepDegrees(deg(720)), "0.00");
    assert.equal(formatSweepDegrees(deg(1085)), "+5.00");
    assert.equal(formatSweepDegrees(deg(200)), "-160.00", "wraps the short way, like the panel");

    for (let d = -2000; d <= 2000; d += 7) {
      const shown = Number(formatSweepDegrees(deg(d)));
      assert.ok(
        Math.abs(shown) <= 180,
        `${d}deg was reported as ${shown}, outside one turn`,
      );
    }
  });

  it("survives a non-finite sweep instead of printing NaN at the cursor", () => {
    assert.equal(formatSweepDegrees(Number.NaN), "0.00");
    assert.equal(formatSweepDegrees(Number.POSITIVE_INFINITY), "0.00");
  });
});

describe("getDialMarks", () => {
  const marks = getDialMarks();

  it("draws 72 rim marks and 8 spokes for the fixed 5/10/45 anatomy", () => {
    assert.equal(DIAL_STEP_DEG.short, 5);
    assert.equal(DIAL_STEP_DEG.long, 10);
    assert.equal(DIAL_STEP_DEG.spoke, 45);
    assert.equal(marks.filter((m) => m.tier === "long").length, 36, "360/10");
    assert.equal(marks.filter((m) => m.tier === "short").length, 36, "72 - 36");
    assert.equal(marks.filter((m) => m.tier === "spoke").length, 8, "360/45");
  });

  it("keeps degrees in [0,360) with rad agreeing with deg", () => {
    for (const mark of marks) {
      assert.ok(mark.deg >= 0 && mark.deg < 360, `deg out of range: ${mark.deg}`);
      assert.ok(closeTo(mark.rad, deg(mark.deg)), `rad mismatch at ${mark.deg}`);
    }
  });

  it("draws every rim mark inward from the axis ring, long ones reaching further in", () => {
    for (const mark of marks) {
      if (mark.tier === "spoke") continue;
      assert.equal(mark.outerRadius, DIAL_ANATOMY.rimRadius, "rim marks end on the ring");
      assert.ok(mark.innerRadius < mark.outerRadius, "marks grow inward");
    }
    assert.ok(
      DIAL_ANATOMY.longTickInnerRadius < DIAL_ANATOMY.shortTickInnerRadius,
      "a long mark must reach further in than a short one",
    );
  });

  it("keeps the spokes in their own corona, clear of the centre and of the rim marks", () => {
    const spokes = marks.filter((m) => m.tier === "spoke");
    for (const spoke of spokes) {
      assert.equal(spoke.innerRadius, DIAL_ANATOMY.spokeInnerRadius);
      assert.equal(spoke.outerRadius, DIAL_ANATOMY.spokeOuterRadius);
    }
    assert.ok(DIAL_ANATOMY.spokeInnerRadius > 0, "spokes do not reach the centre");
    assert.ok(
      DIAL_ANATOMY.spokeOuterRadius < DIAL_ANATOMY.longTickInnerRadius,
      "a corona without a magnet has to separate the spokes from the rim marks",
    );
  });

  it("draws a multiple of 45 twice: a rim mark and a spoke", () => {
    const at45 = marks.filter((m) => m.deg === 45);
    assert.deepEqual(at45.map((m) => m.tier).sort(), ["short", "spoke"], "45 is not a multiple of 10");
    const at90 = marks.filter((m) => m.deg === 90);
    assert.deepEqual(at90.map((m) => m.tier).sort(), ["long", "spoke"]);
  });

  it("agrees with markRadiiForTier, the shared source used to highlight a held mark", () => {
    for (const mark of marks) {
      assert.deepEqual(markRadiiForTier(mark.tier), {
        innerRadius: mark.innerRadius,
        outerRadius: mark.outerRadius,
      });
    }
  });
});

describe("magnetBandForRadius", () => {
  const { spokeInnerRadius, spokeOuterRadius, longTickInnerRadius, rimRadius } = DIAL_ANATOMY;

  it("has no magnet from the centre out to the spokes", () => {
    assert.equal(magnetBandForRadius(0), "none");
    assert.equal(magnetBandForRadius(spokeInnerRadius - 0.01), "none");
  });

  it("holds the 45-degree spokes inside their corona", () => {
    assert.equal(magnetBandForRadius(spokeInnerRadius), "spokes");
    assert.equal(magnetBandForRadius((spokeInnerRadius + spokeOuterRadius) / 2), "spokes");
    assert.equal(magnetBandForRadius(spokeOuterRadius), "spokes");
  });

  it("has no magnet in the corona between the spokes and the rim marks", () => {
    // The demonstrated case: the pointer sits visually next to a spoke, out past
    // its end, and must rotate freely rather than being pulled onto it.
    assert.equal(magnetBandForRadius(spokeOuterRadius + 0.01), "none");
    assert.equal(magnetBandForRadius((spokeOuterRadius + longTickInnerRadius) / 2), "none");
    assert.equal(magnetBandForRadius(longTickInnerRadius - 0.01), "none");
  });

  it("holds the 5- and 10-degree marks from the start of the long ones out to the ring", () => {
    assert.equal(magnetBandForRadius(longTickInnerRadius), "rim");
    assert.equal(magnetBandForRadius(DIAL_ANATOMY.shortTickInnerRadius), "rim");
    assert.equal(magnetBandForRadius(rimRadius), "rim");
  });

  it("stops magnetising past the ring", () => {
    assert.equal(magnetBandForRadius(rimRadius + 0.01), "none");
    assert.equal(magnetBandForRadius(rimRadius * 3), "none");
  });

  it("maps each band to the tiers it holds", () => {
    assert.ok(bandHoldsTier("spokes", "spoke"));
    assert.ok(!bandHoldsTier("spokes", "long"));
    assert.ok(bandHoldsTier("rim", "long"));
    assert.ok(bandHoldsTier("rim", "short"));
    assert.ok(!bandHoldsTier("rim", "spoke"));
    for (const tier of ["spoke", "long", "short"] as DialMarkTier[]) {
      assert.ok(!bandHoldsTier("none", tier), `none must hold nothing, held ${tier}`);
    }
  });
});

describe("dialSnapCandidate", () => {
  const rim = DIAL_ANATOMY.rimRadius;
  const spokes = (DIAL_ANATOMY.spokeInnerRadius + DIAL_ANATOMY.spokeOuterRadius) / 2;
  const noMagnet = (DIAL_ANATOMY.spokeOuterRadius + DIAL_ANATOMY.longTickInnerRadius) / 2;

  it("offers nothing in a corona without a magnet", () => {
    assert.equal(dialSnapCandidate(deg(45), noMagnet), null);
    assert.equal(dialSnapCandidate(deg(45), 0), null);
    assert.equal(dialSnapCandidate(deg(45), rim * 2), null);
  });

  it("quantises to 5 degrees on the rim and tags 10s as long", () => {
    assert.deepEqual(dialSnapCandidate(deg(4), rim), { angleRad: deg(5), tier: "short" });
    assert.deepEqual(dialSnapCandidate(deg(11), rim), { angleRad: deg(10), tier: "long" });
    assert.deepEqual(dialSnapCandidate(deg(0), rim), { angleRad: 0, tier: "long" });
  });

  it("quantises to 45 degrees among the spokes", () => {
    assert.deepEqual(dialSnapCandidate(deg(40), spokes), { angleRad: deg(45), tier: "spoke" });
    assert.deepEqual(dialSnapCandidate(deg(20), spokes), { angleRad: 0, tier: "spoke" });
    const back = dialSnapCandidate(deg(-50), spokes);
    assert.ok(back && closeTo(back.angleRad, deg(-45)), `got ${back && toDeg(back.angleRad)}`);
  });

  it("wraps around the boundary instead of proposing 360", () => {
    const nearZero = dialSnapCandidate(deg(359), rim);
    assert.ok(nearZero && closeTo(nearZero.angleRad, 0), `got ${nearZero && toDeg(nearZero.angleRad)}`);
    const negative = dialSnapCandidate(deg(-2), rim);
    assert.ok(negative && closeTo(negative.angleRad, 0), `got ${negative && toDeg(negative.angleRad)}`);
    // Negative angles round to the nearer mark like any other: -3 belongs to -5.
    const negativeTick = dialSnapCandidate(deg(-3), rim);
    assert.ok(negativeTick && closeTo(negativeTick.angleRad, deg(-5)));
    const past = dialSnapCandidate(deg(-179), rim);
    assert.ok(past && closeTo(Math.abs(toDeg(past.angleRad)), 180), `got ${past && toDeg(past.angleRad)}`);
  });

  it("only ever proposes an angle a mark is actually drawn at", () => {
    const drawnDegrees = new Set(getDialMarks().map((m) => m.deg));
    for (const radius of [rim, spokes]) {
      for (let d = -360; d <= 360; d += 3) {
        const candidate = dialSnapCandidate(deg(d), radius);
        assert.ok(candidate, `no candidate at ${d}deg`);
        const landed = ((Math.round(toDeg(candidate.angleRad)) % 360) + 360) % 360;
        assert.ok(drawnDegrees.has(landed), `${d}deg proposed ${landed}deg, which is not drawn`);
      }
    }
  });
});

describe("resolveDialAngle", () => {
  const rim = DIAL_ANATOMY.rimRadius;
  const spokes = (DIAL_ANATOMY.spokeInnerRadius + DIAL_ANATOMY.spokeOuterRadius) / 2;
  const noMagnet = (DIAL_ANATOMY.spokeOuterRadius + DIAL_ANATOMY.longTickInnerRadius) / 2;

  it("runs free when no mark is within reach, returning the pointer's own angle", () => {
    const cursor = deg(37.4);
    const result = resolveDialAngle({
      cursorAngleRad: cursor,
      cursorRadius: rim,
      gapPxForAngle: gapAlways(MAGNET_ENTER_PX + 1),
      held: null,
    });
    assert.equal(result.held, null);
    assert.equal(result.angleRad, cursor);
  });

  it("snaps the moving radius onto the nearest mark once inside the enter radius", () => {
    const result = resolveDialAngle({
      cursorAngleRad: deg(38.6),
      cursorRadius: rim,
      gapPxForAngle: gapAlways(MAGNET_ENTER_PX),
      held: null,
    });
    assert.deepEqual(result.held, { angleRad: deg(40), tier: "long" });
    assert.ok(closeTo(result.angleRad, deg(40)));
  });

  it("keeps a held mark past the enter radius and lets go past the exit radius", () => {
    const held: DialSnapTarget = { angleRad: deg(40), tier: "long" };
    const stillHeld = resolveDialAngle({
      cursorAngleRad: deg(42),
      cursorRadius: rim,
      gapPxForAngle: gapAlways(14),
      held,
      enterPx: 8,
      exitPx: 16,
    });
    assert.deepEqual(stillHeld.held, held, "14px is past enter (8) but inside exit (16)");
    assert.ok(closeTo(stillHeld.angleRad, deg(40)));

    const released = resolveDialAngle({
      cursorAngleRad: deg(42),
      cursorRadius: rim,
      gapPxForAngle: gapAlways(17),
      held,
      enterPx: 8,
      exitPx: 16,
    });
    assert.equal(released.held, null);
    assert.ok(closeTo(released.angleRad, deg(42)), "released back onto the pointer");
  });

  it("falls back to the shipped radii, and ships them symmetric", () => {
    // Pins the contract, not the tuning: the resolver's defaults must BE the
    // exported constants, so the feel is tuned in one place. The shipped feel is
    // symmetric for now; the two constants exist so the release radius can be
    // widened later without touching the resolver.
    assert.equal(MAGNET_ENTER_PX, MAGNET_EXIT_PX);
    const held: DialSnapTarget = { angleRad: 0, tier: "long" };
    assert.deepEqual(
      resolveDialAngle({
        cursorAngleRad: deg(3),
        cursorRadius: rim,
        gapPxForAngle: gapAlways(MAGNET_ENTER_PX - 0.5),
        held: null,
      }).held,
      { angleRad: deg(5), tier: "short" },
      "just inside the shipped enter radius must capture the nearest mark",
    );
    assert.equal(
      resolveDialAngle({
        cursorAngleRad: deg(3),
        cursorRadius: rim,
        gapPxForAngle: gapAlways(MAGNET_EXIT_PX + 0.5),
        held,
      }).held,
      null,
      "just outside the shipped exit radius must release",
    );
  });

  it("releases the moment the pointer leaves the corona, however close the mark", () => {
    const held: DialSnapTarget = { angleRad: 0, tier: "spoke" };
    const result = resolveDialAngle({
      cursorAngleRad: deg(0.2),
      cursorRadius: noMagnet,
      gapPxForAngle: gapAlways(0),
      held,
    });
    assert.equal(result.held, null, "a zero-pixel gap must not hold outside a magnet corona");
    assert.ok(closeTo(result.angleRad, deg(0.2)));
  });

  it("never captures anything in a corona without a magnet, however close the pointer is", () => {
    for (const radius of [0, DIAL_ANATOMY.spokeInnerRadius - 0.05, noMagnet, rim + 0.5]) {
      const result = resolveDialAngle({
        cursorAngleRad: deg(45.1),
        cursorRadius: radius,
        gapPxForAngle: gapAlways(0),
        held: null,
      });
      assert.equal(result.held, null, `captured at radius ${radius}`);
      assert.ok(closeTo(result.angleRad, deg(45.1)));
    }
  });

  it("hands a held spoke over to the rim marks when the pointer moves out to the ring", () => {
    // Tier and corona are checked together: a spoke cannot keep the radius while
    // the pointer is out among the rim marks, even if the spoke's line is close.
    const held: DialSnapTarget = { angleRad: 0, tier: "spoke" };
    const result = resolveDialAngle({
      cursorAngleRad: deg(4.4),
      cursorRadius: rim,
      gapPxForAngle: gapAlways(2),
      held,
    });
    assert.deepEqual(result.held, { angleRad: deg(5), tier: "short" });
  });

  it("holds 45s among the spokes and 5s on the rim, from the same pointer angle", () => {
    const cursorAngleRad = deg(41);
    const onSpokes = resolveDialAngle({
      cursorAngleRad,
      cursorRadius: spokes,
      gapPxForAngle: gapAlways(1),
      held: null,
    });
    assert.deepEqual(onSpokes.held, { angleRad: deg(45), tier: "spoke" });

    const onRim = resolveDialAngle({
      cursorAngleRad,
      cursorRadius: rim,
      gapPxForAngle: gapAlways(1),
      held: null,
    });
    assert.deepEqual(onRim.held, { angleRad: deg(40), tier: "long" });
  });

  it("measures the gap against the candidate, not against the pointer's own angle", () => {
    // The resolver must ask for the gap of the mark it is considering; a stub that
    // only answers for 40 degrees proves it never asked about anything else.
    const asked: number[] = [];
    const result = resolveDialAngle({
      cursorAngleRad: deg(38.6),
      cursorRadius: rim,
      gapPxForAngle: (markAngleRad) => {
        asked.push(Math.round(toDeg(markAngleRad)));
        return 1;
      },
      held: null,
    });
    assert.deepEqual(asked, [40]);
    assert.ok(closeTo(result.angleRad, deg(40)));
  });
});

describe("distancePointToLine", () => {
  it("measures the perpendicular distance to the infinite line", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    assert.ok(closeTo(distancePointToLine({ x: 5, y: 3 }, a, b), 3));
    // Past the end of the segment: still 3, because the corona gate — not the
    // segment's ends — decides whether the mark is in play.
    assert.ok(closeTo(distancePointToLine({ x: 40, y: 3 }, a, b), 3));
    assert.ok(closeTo(distancePointToLine({ x: 5, y: 0 }, a, b), 0));
  });

  it("is sign-agnostic, so either side of a mark reads the same distance", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 10 };
    assert.ok(closeTo(distancePointToLine({ x: 4, y: 2 }, a, b), 4));
    assert.ok(closeTo(distancePointToLine({ x: -4, y: 2 }, a, b), 4));
  });

  it("falls back to a point distance when the line degenerates", () => {
    const a = { x: 3, y: 4 };
    assert.ok(closeTo(distancePointToLine({ x: 0, y: 0 }, a, a), 5));
  });
});

describe("ringGroupEuler", () => {
  it("puts the ring's local +Z on that ring's world axis", () => {
    const expected: Record<GizmoAxis, THREE.Vector3> = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...ringGroupEuler(axis)));
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
      assert.ok(
        normal.distanceTo(expected[axis]) < 1e-9,
        `${axis} ring normal landed at ${normal.toArray().join(",")}`,
      );
    }
  });
});

describe("rayToRingLocal", () => {
  const identity = new THREE.Matrix4();
  const ringMatrix = (axis: GizmoAxis, scale = 1, centre = new THREE.Vector3()) =>
    new THREE.Matrix4().compose(
      centre,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...ringGroupEuler(axis))),
      new THREE.Vector3(scale, scale, scale),
    );

  it("returns ring-local polar coordinates of the hit", () => {
    const hit = rayToRingLocal(
      new THREE.Vector3(3, 0, 5),
      new THREE.Vector3(0, 0, -1),
      identity,
    );
    assert.ok(hit);
    assert.ok(closeTo(hit.radius, 3), `radius ${hit.radius}`);
    assert.ok(closeTo(hit.angleRad, 0), `angle ${toDeg(hit.angleRad)}`);
  });

  it("reads angles in the rotated frame of a non-Z ring", () => {
    // The X ring's plane is the world Y/Z plane; local +Y is world +Y, so a hit
    // straight up must read 90 degrees.
    const hit = rayToRingLocal(
      new THREE.Vector3(5, 3, 0),
      new THREE.Vector3(-1, 0, 0),
      ringMatrix("x"),
    );
    assert.ok(hit);
    assert.ok(closeTo(hit.radius, 3), `radius ${hit.radius}`);
    assert.ok(closeTo(toDeg(hit.angleRad), 90, 1e-6), `angle ${toDeg(hit.angleRad)}`);
  });

  it("returns the radius in GIZMO units when the gizmo root is scaled", () => {
    // The regression this exists for: the gizmo root is rescaled every frame to
    // keep a constant size on screen (ScreenSpaceGizmo, scale = camera distance
    // * 0.04), so a hit 36 world units out on a gizmo scaled 12x is 3 gizmo
    // units out — and 3 is what the coronas in DIAL_ANATOMY are expressed in.
    // Returning 36 puts every pointer sample past the outermost corona, which
    // silently disables the magnet at any camera distance where the scale is not
    // 1, or engages it in the wrong corona.
    const scale = 12;
    const hit = rayToRingLocal(
      new THREE.Vector3(3 * scale, 0, 5),
      new THREE.Vector3(0, 0, -1),
      ringMatrix("z", scale),
    );
    assert.ok(hit);
    assert.ok(closeTo(hit.radius, 3), `radius ${hit.radius}, expected gizmo units`);
    assert.ok(closeTo(hit.angleRad, 0));
  });

  it("is unaffected by where the gizmo sits in the world", () => {
    const centre = new THREE.Vector3(120, -45, 8);
    const hit = rayToRingLocal(
      new THREE.Vector3(centre.x + 6, centre.y, centre.z + 5),
      new THREE.Vector3(0, 0, -1),
      ringMatrix("z", 2, centre),
    );
    assert.ok(hit);
    assert.ok(closeTo(hit.radius, 3), `radius ${hit.radius}`);
  });

  it("refuses a ray parallel to the plane rather than inventing an angle", () => {
    assert.equal(
      rayToRingLocal(new THREE.Vector3(0, 0, 5), new THREE.Vector3(1, 0, 0), identity),
      null,
    );
  });

  it("refuses a plane that lies behind the ray", () => {
    assert.equal(
      rayToRingLocal(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 1), identity),
      null,
    );
  });
});

describe("emittedDeltaForSweep", () => {
  it("negates the sweep, because the consumer applies emitted deltas negated", () => {
    assert.ok(closeTo(emittedDeltaForSweep(deg(10), 1), deg(-10)));
    assert.ok(closeTo(emittedDeltaForSweep(deg(-10), 1), deg(10)));
    assert.equal(emittedDeltaForSweep(0, 1), 0);
    assert.ok(!Object.is(emittedDeltaForSweep(0, 1), -0));
  });

  it("flips again for a consumer whose displayed axis is inverted", () => {
    assert.ok(closeTo(emittedDeltaForSweep(deg(10), -1), deg(10)));
    assert.ok(closeTo(emittedDeltaForSweep(deg(-10), -1), deg(-10)));
  });

  it("lands a point fixed to the model exactly on the swept angle", () => {
    // Fiducial, measured through THREE rather than reasoned from the code: apply
    // the emitted delta the way SceneCanvas does — quaternion about the world
    // axis by MINUS the emitted angle, premultiplied onto the model — and check a
    // point that started on the dial's zero ends up at the sweep angle in the
    // ring's frame. This is the test that catches a mirrored dial.
    const worldAxes: Record<GizmoAxis, THREE.Vector3> = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };

    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const ringQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...ringGroupEuler(axis)));
      for (const sweepDeg of [10, 45, -30, 175, -179]) {
        const sweep = deg(sweepDeg);
        const emitted = emittedDeltaForSweep(sweep, 1);
        const applied = new THREE.Quaternion().setFromAxisAngle(worldAxes[axis], -emitted);

        const local = new THREE.Vector3(...polarToLocal(0, DIAL_ANATOMY.rimRadius));
        const landed = local
          .clone()
          .applyQuaternion(ringQuat)
          .applyQuaternion(applied)
          .applyQuaternion(ringQuat.clone().invert());

        const landedAngle = Math.atan2(landed.y, landed.x);
        assert.ok(
          Math.abs(shortestAngleDelta(sweep, landedAngle)) < 1e-9,
          `${axis} ring, sweep ${sweepDeg}deg landed at ${toDeg(landedAngle)}deg`,
        );
      }
    }
  });
});

describe("stepDialSweep", () => {
  const START: DialSweep = { sweepRad: 0, targetRad: 0 };

  /**
   * A consumer with a hard end, standing in for the tenon's lean: it takes the
   * rotation until the ceiling and refuses the rest, reporting back what it took.
   * `ceilingRad` is in dial units; deltas arrive emitted, so they come back
   * through the same mapping.
   */
  const clampedConsumer = (ceilingRad: number, axisVisualFlip = 1) => {
    const state = { sweepRad: 0 };
    return {
      state,
      emit: (asked: number) => {
        const wanted = -asked / axisVisualFlip;
        const landed = Math.max(-ceilingRad, Math.min(ceilingRad, state.sweepRad + wanted));
        const took = landed - state.sweepRad;
        state.sweepRad = landed;
        return emittedDeltaForSweep(took, axisVisualFlip);
      },
    };
  };

  /** Walk the pointer through a list of angles, returning the dial's final state. */
  const drag = (
    angles: number[],
    emit: (asked: number) => number | void,
    options: { axisVisualFlip?: number; frameCarriesRotation?: boolean } = {},
  ) =>
    angles.reduce<DialSweep>(
      (state, cursorAngleRad) =>
        stepDialSweep(state, {
          cursorAngleRad,
          axisVisualFlip: options.axisVisualFlip ?? 1,
          frameCarriesRotation: options.frameCarriesRotation,
          emit,
        }),
      START,
    );

  it("follows the pointer exactly when the consumer takes everything", () => {
    const asked: number[] = [];
    const end = drag([deg(10), deg(25), deg(5), deg(-40)], (a) => {
      asked.push(a);
    });
    // A consumer that returns nothing took it all.
    assert.ok(closeTo(end.sweepRad, deg(-40)));
    assert.ok(closeTo(end.targetRad, deg(-40)));
    assert.ok(closeTo(asked[0], deg(-10)));
    assert.ok(closeTo(asked[1], deg(-15)));
  });

  it("stops at the consumer's hard end instead of running on under the pointer", () => {
    const consumer = clampedConsumer(deg(45));
    const end = drag([deg(20), deg(45), deg(60.57)], consumer.emit);
    assert.ok(closeTo(end.sweepRad, deg(45)));
    assert.ok(closeTo(consumer.state.sweepRad, deg(45)));
  });

  it("holds at the end until the pointer comes back to it, then reads the mark again", () => {
    const consumer = clampedConsumer(deg(45));
    // Out past the ceiling, then back down through it. This is the regression:
    // measuring the return against the pointer's 60.57 instead of the 45 the
    // object holds left the dial reading 15 with the pointer on the 45 mark.
    const overshot = drag([deg(45), deg(60.57)], consumer.emit);
    assert.ok(closeTo(overshot.sweepRad, deg(45)));

    const easedBack = stepDialSweep(overshot, {
      cursorAngleRad: deg(50),
      axisVisualFlip: 1,
      emit: consumer.emit,
    });
    // Still beyond the ceiling: nothing moves.
    assert.ok(closeTo(easedBack.sweepRad, deg(45)));

    const onTheMark = stepDialSweep(easedBack, {
      cursorAngleRad: deg(45),
      axisVisualFlip: 1,
      emit: consumer.emit,
    });
    assert.ok(closeTo(onTheMark.sweepRad, deg(45)));

    const backInside = stepDialSweep(onTheMark, {
      cursorAngleRad: deg(30),
      axisVisualFlip: 1,
      emit: consumer.emit,
    });
    assert.ok(closeTo(backInside.sweepRad, deg(30)));
    assert.ok(closeTo(consumer.state.sweepRad, deg(30)));
  });

  it("absorbs the overshoot the same way for an inverted display axis", () => {
    const consumer = clampedConsumer(deg(45), -1);
    const end = drag([deg(60), deg(45), deg(30)], consumer.emit, { axisVisualFlip: -1 });
    assert.ok(closeTo(end.sweepRad, deg(30)));
    assert.ok(closeTo(consumer.state.sweepRad, deg(30)));
  });

  it("measures against the pointer when the frame carries the rotation", () => {
    // The ring turns by whatever was applied, so the next reading already comes
    // back short: folding the sweep into the target too would count it twice.
    const consumer = clampedConsumer(deg(45));
    const end = drag([deg(45), deg(60)], consumer.emit, { frameCarriesRotation: true });
    assert.ok(closeTo(end.targetRad, deg(60)));
    assert.ok(closeTo(end.sweepRad, deg(45)));
  });

  it("does nothing at all when the pointer has not moved", () => {
    let calls = 0;
    const state = stepDialSweep(START, {
      cursorAngleRad: 0,
      axisVisualFlip: 1,
      emit: () => {
        calls += 1;
      },
    });
    assert.equal(calls, 0);
    assert.equal(state, START);
  });
});
