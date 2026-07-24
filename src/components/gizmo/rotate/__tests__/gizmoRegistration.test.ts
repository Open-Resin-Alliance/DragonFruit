import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  getSnapTicks,
  spokeRingAngle,
  objectAngleForRingAngle,
  nearestTickRad,
  polarToLocal,
  ringGroupEuler,
  DEFAULT_SNAP_TICK_CONFIG,
} from "../snapRotation";
import { GIZMO_SIZES } from "../../constants";
import type { GizmoAxis } from "../../types";

/**
 * Registration guard for the rotation protractor dial.
 *
 * The defect this exists to catch: dial ticks and the angle indicator agreed
 * only when the camera looked straight down the ring's axis, and drifted apart
 * as it moved off-axis. The cause was reading a camera-derived angle as though
 * it were a ring-local one. An on-axis-only test passes against that defect,
 * which is exactly why it reached review — so every assertion here sweeps a
 * grid of camera poses.
 *
 * Positions are read back out of real THREE object matrices via
 * getWorldPosition() and projected through a real PerspectiveCamera, rather
 * than recomputed from the same formulas under test, so a regression anywhere
 * in the transform chain is caught rather than assumed away.
 */

const VIEWPORT = { width: 1024, height: 768 };
const AXES: GizmoAxis[] = ["x", "y", "z"];

/** Camera azimuths and elevations. Avoids +/-90 elevation, where lookAt is degenerate. */
const AZIMUTHS_DEG = [0, 45, 90, 135, 180, 225, 270, 315];
const ELEVATIONS_DEG = [-60, -30, 0, 30, 60];

/** Tick positions sampled for registration. Mix of major, medium and minor. */
const SAMPLE_DEGREES = [0, 45, 90, 135, 180, 270, 315, 15, 30, 5];

function makeCamera(azimuthDeg: number, elevationDeg: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    50,
    VIEWPORT.width / VIEWPORT.height,
    0.1,
    1000,
  );
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const dist = 24;
  camera.position.set(
    dist * Math.cos(el) * Math.cos(az),
    dist * Math.sin(el),
    dist * Math.cos(el) * Math.sin(az),
  );
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function toScreen(object: THREE.Object3D, camera: THREE.Camera): { x: number; y: number } {
  const world = object.getWorldPosition(new THREE.Vector3());
  const ndc = world.project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * VIEWPORT.width,
    y: (-ndc.y * 0.5 + 0.5) * VIEWPORT.height,
  };
}

function screenDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Build a ring in the same scene-graph shape the gizmo uses: a group carrying
 * the per-axis orientation, with tick markers and the spoke tip as children in
 * the ring-local frame.
 */
function buildRing(axis: GizmoAxis, objectAngleRad: number, axisVisualFlip: number) {
  const group = new THREE.Group();
  const [rx, ry, rz] = ringGroupEuler(axis);
  group.rotation.set(rx, ry, rz);

  const radius = GIZMO_SIZES.dialRadius;
  const tickByDegree = new Map<number, THREE.Object3D>();

  for (const tick of getSnapTicks(DEFAULT_SNAP_TICK_CONFIG)) {
    const marker = new THREE.Object3D();
    const [x, y, z] = polarToLocal(tick.rad, radius);
    marker.position.set(x, y, z);
    group.add(marker);
    tickByDegree.set(tick.deg, marker);
  }

  const spokeTip = new THREE.Object3D();
  const [sx, sy, sz] = polarToLocal(
    spokeRingAngle(objectAngleRad, axisVisualFlip),
    radius,
  );
  spokeTip.position.set(sx, sy, sz);
  group.add(spokeTip);

  group.updateMatrixWorld(true);
  return { group, tickByDegree, spokeTip };
}

describe("dial registration across camera poses", () => {
  it("lands the spoke on the matching tick at every camera pose and axis", () => {
    let checks = 0;
    for (const axis of AXES) {
      for (const azimuth of AZIMUTHS_DEG) {
        for (const elevation of ELEVATIONS_DEG) {
          const camera = makeCamera(azimuth, elevation);
          for (const degree of SAMPLE_DEGREES) {
            // Derive the object rotation that should put the spoke on this tick,
            // rather than assuming object degrees and ring degrees coincide.
            const objectAngle = objectAngleForRingAngle((degree * Math.PI) / 180, 1);
            const { tickByDegree, spokeTip } = buildRing(axis, objectAngle, 1);
            const tick = tickByDegree.get(degree);
            assert.ok(tick, `no tick at ${degree} degrees`);

            const drift = screenDistance(
              toScreen(spokeTip, camera),
              toScreen(tick, camera),
            );
            assert.ok(
              drift < 0.5,
              `axis ${axis}, az ${azimuth}, el ${elevation}, ${degree}deg: ` +
                `spoke drifted ${drift.toFixed(3)}px from its tick`,
            );
            checks += 1;
          }
        }
      }
    }
    assert.ok(checks > 1000, `expected a real sweep, only ran ${checks} checks`);
  });

  it("registers under an inverted axis, as HolePunchGizmo uses", () => {
    // HolePunchGizmo passes axisVisualFlip={{ y: -1 }} because displayY = -cutterY.
    // The object angle that reaches a given tick is negated relative to the
    // unflipped case, and the spoke must still land on that tick.
    for (const azimuth of AZIMUTHS_DEG) {
      for (const elevation of ELEVATIONS_DEG) {
        const camera = makeCamera(azimuth, elevation);
        for (const degree of SAMPLE_DEGREES) {
          const objectAngle = objectAngleForRingAngle((degree * Math.PI) / 180, -1);
          const { tickByDegree, spokeTip } = buildRing("y", objectAngle, -1);
          const tick = tickByDegree.get(degree);
          assert.ok(tick, `no tick at ${degree} degrees`);

          const drift = screenDistance(
            toScreen(spokeTip, camera),
            toScreen(tick, camera),
          );
          assert.ok(
            drift < 0.5,
            `flipped y, az ${azimuth}, el ${elevation}, ${degree}deg: ` +
              `spoke drifted ${drift.toFixed(3)}px`,
          );
        }
      }
    }
  });

  it("keeps every tick on one circle in the ring plane", () => {
    // A per-axis mapping error would show as a tick off the dial circle.
    for (const axis of AXES) {
      const { group, tickByDegree } = buildRing(axis, 0, 1);
      const centre = group.getWorldPosition(new THREE.Vector3());
      for (const [degree, marker] of tickByDegree) {
        const radius = marker.getWorldPosition(new THREE.Vector3()).distanceTo(centre);
        assert.ok(
          Math.abs(radius - GIZMO_SIZES.dialRadius) < 1e-9,
          `axis ${axis}, ${degree}deg sits at radius ${radius}, expected ${GIZMO_SIZES.dialRadius}`,
        );
      }
    }
  });
});

describe("the registration guard actually detects camera-derived drift", () => {
  /** The rejected implementation's angle source: derived purely from the camera. */
  function cameraAlignedAngle(camera: THREE.Camera, axis: GizmoAxis): number {
    const dir = camera.position.clone().normalize();
    if (axis === "x") return Math.atan2(dir.z, dir.y) + Math.PI / 2;
    if (axis === "y") return Math.atan2(-dir.z, dir.x);
    return Math.atan2(dir.y, dir.x);
  }

  function driftFor(azimuth: number, elevation: number): number {
    const camera = makeCamera(azimuth, elevation);
    const radius = GIZMO_SIZES.dialRadius;

    const group = new THREE.Group();
    const [rx, ry, rz] = ringGroupEuler("z");
    group.rotation.set(rx, ry, rz);

    // Tick at 0 degrees, in the ring-local frame — correct.
    const tick = new THREE.Object3D();
    const [tx, ty, tz] = polarToLocal(0, radius);
    tick.position.set(tx, ty, tz);
    group.add(tick);

    // Indicator placed from a camera-derived angle — the defect.
    const indicator = new THREE.Object3D();
    const [ix, iy, iz] = polarToLocal(cameraAlignedAngle(camera, "z"), radius);
    indicator.position.set(ix, iy, iz);
    group.add(indicator);

    group.updateMatrixWorld(true);
    return screenDistance(toScreen(indicator, camera), toScreen(tick, camera));
  }

  it("shows no drift when looking down the axis, which is why the bug shipped", () => {
    // Camera on +X with zero elevation makes the camera-derived angle 0 for the
    // z ring, so it coincides with the 0-degree tick and nothing looks wrong.
    assert.ok(
      driftFor(0, 0) < 0.5,
      `expected agreement on-axis, got ${driftFor(0, 0).toFixed(3)}px`,
    );
  });

  it("shows large drift off-axis, so the sweep above would fail on a regression", () => {
    const drift = driftFor(90, 30);
    assert.ok(
      drift > 5,
      `expected the defect to be visible off-axis, got only ${drift.toFixed(3)}px — ` +
        `if this is small the sweep has lost its teeth`,
    );
  });
});

describe("the spoke tracks the object's real rotation", () => {
  /**
   * Ground truth, independent of the formulas under test.
   *
   * A point fixed to the object is rotated by THREE itself, then measured back
   * in the ring's local frame. Whatever angle it lands at is where the spoke
   * must be. This is the one thing the registration sweep structurally cannot
   * check: that sweep compares the spoke against the ticks, so a dial that is
   * globally mirrored satisfies every assertion in it.
   */
  function observedRingAngle(axis: GizmoAxis, objectAngleRad: number): number {
    const euler = new THREE.Euler(...ringGroupEuler(axis));
    const ringQuat = new THREE.Quaternion().setFromEuler(euler);

    // A marker fixed to the object, starting at ring-local angle 0.
    const start = new THREE.Vector3(
      ...polarToLocal(0, GIZMO_SIZES.dialRadius),
    ).applyQuaternion(ringQuat);

    const objectGroup = new THREE.Group();
    objectGroup.rotation[axis] = objectAngleRad;
    const marker = new THREE.Object3D();
    marker.position.copy(start);
    objectGroup.add(marker);
    objectGroup.updateMatrixWorld(true);

    // Measure where it ended up, back in the ring's local frame.
    const local = marker
      .getWorldPosition(new THREE.Vector3())
      .applyQuaternion(ringQuat.clone().invert());
    return Math.atan2(local.y, local.x);
  }

  function angularGap(a: number, b: number): number {
    const TWO_PI = Math.PI * 2;
    let d = (a - b) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return Math.abs(d);
  }

  it("puts the spoke where a point fixed to the object actually travels", () => {
    for (const axis of AXES) {
      for (const degree of [15, 45, 90, 180, 270, -30, -120]) {
        const objectAngle = (degree * Math.PI) / 180;
        const observed = observedRingAngle(axis, objectAngle);
        const predicted = spokeRingAngle(objectAngle, 1);
        assert.ok(
          angularGap(observed, predicted) < 1e-9,
          `axis ${axis}, object at ${degree}deg: the object's own point lands at ` +
            `${((observed * 180) / Math.PI).toFixed(2)}deg but the spoke is drawn at ` +
            `${((predicted * 180) / Math.PI).toFixed(2)}deg — the dial is mirrored`,
        );
      }
    }
  });
});

describe("click resolution reaches the tick under the cursor", () => {
  /**
   * Exercises the exact composition handleDialPointerUp runs, from a pick point
   * to an object angle, across camera poses and both flip directions. The
   * component reads e.point (a world hit) through e.object.worldToLocal; here we
   * build a real world hit on the dial band, invert it into the ring-local frame
   * the same way, and assert the resolved object angle lands the spoke back on
   * the tick the cursor was over. Unit tests cover the pieces; this covers the
   * wiring, which is where a sign or frame slip would hide.
   */
  function ringQuat(axis: GizmoAxis): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(...ringGroupEuler(axis)));
  }

  /** World-space point sitting on the dial band at a given ring-local angle. */
  function dialWorldPoint(axis: GizmoAxis, ringAngleRad: number): THREE.Vector3 {
    const local = new THREE.Vector3(...polarToLocal(ringAngleRad, GIZMO_SIZES.dialRadius));
    return local.applyQuaternion(ringQuat(axis));
  }

  /** The resolution handleDialPointerUp performs: world hit -> object angle. */
  function resolveClick(axis: GizmoAxis, worldHit: THREE.Vector3, flip: number): number {
    // e.object.worldToLocal — the dial mesh's frame is the ring group's frame.
    const local = worldHit.clone().applyQuaternion(ringQuat(axis).clone().invert());
    const hitAngle = Math.atan2(local.y, local.x);
    return objectAngleForRingAngle(nearestTickRad(hitAngle), flip);
  }

  it("resolves a hit on each sampled tick to that tick, across axes and flips", () => {
    for (const axis of AXES) {
      for (const flip of [1, -1]) {
        for (const degree of SAMPLE_DEGREES) {
          const ringAngle = (degree * Math.PI) / 180;
          const worldHit = dialWorldPoint(axis, ringAngle);
          const objectAngle = resolveClick(axis, worldHit, flip);

          // The spoke drawn for that object angle must land back on the tick.
          const landedRingAngle = spokeRingAngle(objectAngle, flip);
          const landedDeg = ((Math.round((landedRingAngle * 180) / Math.PI) % 360) + 360) % 360;
          assert.equal(
            landedDeg,
            degree,
            `axis ${axis}, flip ${flip}: clicking tick ${degree}deg resolved to a ` +
              `rotation that lands the spoke at ${landedDeg}deg`,
          );
        }
      }
    }
  });

  it("snaps an off-tick hit to the nearest tick, not the raw cursor angle", () => {
    // A hit at 43deg on the dial must rotate to the 45 tick, not to 43.
    const worldHit = dialWorldPoint("z", (43 * Math.PI) / 180);
    const objectAngle = resolveClick("z", worldHit, 1);
    const landed = spokeRingAngle(objectAngle, 1);
    const landedDeg = Math.round((landed * 180) / Math.PI);
    assert.equal(landedDeg, 45);
  });
});
