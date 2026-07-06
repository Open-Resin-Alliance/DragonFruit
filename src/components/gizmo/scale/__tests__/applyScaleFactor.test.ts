import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyScaleFactor } from "../applyScaleFactor";

const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("applyScaleFactor", () => {
  describe("uniform", () => {
    it("scales all three axes by the factor", () => {
      const result = applyScaleFactor(vec(1, 2, 3), "uniform", 2);
      assert.equal(result.x, 2);
      assert.equal(result.y, 4);
      assert.equal(result.z, 6);
    });

    it("factor of 1 returns the same values", () => {
      const result = applyScaleFactor(vec(3, 5, 7), "uniform", 1);
      assert.equal(result.x, 3);
      assert.equal(result.y, 5);
      assert.equal(result.z, 7);
    });

    it("clamps factor to 0.0001 minimum", () => {
      const result = applyScaleFactor(vec(2, 2, 2), "uniform", 0);
      assert.equal(result.x, 0.0002);
      assert.equal(result.y, 0.0002);
      assert.equal(result.z, 0.0002);
    });

    it("does not mutate the input vector", () => {
      const initial = vec(1, 1, 1);
      applyScaleFactor(initial, "uniform", 5);
      assert.equal(initial.x, 1);
    });
  });

  describe("per-axis", () => {
    it("x: only scales the x component", () => {
      const result = applyScaleFactor(vec(2, 3, 4), "x", 3);
      assert.equal(result.x, 6);
      assert.equal(result.y, 3);
      assert.equal(result.z, 4);
    });

    it("y: only scales the y component", () => {
      const result = applyScaleFactor(vec(2, 3, 4), "y", 2);
      assert.equal(result.x, 2);
      assert.equal(result.y, 6);
      assert.equal(result.z, 4);
    });

    it("z: only scales the z component", () => {
      const result = applyScaleFactor(vec(2, 3, 4), "z", 0.5);
      assert.equal(result.x, 2);
      assert.equal(result.y, 3);
      assert.equal(result.z, 2);
    });

    it("clamps factor to 0.0001 minimum on a single axis", () => {
      const result = applyScaleFactor(vec(1, 1, 1), "x", -5);
      assert.equal(result.x, 0.0001);
      assert.equal(result.y, 1);
      assert.equal(result.z, 1);
    });

    it("does not mutate the input vector", () => {
      const initial = vec(2, 3, 4);
      applyScaleFactor(initial, "y", 10);
      assert.equal(initial.y, 3);
    });
  });
});
