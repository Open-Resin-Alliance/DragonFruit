import * as THREE from 'three';

/**
 * The width of a tapering shaft at each point of the polyline drawing it, so a
 * curve's pieces share the taper rather than each carrying all of it.
 */
export function taperWidthAlong(
    pointCount: number,
    startDiameterMm: number,
    endDiameterMm?: number,
): (pointIndex: number) => number {
    const spans = Math.max(1, pointCount - 1);
    const end = endDiameterMm ?? startDiameterMm;
    if (Math.abs(end - startDiameterMm) < 1e-6) return () => startDiameterMm;
    return (pointIndex: number) => THREE.MathUtils.lerp(
        startDiameterMm,
        end,
        THREE.MathUtils.clamp(pointIndex / spans, 0, 1),
    );
}
