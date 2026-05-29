import { describe, it } from 'node:test';
import assert from 'node:assert';

// ─── Mathematical Models under test (Mirrored from SVG widgets) ───

// Coordinate translation logic for Clock widget
function getClockCoords(deg: number, radius: number, cx = 50, cy = 50) {
  const rad = (deg - 90) * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

// Polar angle translation and snapping logic
function computeClockAngleFromPointer(
  clientX: number,
  clientY: number,
  rectCenterX: number,
  rectCenterY: number,
  snapIncrement = 15
): number {
  const angleRad = Math.atan2(clientY - rectCenterY, clientX - rectCenterX);
  let angleDeg = angleRad * (180 / Math.PI); // -180 to 180

  // Top vertical (12 o'clock) is 0°
  let relativeAngle = angleDeg + 90;
  if (relativeAngle < -180) relativeAngle += 360;
  if (relativeAngle > 180) relativeAngle -= 360;

  // Absolute half angle
  let halfAngle = Math.abs(relativeAngle);

  if (snapIncrement > 0) {
    halfAngle = Math.round(halfAngle / snapIncrement) * snapIncrement;
  }

  // Clamp 0 to 180
  return Math.min(180, Math.max(0, halfAngle));
}

// Slope angle calculation and clamping for Overhang Gauge
function computeOverhangSlopeFromPointer(
  vx: number,
  vy: number,
  cx = 50,
  cy = 80,
  snapIncrement = 5
): number {
  const rad = Math.atan2(vy - cy, vx - cx);
  let slope = rad * (180 / Math.PI) + 90; // 0 to 180
  
  // Clamp to first quadrant (0 to 90)
  slope = Math.min(90, Math.max(0, slope));

  if (snapIncrement > 0) {
    slope = Math.round(slope / snapIncrement) * snapIncrement;
  }
  return slope;
}

describe('Support Painter Phase 2 - SVG Dial & Gauge Mathematical Verification', () => {
  
  describe('Symmetrical Clock Polar Math & Snapping', () => {
    it('should translate degree steps to standard SVG viewport coordinates correctly', () => {
      // 0° vertical top (12 o'clock) -> x should be 50, y should be center - radius
      const topCoords = getClockCoords(0, 35);
      assert.ok(Math.abs(topCoords.x - 50) < 1e-5);
      assert.ok(Math.abs(topCoords.y - 15) < 1e-5);

      // 90° horizontal right (3 o'clock) -> x should be center + radius, y should be 50
      const rightCoords = getClockCoords(90, 35);
      assert.ok(Math.abs(rightCoords.x - 85) < 1e-5);
      assert.ok(Math.abs(rightCoords.y - 50) < 1e-5);

      // -90° horizontal left (9 o'clock) -> x should be center - radius, y should be 50
      const leftCoords = getClockCoords(-90, 35);
      assert.ok(Math.abs(leftCoords.x - 15) < 1e-5);
      assert.ok(Math.abs(leftCoords.y - 50) < 1e-5);
    });

    it('should map pointer drag coordinates to snapped half-angle values correctly', () => {
      // 1. Symmetrical snap test at relative angle ~45° (clockwise from top: 1:30 position)
      // At 1:30, SVG angle is -45°. x = 50 + R * cos(-45°) = 74.7, y = 50 + R * sin(-45°) = 25.3
      const angle1 = computeClockAngleFromPointer(74.7, 25.3, 50, 50, 15);
      assert.strictEqual(angle1, 45);

      // 2. Snap test at relative angle ~36°: should snap down to 30°
      // At relative angle 36°, x = 50 + R * sin(36°) = 70.5, y = 50 - R * cos(36°) = 21.7
      const angle2 = computeClockAngleFromPointer(70.5, 21.7, 50, 50, 15);
      assert.strictEqual(angle2, 30);

      // 3. Snap test at relative angle ~53°: should snap up to 60°
      // At relative angle 53°, x = 50 + R * sin(53°) = 77.9, y = 50 - R * cos(53°) = 28.9
      const angle3 = computeClockAngleFromPointer(77.9, 28.9, 50, 50, 15);
      assert.strictEqual(angle3, 60);

      // 4. Out of bounds (e.g. 195° absolute): should clamp to 180°
      const angle4 = computeClockAngleFromPointer(50, 200, 50, 50, 15);
      assert.strictEqual(angle4, 180);
    });
  });

  describe('Overhang Arc Gauge Quadrant Math & Snapping', () => {
    it('should accurately calculate slope angles between 0° and 90° from SVG viewport layout coordinates', () => {
      // 0° vertical top (above cy=80) -> x=50, y=48 (R=32)
      const slopeVertical = computeOverhangSlopeFromPointer(50, 48);
      assert.strictEqual(slopeVertical, 0);

      // 90° horizontal right (right of cx=50) -> x=82, y=80 (R=32)
      const slopeHorizontal = computeOverhangSlopeFromPointer(82, 80);
      assert.strictEqual(slopeHorizontal, 90);

      // 45° middle overhang angle
      const coords45 = { x: 50 + 32 * Math.cos(-Math.PI / 4), y: 80 + 32 * Math.sin(-Math.PI / 4) };
      const slope45 = computeOverhangSlopeFromPointer(coords45.x, coords45.y, 50, 80, 5);
      assert.strictEqual(slope45, 45);
    });

    it('should clamp out-of-quadrant angles to the vertical 0° and horizontal 90° boundaries', () => {
      // Left-top side click (Z-Slope < 0): e.g. vx = 20 (left), vy = 40 (top, above center y=80)
      // Math.atan2(40-80, 20-50) = Math.atan2(-40, -30) = -126.8°
      // slope = -126.8 + 90 = -36.8°, should clamp cleanly to 0°
      const slopeClampLeftTop = computeOverhangSlopeFromPointer(20, 40);
      assert.strictEqual(slopeClampLeftTop, 0);

      // Left-bottom side click (Z-Slope > 90): e.g. vx = 20 (left), vy = 120 (bottom, below center y=80)
      // Math.atan2(120-80, 20-50) = Math.atan2(40, -30) = 126.8°
      // slope = 126.8 + 90 = 216.8°, should clamp cleanly to 90°
      const slopeClampLeftBottom = computeOverhangSlopeFromPointer(20, 120);
      assert.strictEqual(slopeClampLeftBottom, 90);
    });
  });
});
