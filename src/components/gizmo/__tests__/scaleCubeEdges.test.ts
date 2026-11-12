import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as THREE from "three";
import { getCachedScaleCubeVisibleEdgeGeometry } from "../gizmoGeometryCache";

// Corner indices are bit flags for a positive x/y/z coordinate; the cube
// geometry spans -0.5..0.5, so the sign is all the decoding a vertex needs.
function drawnEdges(geometry: THREE.BufferGeometry): string[] {
  const position = geometry.getAttribute("position");
  const cornerOf = (i: number) => {
    const x = position.getX(i) > 0 ? 1 : 0;
    const y = position.getY(i) > 0 ? 2 : 0;
    const z = position.getZ(i) > 0 ? 4 : 0;
    return x | y | z;
  };

  const edges: string[] = [];
  for (let i = 0; i < position.count; i += 2) {
    const a = cornerOf(i);
    const b = cornerOf(i + 1);
    edges.push(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  return edges.sort();
}

describe("scale cube edges", () => {
  it("draws only the nine edges the cube's own faces leave visible", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      // The camera is behind the faces whose sign bit is set, so the corner it
      // cannot see has every bit flipped. The three edges meeting there are the
      // ones a solid cube hides.
      const farCorner = mask ^ 0b111;
      const expected: string[] = [];
      for (let a = 0; a < 8; a += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const b = a | (1 << axis);
          if (b === a || a === farCorner || b === farCorner) continue;
          expected.push(a < b ? `${a}:${b}` : `${b}:${a}`);
        }
      }

      assert.equal(expected.length, 9);
      assert.deepEqual(
        drawnEdges(getCachedScaleCubeVisibleEdgeGeometry(mask)),
        expected.sort(),
        `octant ${mask.toString(2)}`,
      );
    }
  });
});
