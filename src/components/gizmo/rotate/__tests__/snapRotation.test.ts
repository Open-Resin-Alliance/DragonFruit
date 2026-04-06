import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapAngle, SNAP_COARSE, SNAP_FINE } from "../snapRotation";

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
