import type { SnapTarget } from '../../../SnappingManager';
import type { SupportState, Vec3, Brace, Knot } from '../../../../types';
import { getFinalSocketPosition } from '../../../../SupportPrimitives/ContactCone';
import type { ContactCone } from '../../../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { JOINT_DIAMETER_OFFSET_MM } from '../../../../constants';
import type { KickstandState } from '../../../../SupportTypes/Kickstand/types';

type PlacementSurface = 'interior' | 'exterior';

interface BuildSupportPathSnapTargetsOptions {
    includeTrunks?: boolean;
    includeBranches?: boolean;
    includeBraces?: boolean;
    includeTwigs?: boolean;
    includeSticks?: boolean;
    placementSurface?: PlacementSurface;
    excludeSegmentIds?: ReadonlySet<string>;
}

interface BuildKickstandPathSnapTargetsOptions {
    excludeSegmentIds?: ReadonlySet<string>;
}

interface BuildLeafConePathSnapTargetsOptions {
    excludeLeafIds?: ReadonlySet<string>;
    placementSurface?: PlacementSurface;
}

export interface LeafConeSnapMeta {
    modelId: string;
    cone: ContactCone;
    start: Vec3;
    end: Vec3;
    contactRadiusMm: number;
    bodyRadiusMm: number;
    lengthMm: number;
}

function cloneVec3(v: Vec3): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
}

function shouldExclude(id: string, excludeSegmentIds?: ReadonlySet<string>): boolean {
    return !!excludeSegmentIds && excludeSegmentIds.has(id);
}

function matchesPlacementSurfaceFilter(
    targetSurface: PlacementSurface | undefined,
    requestedSurface: PlacementSurface | undefined,
): boolean {
    if (!requestedSurface) return true;
    if (requestedSurface === 'interior') return targetSurface === 'interior';
    return targetSurface !== 'interior';
}

function normalizeVec3(v: Vec3): Vec3 {
    const len = Math.hypot(v.x, v.y, v.z);
    if (len <= 1e-8) {
        return { x: 0, y: 0, z: 1 };
    }
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function resolveBraceEndDiameters(brace: Brace, knotById: Record<string, Knot>): { startDia: number; endDia: number } | null {
    const startKnot = knotById[brace.startKnotId];
    const endKnot = knotById[brace.endKnotId];
    if (!startKnot || !endKnot) return null;

    const startDia = Math.max(
        0.001,
        (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
    );
    const endDia = Math.max(
        0.001,
        (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
    );

    return { startDia, endDia };
}

export function resolveBracePathDiameterAtT(brace: Brace, knotById: Record<string, Knot>, t: number): number | null {
    const diameters = resolveBraceEndDiameters(brace, knotById);
    if (!diameters) return null;
    const clampedT = Math.max(0, Math.min(1, t));
    return diameters.startDia + (diameters.endDia - diameters.startDia) * clampedT;
}

export function buildSupportPathSnapTargets(
    supportState: Pick<SupportState, 'trunks' | 'branches' | 'braces' | 'twigs' | 'sticks' | 'roots' | 'knots'>,
    options: BuildSupportPathSnapTargetsOptions = {}
): SnapTarget[] {
    const {
        includeTrunks = true,
        includeBranches = true,
        includeBraces = true,
        includeTwigs = false,
        includeSticks = false,
        placementSurface,
        excludeSegmentIds,
    } = options;

    const targets: SnapTarget[] = [];
    const rootMap = new Map(Object.values(supportState.roots).map((root) => [root.id, root]));
    const knotMap = new Map(Object.values(supportState.knots).map((knot) => [knot.id, knot]));

    if (includeTrunks) {
        for (const trunk of Object.values(supportState.trunks)) {
            if (!matchesPlacementSurfaceFilter(trunk.contactCone?.placementSurface, placementSurface)) continue;
            const root = rootMap.get(trunk.rootId);
            if (!root || trunk.segments.length === 0) continue;

            const startZOffset = root.diskHeight + (root.coneHeight || 1.5);
            let currentStart: Vec3 = {
                x: root.transform.pos.x,
                y: root.transform.pos.y,
                z: root.transform.pos.z + startZOffset,
            };

            for (const segment of trunk.segments) {
                const endPoint = segment.topJoint
                    ? cloneVec3(segment.topJoint.pos)
                    : trunk.contactCone
                        ? getFinalSocketPosition(trunk.contactCone)
                        : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 10 };

                if (!shouldExclude(segment.id, excludeSegmentIds)) {
                    targets.push({
                        id: segment.id,
                        type: 'path',
                        pathSegment: {
                            start: cloneVec3(currentStart),
                            end: cloneVec3(endPoint),
                            radius: segment.diameter / 2,
                            bezier: segment.type === 'bezier'
                                ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                                : undefined,
                        },
                    });
                }

                currentStart = endPoint;
            }
        }
    }

    if (includeBranches) {
        for (const branch of Object.values(supportState.branches)) {
            if (!matchesPlacementSurfaceFilter(branch.contactCone?.placementSurface, placementSurface)) continue;
            const parentKnot = knotMap.get(branch.parentKnotId);
            if (!parentKnot || branch.segments.length === 0) continue;

            let currentStart = cloneVec3(parentKnot.pos);

            for (const segment of branch.segments) {
                const endPoint = segment.topJoint
                    ? cloneVec3(segment.topJoint.pos)
                    : branch.contactCone
                        ? getFinalSocketPosition(branch.contactCone)
                        : { x: currentStart.x, y: currentStart.y, z: currentStart.z + 5 };

                if (!shouldExclude(segment.id, excludeSegmentIds)) {
                    targets.push({
                        id: segment.id,
                        type: 'path',
                        pathSegment: {
                            start: cloneVec3(currentStart),
                            end: cloneVec3(endPoint),
                            radius: segment.diameter / 2,
                            bezier: segment.type === 'bezier'
                                ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                                : undefined,
                        },
                    });
                }

                currentStart = endPoint;
            }
        }
    }

    if (includeBraces) {
        for (const brace of Object.values(supportState.braces)) {
            if (!matchesPlacementSurfaceFilter(brace.placementSurface, placementSurface)) continue;
            const braceSegmentId = `braceSegment:${brace.id}`;
            if (shouldExclude(braceSegmentId, excludeSegmentIds)) continue;

            const startKnot = knotMap.get(brace.startKnotId);
            const endKnot = knotMap.get(brace.endKnotId);
            if (!startKnot || !endKnot) continue;

            const startHostDia = Math.max(
                0.001,
                (startKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
            );
            const endHostDia = Math.max(
                0.001,
                (endKnot.diameter ?? brace.profile.diameter) - JOINT_DIAMETER_OFFSET_MM
            );
            const radius = Math.max(startHostDia, endHostDia) / 2;

            targets.push({
                id: braceSegmentId,
                type: 'path',
                pathSegment: {
                    start: cloneVec3(startKnot.pos),
                    end: cloneVec3(endKnot.pos),
                    radius,
                    bezier: brace.curve?.type === 'bezier'
                        ? { control1: brace.curve.controlPoint1, control2: brace.curve.controlPoint2 }
                        : undefined,
                },
            });
        }
    }

    if (includeTwigs) {
        for (const twig of Object.values(supportState.twigs)) {
            const twigPlacementSurface = twig.contactDiskA?.placementSurface ?? twig.contactDiskB?.placementSurface;
            if (!matchesPlacementSurfaceFilter(twigPlacementSurface, placementSurface)) continue;
            for (const segment of twig.segments) {
                if (shouldExclude(segment.id, excludeSegmentIds)) continue;
                if (!segment.bottomJoint || !segment.topJoint) continue;

                targets.push({
                    id: segment.id,
                    type: 'path',
                    pathSegment: {
                        start: cloneVec3(segment.bottomJoint.pos),
                        end: cloneVec3(segment.topJoint.pos),
                        radius: segment.diameter / 2,
                        bezier: segment.type === 'bezier'
                            ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                            : undefined,
                    },
                });
            }
        }
    }

    if (includeSticks) {
        for (const stick of Object.values(supportState.sticks)) {
            const stickPlacementSurface = stick.contactConeA?.placementSurface ?? stick.contactConeB?.placementSurface;
            if (!matchesPlacementSurfaceFilter(stickPlacementSurface, placementSurface)) continue;
            for (const segment of stick.segments) {
                if (shouldExclude(segment.id, excludeSegmentIds)) continue;
                if (!segment.bottomJoint || !segment.topJoint) continue;

                targets.push({
                    id: segment.id,
                    type: 'path',
                    pathSegment: {
                        start: cloneVec3(segment.bottomJoint.pos),
                        end: cloneVec3(segment.topJoint.pos),
                        radius: segment.diameter / 2,
                        bezier: segment.type === 'bezier'
                            ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                            : undefined,
                    },
                });
            }
        }
    }

    return targets;
}

export function buildPrimarySnapTargetIndex(targets: readonly SnapTarget[]): Map<string, SnapTarget> {
    const map = new Map<string, SnapTarget>();
    for (const target of targets) {
        if (!map.has(target.id)) {
            map.set(target.id, target);
        }
    }
    return map;
}

export function buildKickstandPathSnapTargets(
    kickstandState: Pick<KickstandState, 'kickstands' | 'roots' | 'knots'>,
    options: BuildKickstandPathSnapTargetsOptions = {}
): SnapTarget[] {
    const { excludeSegmentIds } = options;
    const targets: SnapTarget[] = [];

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        const kickstandRoot = kickstandState.roots[kickstand.rootId];
        const kickstandHostKnot = kickstandState.knots[kickstand.hostKnotId];
        if (!kickstandRoot || !kickstandHostKnot) continue;

        const rootTopZ = kickstandRoot.transform.pos.z + kickstandRoot.diskHeight + kickstandRoot.coneHeight;

        kickstand.segments.forEach((segment, index) => {
            if (shouldExclude(segment.id, excludeSegmentIds)) return;

            let startPos: Vec3;
            if (index === 0) {
                startPos = {
                    x: kickstandRoot.transform.pos.x,
                    y: kickstandRoot.transform.pos.y,
                    z: rootTopZ,
                };
            } else {
                const previousSegment = kickstand.segments[index - 1];
                if (!previousSegment.topJoint) return;
                startPos = previousSegment.topJoint.pos;
            }

            const endPos = segment.topJoint?.pos ?? kickstandHostKnot.pos;

            targets.push({
                id: segment.id,
                type: 'path',
                pathSegment: {
                    start: cloneVec3(startPos),
                    end: cloneVec3(endPos),
                    radius: segment.diameter / 2,
                    bezier:
                        segment.type === 'bezier'
                            ? { control1: segment.controlPoint1, control2: segment.controlPoint2 }
                            : undefined,
                },
            });
        });
    }

    return targets;
}

export function buildLeafConeSnapMeta(leaves: SupportState['leaves']): Map<string, LeafConeSnapMeta> {
    const map = new Map<string, LeafConeSnapMeta>();

    for (const leaf of Object.values(leaves)) {
        const cone = leaf.contactCone;
        if (!cone) continue;

        const profile = cone.profile;
        const contactRadiusMm = profile.contactDiameterMm / 2;
        const bodyRadiusMm = profile.bodyDiameterMm / 2;
        const lengthMm = profile.lengthMm;

        const coneAxis = normalizeVec3(cone.normal);
        const surfaceNormal = normalizeVec3(cone.surfaceNormal ?? cone.normal);

        let offset = 0;
        if (profile.type === 'disk') {
            offset = cone.diskLengthOverride ?? calculateDiskThickness(cone.surfaceNormal ?? cone.normal, cone.normal, profile);
        }

        const startPos = {
            x: cone.pos.x + surfaceNormal.x * offset,
            y: cone.pos.y + surfaceNormal.y * offset,
            z: cone.pos.z + surfaceNormal.z * offset,
        };

        const endPos = {
            x: startPos.x + coneAxis.x * lengthMm,
            y: startPos.y + coneAxis.y * lengthMm,
            z: startPos.z + coneAxis.z * lengthMm,
        };

        map.set(leaf.id, {
            modelId: leaf.modelId,
            cone,
            start: startPos,
            end: endPos,
            contactRadiusMm,
            bodyRadiusMm,
            lengthMm,
        });
    }

    return map;
}

export function buildLeafConePathSnapTargets(
    leafMeta: ReadonlyMap<string, LeafConeSnapMeta>,
    options: BuildLeafConePathSnapTargetsOptions = {}
): SnapTarget[] {
    const { excludeLeafIds, placementSurface } = options;
    const targets: SnapTarget[] = [];

    for (const [leafId, meta] of leafMeta.entries()) {
        if (excludeLeafIds?.has(leafId)) continue;
        if (!matchesPlacementSurfaceFilter(meta.cone.placementSurface, placementSurface)) continue;

        targets.push({
            id: leafId,
            type: 'path',
            pathSegment: {
                start: cloneVec3(meta.start),
                end: cloneVec3(meta.end),
                radius: meta.bodyRadiusMm,
            },
        });
    }

    return targets;
}

export function buildSnapTargetCandidateIndex(targets: readonly SnapTarget[]): Map<string, SnapTarget[]> {
    const map = new Map<string, SnapTarget[]>();
    for (const target of targets) {
        const existing = map.get(target.id);
        if (existing) {
            existing.push(target);
        } else {
            map.set(target.id, [target]);
        }
    }
    return map;
}
