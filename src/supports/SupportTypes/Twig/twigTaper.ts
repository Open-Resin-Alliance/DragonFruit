import type { Twig } from '../../types';

// Linear taper between the two contact disks. Parameterized by cumulative
// straight-line segment length so taper is continuous across joints — the
// twig behaves as one logical body from disk A to disk B.
//
// s = 0 at disk A's socket joint, s = 1 at disk B's socket joint.

// Twig-local sizing: any joint/knot that sits on the twig is 10% larger than
// the twig's local contact diameter. SSOT lives here so the renderer, builder,
// and live knot-drag logic all agree.
export const TWIG_JOINT_DISK_DIAMETER_MULTIPLIER = 1.10;

export function twigJointDiameterForLocalDiameter(twigDiameterMm: number): number {
    return twigDiameterMm * TWIG_JOINT_DISK_DIAMETER_MULTIPLIER;
}

interface TwigSegmentRange {
    segmentId: string;
    sStart: number;
    sEnd: number;
}

interface TwigTaperLayout {
    totalLength: number;
    segments: TwigSegmentRange[];
}

function segmentLength(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function buildTwigTaperLayout(twig: Twig): TwigTaperLayout {
    const lengths: number[] = [];
    let totalLength = 0;

    for (const seg of twig.segments) {
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (!start || !end) {
            lengths.push(0);
            continue;
        }
        const len = segmentLength(start, end);
        lengths.push(len);
        totalLength += len;
    }

    const segments: TwigSegmentRange[] = [];
    if (totalLength <= 1e-8) {
        // Degenerate twig — every segment collapses to s=0..1 uniform.
        for (const seg of twig.segments) {
            segments.push({ segmentId: seg.id, sStart: 0, sEnd: 1 });
        }
        return { totalLength: 0, segments };
    }

    let cursor = 0;
    twig.segments.forEach((seg, i) => {
        const len = lengths[i];
        const sStart = cursor / totalLength;
        cursor += len;
        const sEnd = cursor / totalLength;
        segments.push({ segmentId: seg.id, sStart, sEnd });
    });

    return { totalLength, segments };
}

export function twigDiameterAtS(twig: Twig, s: number): number {
    const clamped = Math.max(0, Math.min(1, s));
    const dA = twig.contactDiskA.contactDiameterMm;
    const dB = twig.contactDiskB.contactDiameterMm;
    return dA + (dB - dA) * clamped;
}

/**
 * Resolve the twig's local diameter at a snap location expressed as
 * (segmentId, t_within_segment). Used by Leaf snapping math so a Leaf's
 * base diameter live-tracks the twig taper as the knot slides.
 *
 * Returns null if the segment is not part of this twig.
 */
export function resolveTwigDiameterAtSegmentT(
    twig: Twig,
    segmentId: string,
    t: number
): number | null {
    const layout = buildTwigTaperLayout(twig);
    const range = layout.segments.find((r) => r.segmentId === segmentId);
    if (!range) return null;
    const clampedT = Math.max(0, Math.min(1, t));
    const s = range.sStart + (range.sEnd - range.sStart) * clampedT;
    return twigDiameterAtS(twig, s);
}

/**
 * Per-segment start/end diameters for the renderer. Each segment's start
 * uses the cumulative-length s at its bottomJoint; end uses s at its topJoint.
 */
export function resolveTwigSegmentDiameters(
    twig: Twig
): Map<string, { diameterStart: number; diameterEnd: number }> {
    const layout = buildTwigTaperLayout(twig);
    const result = new Map<string, { diameterStart: number; diameterEnd: number }>();
    for (const range of layout.segments) {
        result.set(range.segmentId, {
            diameterStart: twigDiameterAtS(twig, range.sStart),
            diameterEnd: twigDiameterAtS(twig, range.sEnd),
        });
    }
    return result;
}
