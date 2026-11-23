import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCachedRotationArcPoints } from "../gizmoGeometryCache";
import { GIZMO_SIZES } from "../constants";

function arcSpanDegrees(points: { x: number; y: number }[]): { start: number; end: number; span: number } {
  const angleOf = (p: { x: number; y: number }) => (Math.atan2(p.y, p.x) * 180) / Math.PI;
  const start = angleOf(points[0]);
  const end = angleOf(points[points.length - 1]);
  return { start, end: end < start ? end + 360 : end, span: (end < start ? end + 360 : end) - start };
}

describe("rotation ring arcs", () => {
  it("splits the circle into a 90 degree bright arc and a 270 degree faint one", () => {
    const front = arcSpanDegrees(getCachedRotationArcPoints("front"));
    const back = arcSpanDegrees(getCachedRotationArcPoints("back"));

    assert.equal(Math.round(front.span), 90);
    assert.equal(Math.round(back.span), 270);

    // The faint arc has to pick up exactly where the bright one stops, so the
    // two never leave a gap or draw the same stretch twice around the ring.
    assert.equal(Math.round(front.end), Math.round(back.start));
    assert.equal(
      Math.round(back.end),
      Math.round(front.start + 360),
      "the faint arc closes the circle back onto the bright arc's start",
    );

    for (const points of [getCachedRotationArcPoints("front"), getCachedRotationArcPoints("back")]) {
      for (const point of points) {
        assert.ok(
          Math.abs(Math.hypot(point.x, point.y) - GIZMO_SIZES.ringMajorRadius) < 1e-6,
          "the arcs sit on the ring's radius",
        );
      }
    }
  });
});
