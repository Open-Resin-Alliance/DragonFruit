import { SupportState, DragonfruitImportFormat, Trunk, Roots, Segment, BezierSegment, StraightSegment, Branch, Knot, Vec3, Leaf, Brace, Twig, Stick } from './types';
import { calculateBezierControlPoints, getBezierPointAtT, toVector3, toVec3 } from './Curves/BezierUtils';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints, calculateKnotPositionOnSegmentFromT } from './SupportPrimitives/Knot/knotUtils';
import type { SupportTipProfile } from './SupportPrimitives/ContactCone/types';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { JOINT_DIAMETER_OFFSET_MM } from './constants';
import { addSupportBrace, getSupportBraceSnapshot, removeSupportBrace, resetSupportBraceStore, transformSupportBracesForModel, updateSupportBrace } from './SupportTypes/SupportBrace/supportBraceStore';
import type { SupportBrace, SupportBraceBuildResult } from './SupportTypes/SupportBrace/types';
import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

const listeners = new Set<() => void>();

const initialState: SupportState = {
    roots: {},
    trunks: {},
    branches: {},
    leaves: {},
    twigs: {},
    sticks: {},
    braces: {},
    knots: {},
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
};

let state: SupportState = { ...initialState };

function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

export function removeTwig(twigId: string): { twig: Twig } | null {
    const existing = state.twigs[twigId];
    if (!existing) return null;

    const snapshot = { twig: deepClone(existing) };
    const { [twigId]: _, ...remainingTwigs } = state.twigs;

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (state.selectedId === twigId) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        twigs: remainingTwigs,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return snapshot;
}

export function removeStick(stickId: string): { stick: Stick } | null {
    const existing = state.sticks[stickId];
    if (!existing) return null;

    const snapshot = { stick: deepClone(existing) };
    const { [stickId]: _, ...remainingSticks } = state.sticks;

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (state.selectedId === stickId) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        sticks: remainingSticks,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return snapshot;
}

function resolveLowerSegmentIndex(segments: Segment[], jointId: string) {
    const byTop = segments.findIndex((seg) => seg.topJoint?.id === jointId);
    if (byTop !== -1) return byTop;
    const upper = segments.findIndex((seg) => seg.bottomJoint?.id === jointId);
    if (upper <= 0) return -1;
    return upper - 1;
}

function recomputeLeafContactConeAxisAndLength(
    tipPos: Vec3,
    surfaceNormal: Vec3,
    knotPos: Vec3,
    profile: SupportTipProfile
): { axis: Vec3; lengthMm: number; diskThicknessMm: number } {
    const tip = new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z);
    const sn = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
    const knot = new THREE.Vector3(knotPos.x, knotPos.y, knotPos.z);

    let axis = knot.clone().sub(tip);
    if (axis.lengthSq() < 0.000001) {
        axis.set(sn.x, sn.y, sn.z);
    }
    axis.normalize();

    let finalThickness = 0;
    let finalLength = Math.max(0.1, knot.distanceTo(tip));

    for (let i = 0; i < 3; i++) {
        const axisVec3 = { x: axis.x, y: axis.y, z: axis.z };
        const thickness = profile.type === 'disk'
            ? calculateDiskThickness(surfaceNormal, axisVec3, profile)
            : 0;
        finalThickness = thickness;

        const start = tip.clone().add(sn.clone().multiplyScalar(thickness));
        const coneVec = knot.clone().sub(start);
        const len = coneVec.length();
        if (len > 0.000001) {
            axis = coneVec.normalize();
            finalLength = Math.max(0.1, len);
        }
    }

    return {
        axis: { x: axis.x, y: axis.y, z: axis.z },
        lengthMm: finalLength,
        diskThicknessMm: finalThickness,
    };
}

function recomputeKnotDependentGeometry(
    leaves: Record<string, Leaf>,
    updatedKnotPosById: Record<string, Vec3>
): Record<string, Leaf> {
    const knotIds = Object.keys(updatedKnotPosById);
    if (knotIds.length === 0) return leaves;

    let changed = false;
    let nextLeaves = leaves;

    for (const leaf of Object.values(leaves)) {
        const knotPos = updatedKnotPosById[leaf.parentKnotId];
        if (!knotPos) continue;
        if (!leaf.contactCone?.surfaceNormal) continue;

        const { axis, lengthMm } = recomputeLeafContactConeAxisAndLength(
            leaf.contactCone.pos,
            leaf.contactCone.surfaceNormal,
            knotPos,
            leaf.contactCone.profile
        );

        const oldNormal = leaf.contactCone.normal;
        const oldLen = leaf.contactCone.profile.lengthMm;

        if (
            oldLen === lengthMm &&
            oldNormal.x === axis.x &&
            oldNormal.y === axis.y &&
            oldNormal.z === axis.z
        ) {
            continue;
        }

        if (!changed) {
            nextLeaves = { ...leaves };
            changed = true;
        }

        nextLeaves[leaf.id] = {
            ...leaf,
            contactCone: {
                ...leaf.contactCone,
                normal: axis,
                profile: {
                    ...leaf.contactCone.profile,
                    lengthMm,
                },
            },
        };
    }

    return nextLeaves;
}

function recomputeLeafConeKnotGeometry(
    leaves: Record<string, Leaf>,
    knots: Record<string, Knot>
): { knots: Record<string, Knot>; changed: boolean } {
    let changed = false;
    let nextKnots = knots;

    for (const knot of Object.values(knots)) {
        if (!knot.parentShaftId.startsWith('leafCone:')) continue;
        const leafId = knot.parentShaftId.slice('leafCone:'.length);
        const leaf = leaves[leafId];
        const cone = leaf?.contactCone;
        if (!leaf || !cone) continue;

        const socket = getFinalSocketPosition(cone);
        const axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
        if (axis.lengthSq() < 0.000001) continue;
        axis.normalize();

        const lenMm = cone.profile?.lengthMm ?? 0;
        if (lenMm <= 0.000001) continue;

        const start = new THREE.Vector3(socket.x, socket.y, socket.z).add(axis.clone().multiplyScalar(-lenMm));
        const tRaw = knot.t ?? 0;

        const minMm = 0.25;
        const minT = THREE.MathUtils.clamp(minMm / lenMm, 0, 0.99);
        const t = THREE.MathUtils.clamp(Math.max(tRaw, minT), minT, 1);

        const pos = start.clone().add(axis.multiplyScalar(t * lenMm));
        const contactDia = cone.profile?.contactDiameterMm ?? 0.4;
        const bodyDia = cone.profile?.bodyDiameterMm ?? 1.2;
        const hostDia = THREE.MathUtils.lerp(contactDia, bodyDia, t);

        const next: Knot = {
            ...knot,
            t,
            pos: { x: pos.x, y: pos.y, z: pos.z },
            diameter: hostDia + 0.1,
        };

        if (
            next.t !== knot.t ||
            next.pos.x !== knot.pos.x ||
            next.pos.y !== knot.pos.y ||
            next.pos.z !== knot.pos.z ||
            next.diameter !== knot.diameter
        ) {
            if (!changed) {
                nextKnots = { ...knots };
                changed = true;
            }
            nextKnots[knot.id] = next;
        }
    }

    return { knots: nextKnots, changed };
}

function computeClosestTOnSegmentFromPoint(
    point: Vec3,
    start: Vec3,
    end: Vec3,
    segment: Segment,
): number {
    if (segment.type === 'bezier') {
        const samples = 100;
        let bestT = 0;
        let bestDistSq = Number.POSITIVE_INFINITY;

        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const sample = getBezierPointAtT(start, segment.controlPoint1, segment.controlPoint2, end, t);
            const dx = sample.x - point.x;
            const dy = sample.y - point.y;
            const dz = sample.z - point.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestT = t;
            }
        }

        return bestT;
    }

    const a = toVector3(start);
    const b = toVector3(end);
    const p = toVector3(point);
    const ab = b.clone().sub(a);
    const abLenSq = ab.lengthSq();
    if (abLenSq <= 1e-8) return 0;

    const ap = p.sub(a);
    return THREE.MathUtils.clamp(ap.dot(ab) / abLenSq, 0, 1);
}

function normalizeLoadedKnotAndLeafGeometry(snapshot: Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'braces' | 'leaves' | 'knots'>): {
    knots: Record<string, Knot>;
    leaves: Record<string, Leaf>;
} {
    const trunkSegmentMap = new Map<string, { trunk: Trunk; segment: Segment; segmentIndex: number; root: Roots | undefined }>();
    for (const trunk of Object.values(snapshot.trunks)) {
        const root = snapshot.roots[trunk.rootId];
        trunk.segments.forEach((segment, segmentIndex) => {
            trunkSegmentMap.set(segment.id, { trunk, segment, segmentIndex, root });
        });
    }

    const branchSegmentMap = new Map<string, { branch: Branch; segment: Segment; segmentIndex: number }>();
    for (const branch of Object.values(snapshot.branches)) {
        branch.segments.forEach((segment, segmentIndex) => {
            branchSegmentMap.set(segment.id, { branch, segment, segmentIndex });
        });
    }

    const targetHostKnotIds = new Set<string>();
    const braceHostKnotIds = new Set<string>();
    for (const brace of Object.values(snapshot.braces)) {
        braceHostKnotIds.add(brace.startKnotId);
        braceHostKnotIds.add(brace.endKnotId);
        targetHostKnotIds.add(brace.startKnotId);
        targetHostKnotIds.add(brace.endKnotId);
    }
    for (const leaf of Object.values(snapshot.leaves)) {
        targetHostKnotIds.add(leaf.parentKnotId);
    }
    for (const branch of Object.values(snapshot.branches)) {
        targetHostKnotIds.add(branch.parentKnotId);
    }

    const nextKnots = { ...snapshot.knots };
    const changedHostPosById: Record<string, Vec3> = {};

    const maxPasses = 4;
    for (let pass = 0; pass < maxPasses; pass++) {
        let changedThisPass = false;

        for (const knotId of targetHostKnotIds) {
            const knot = nextKnots[knotId];
            if (!knot) continue;
            if (knot.parentShaftId.startsWith('leafCone:') || knot.parentShaftId.startsWith('braceSegment:')) continue;

            let segment: Segment | null = null;
            let endpoints: { start: Vec3; end: Vec3 } | null = null;

            const trunkRef = trunkSegmentMap.get(knot.parentShaftId);
            if (trunkRef?.root) {
                segment = trunkRef.segment;
                endpoints = getTrunkSegmentEndpoints(
                    trunkRef.trunk,
                    trunkRef.segment,
                    trunkRef.segmentIndex,
                    trunkRef.root,
                );
            }

            if (!segment || !endpoints) {
                const branchRef = branchSegmentMap.get(knot.parentShaftId);
                if (branchRef) {
                    const parentKnot = nextKnots[branchRef.branch.parentKnotId] ?? snapshot.knots[branchRef.branch.parentKnotId];
                    if (parentKnot) {
                        segment = branchRef.segment;
                        endpoints = getBranchSegmentEndpoints(
                            branchRef.branch,
                            branchRef.segment,
                            branchRef.segmentIndex,
                            parentKnot,
                        );
                    }
                }
            }

            if (!segment || !endpoints) continue;

            const t = computeClosestTOnSegmentFromPoint(knot.pos, endpoints.start, endpoints.end, segment);
            const computedPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, t);
            const computedDiameter = segment.diameter + JOINT_DIAMETER_OFFSET_MM;

            const dx = computedPos.x - knot.pos.x;
            const dy = computedPos.y - knot.pos.y;
            const dz = computedPos.z - knot.pos.z;
            const reprojectionDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const isEndpointProjection = t <= 1e-4 || t >= 1 - 1e-4;
            const preserveAuthoredBracePos =
                braceHostKnotIds.has(knot.id) &&
                isEndpointProjection &&
                reprojectionDistance > 2;

            if (preserveAuthoredBracePos) {
                if (knot.diameter !== computedDiameter) {
                    nextKnots[knot.id] = {
                        ...knot,
                        diameter: computedDiameter,
                    };
                    changedThisPass = true;
                }
                continue;
            }

            const posChanged =
                computedPos.x !== knot.pos.x ||
                computedPos.y !== knot.pos.y ||
                computedPos.z !== knot.pos.z;
            const tChanged = knot.t !== t;
            const diameterChanged = knot.diameter !== computedDiameter;
            if (!posChanged && !tChanged && !diameterChanged) continue;

            nextKnots[knot.id] = {
                ...knot,
                t,
                pos: computedPos,
                diameter: computedDiameter,
            };
            if (posChanged) {
                changedHostPosById[knot.id] = computedPos;
            }
            changedThisPass = true;
        }

        if (!changedThisPass) break;
    }

    let nextLeaves = snapshot.leaves;
    if (Object.keys(changedHostPosById).length > 0) {
        nextLeaves = recomputeKnotDependentGeometry(nextLeaves, changedHostPosById);
    }

    const leafCone1 = recomputeLeafConeKnotGeometry(nextLeaves, nextKnots);
    const braceSeg1 = recomputeBraceSegmentKnotGeometry(snapshot.braces, leafCone1.knots);

    const changedByBrace1 = getChangedKnotPositions(leafCone1.knots, braceSeg1.knots);

    let finalKnots = braceSeg1.knots;
    if (Object.keys(changedByBrace1).length > 0) {
        nextLeaves = recomputeKnotDependentGeometry(nextLeaves, changedByBrace1);
        const leafCone2 = recomputeLeafConeKnotGeometry(nextLeaves, finalKnots);
        const braceSeg2 = recomputeBraceSegmentKnotGeometry(snapshot.braces, leafCone2.knots);
        finalKnots = braceSeg2.knots;
    }

    return { knots: finalKnots, leaves: nextLeaves };
}

function getChangedKnotPositions(prev: Record<string, Knot>, next: Record<string, Knot>): Record<string, Vec3> {
    const changed: Record<string, Vec3> = {};
    for (const [id, nk] of Object.entries(next)) {
        const pk = prev[id];
        if (!pk) continue;
        if (pk.pos.x !== nk.pos.x || pk.pos.y !== nk.pos.y || pk.pos.z !== nk.pos.z) {
            changed[id] = nk.pos;
        }
    }
    return changed;
}

function recomputeBraceSegmentKnotGeometry(
    braces: Record<string, Brace>,
    knots: Record<string, Knot>
): { knots: Record<string, Knot>; changed: boolean } {
    let changed = false;
    let nextKnots = knots;

    for (const knot of Object.values(knots)) {
        if (!knot.parentShaftId.startsWith('braceSegment:')) continue;
        const braceId = knot.parentShaftId.slice('braceSegment:'.length);
        const brace = braces[braceId];
        if (!brace) continue;

        const startKnot = knots[brace.startKnotId];
        const endKnot = knots[brace.endKnotId];
        if (!startKnot || !endKnot) continue;

        if (knot.t === undefined) continue;
        const t = THREE.MathUtils.clamp(knot.t, 0, 1);

        let pos: THREE.Vector3;
        if (brace.curve?.type === 'bezier') {
            const p = getBezierPointAtT(
                startKnot.pos,
                brace.curve.controlPoint1,
                brace.curve.controlPoint2,
                endKnot.pos,
                t
            );
            pos = new THREE.Vector3(p.x, p.y, p.z);
        } else {
            const a = new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z);
            const b = new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z);
            pos = a.clone().lerp(b, t);
        }

        const startDia = Math.max(
            0.001,
            (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
        );
        const endDia = Math.max(
            0.001,
            (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
        );
        const hostDia = THREE.MathUtils.lerp(startDia, endDia, t);

        const next: Knot = {
            ...knot,
            t,
            pos: { x: pos.x, y: pos.y, z: pos.z },
            diameter: hostDia + JOINT_DIAMETER_OFFSET_MM,
        };

        if (
            next.t !== knot.t ||
            next.pos.x !== knot.pos.x ||
            next.pos.y !== knot.pos.y ||
            next.pos.z !== knot.pos.z ||
            next.diameter !== knot.diameter
        ) {
            if (!changed) {
                nextKnots = { ...knots };
                changed = true;
            }
            nextKnots[knot.id] = next;
        }
    }

    return { knots: nextKnots, changed };
}

export function removeJoint(trunkId: string, jointId: string): { before: Trunk; after: Trunk } | null {
    const trunk = state.trunks[trunkId];
    if (!trunk) return null;

    // Prevent deletion of the top joint that connects to the contact cone
    if (trunk.contactCone?.socketJointId && trunk.contactCone.socketJointId === jointId) {
        console.warn('Cannot delete the top joint that connects to the contact cone');
        return null;
    }

    const lowerIndex = resolveLowerSegmentIndex(trunk.segments, jointId);
    if (lowerIndex === -1) return null;

    const before = deepClone(trunk);
    const after = deepClone(trunk);

    const segments = after.segments;
    const lowerSegment = segments[lowerIndex];
    if (!lowerSegment) return null;

    const nextIndex = lowerIndex + 1;
    const upperSegment = nextIndex < segments.length ? segments[nextIndex] : undefined;
    const removedSegmentId = upperSegment?.id ?? null;

    if (upperSegment) {
        lowerSegment.topJoint = upperSegment.topJoint ? deepClone(upperSegment.topJoint) : undefined;
        segments.splice(nextIndex, 1);
    } else {
        lowerSegment.topJoint = undefined;
    }

    // If we removed a segment, any knots attached to that removed segment must be rebound
    // to the merged segment so they stay connected.
    if (removedSegmentId) {
        const root = state.roots[trunk.rootId];
        const mergedSegmentId = after.segments[lowerIndex]?.id;
        const mergedSegment = after.segments[lowerIndex];

        if (root && mergedSegmentId && mergedSegment) {
            const endpoints = getTrunkSegmentEndpoints(after, mergedSegment, lowerIndex, root);
            if (endpoints) {
                const startVec = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                const endVec = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);

                const updatedKnots: Record<string, Knot> = { ...state.knots };
                let knotsChanged = false;

                for (const knot of Object.values(state.knots)) {
                    if (knot.parentShaftId !== removedSegmentId) continue;

                    // Preserve approximate world position by re-projecting onto the merged segment
                    // and then using that t going forward.
                    const knotPosVec = new THREE.Vector3(knot.pos.x, knot.pos.y, knot.pos.z);
                    const segLen = startVec.distanceTo(endVec);
                    let t = 0;
                    if (segLen > 0.000001) {
                        const dir = endVec.clone().sub(startVec);
                        const lenSq = dir.lengthSq();
                        if (lenSq > 0.000001) {
                            const v = knotPosVec.clone().sub(startVec);
                            t = THREE.MathUtils.clamp(v.dot(dir) / lenSq, 0, 1);
                        }
                    }

                    const newPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, mergedSegment, t);
                    updatedKnots[knot.id] = {
                        ...knot,
                        parentShaftId: mergedSegmentId,
                        t,
                        pos: newPos,
                    };
                    knotsChanged = true;
                }

                if (knotsChanged) {
                    state = { ...state, knots: updatedKnots };
                }
            }
        }
    }

    // Route through updateTrunk so ALL knots attached to this trunk stay connected after joint removal.
    updateTrunk(after);

    return {
        before,
        after: deepClone(after),
    };
}

export function removeBranchJoint(branchId: string, jointId: string): { before: Branch; after: Branch } | null {
    const branch = state.branches[branchId];
    if (!branch) return null;

    // Prevent deletion of the top joint that connects to the contact cone
    if (branch.contactCone?.socketJointId && branch.contactCone.socketJointId === jointId) {
        console.warn('Cannot delete the top joint that connects to the contact cone');
        return null;
    }

    const lowerIndex = resolveLowerSegmentIndex(branch.segments, jointId);
    if (lowerIndex === -1) return null;

    const before = deepClone(branch);
    const after = deepClone(branch);

    const segments = after.segments;
    const lowerSegment = segments[lowerIndex];
    if (!lowerSegment) return null;

    const nextIndex = lowerIndex + 1;
    const upperSegment = nextIndex < segments.length ? segments[nextIndex] : undefined;
    const removedSegmentId = upperSegment?.id ?? null;

    if (upperSegment) {
        lowerSegment.topJoint = upperSegment.topJoint ? deepClone(upperSegment.topJoint) : undefined;
        segments.splice(nextIndex, 1);
    } else {
        lowerSegment.topJoint = undefined;
    }

    if (removedSegmentId) {
        const parentKnot = state.knots[branch.parentKnotId];
        const mergedSegmentId = after.segments[lowerIndex]?.id;
        const mergedSegment = after.segments[lowerIndex];

        if (parentKnot && mergedSegmentId && mergedSegment) {
            const endpoints = getBranchSegmentEndpoints(after, mergedSegment, lowerIndex, parentKnot);
            if (endpoints) {
                const startVec = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                const endVec = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);

                const updatedKnots: Record<string, Knot> = { ...state.knots };
                let knotsChanged = false;

                for (const knot of Object.values(state.knots)) {
                    if (knot.parentShaftId !== removedSegmentId) continue;

                    const knotPosVec = new THREE.Vector3(knot.pos.x, knot.pos.y, knot.pos.z);
                    const segLen = startVec.distanceTo(endVec);
                    let t = 0;
                    if (segLen > 0.000001) {
                        const dir = endVec.clone().sub(startVec);
                        const lenSq = dir.lengthSq();
                        if (lenSq > 0.000001) {
                            const v = knotPosVec.clone().sub(startVec);
                            t = THREE.MathUtils.clamp(v.dot(dir) / lenSq, 0, 1);
                        }
                    }

                    const newPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, mergedSegment, t);
                    updatedKnots[knot.id] = {
                        ...knot,
                        parentShaftId: mergedSegmentId,
                        t,
                        pos: newPos,
                    };
                    knotsChanged = true;
                }

                if (knotsChanged) {
                    state = { ...state, knots: updatedKnots };
                }
            }
        }
    }

    updateBranch(after);

    return {
        before,
        after: deepClone(after),
    };
}

export type RemoveJointByIdResult =
    | { kind: 'trunk'; trunkId: string; before: Trunk; after: Trunk }
    | { kind: 'branch'; branchId: string; before: Branch; after: Branch };

export function removeJointById(jointId: string): RemoveJointByIdResult | null {
    for (const [trunkId, trunk] of Object.entries(state.trunks)) {
        const hasJoint = trunk.segments.some(
            (seg) => seg.topJoint?.id === jointId || seg.bottomJoint?.id === jointId
        );
        if (!hasJoint) continue;
        const result = removeJoint(trunkId, jointId);
        if (result) {
            return { kind: 'trunk', trunkId, ...result };
        }
    }

    for (const [branchId, branch] of Object.entries(state.branches)) {
        const hasJoint = branch.segments.some(
            (seg) => seg.topJoint?.id === jointId || seg.bottomJoint?.id === jointId
        );
        if (!hasJoint) continue;
        const result = removeBranchJoint(branchId, jointId);
        if (result) {
            return { kind: 'branch', branchId, ...result };
        }
    }

    return null;
}

function notify() {
    listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSnapshot() {
    return state;
}

export function setSnapshot(next: SupportState) {
    state = next;
    notify();
}

function transformVec3(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const v = new THREE.Vector3(value.x, value.y, value.z).applyMatrix4(matrix);
    return { x: v.x, y: v.y, z: v.z };
}

function transformDirection(value: Vec3, normalMatrix: THREE.Matrix3): Vec3 {
    const v = new THREE.Vector3(value.x, value.y, value.z).applyMatrix3(normalMatrix);
    if (v.lengthSq() <= 1e-12) return value;
    v.normalize();
    return { x: v.x, y: v.y, z: v.z };
}

function transformJoint(joint: import('./types').Joint | undefined, matrix: THREE.Matrix4) {
    if (!joint) return joint;
    return {
        ...joint,
        pos: transformVec3(joint.pos, matrix),
    };
}

function transformSegment(segment: Segment, matrix: THREE.Matrix4, normalMatrix: THREE.Matrix3): Segment {
    const next: Segment = {
        ...segment,
        topJoint: transformJoint(segment.topJoint, matrix),
        bottomJoint: transformJoint(segment.bottomJoint, matrix),
    };

    if (segment.type === 'bezier') {
        next.controlPoint1 = transformVec3(segment.controlPoint1, matrix);
        next.controlPoint2 = transformVec3(segment.controlPoint2, matrix);
        next.startTangent = transformDirection(segment.startTangent, normalMatrix);
        next.endTangent = transformDirection(segment.endTangent, normalMatrix);
    }

    return next;
}

function transformContactCone(
    cone: import('./SupportPrimitives/ContactCone/types').ContactCone,
    matrix: THREE.Matrix4,
    normalMatrix: THREE.Matrix3,
) {
    return {
        ...cone,
        pos: transformVec3(cone.pos, matrix),
        normal: transformDirection(cone.normal, normalMatrix),
        surfaceNormal: cone.surfaceNormal ? transformDirection(cone.surfaceNormal, normalMatrix) : cone.surfaceNormal,
    };
}

function transformContactDisk(
    disk: import('./types').ContactDisk,
    matrix: THREE.Matrix4,
    normalMatrix: THREE.Matrix3,
) {
    return {
        ...disk,
        pos: transformVec3(disk.pos, matrix),
        surfaceNormal: transformDirection(disk.surfaceNormal, normalMatrix),
        coneAxis: transformDirection(disk.coneAxis, normalMatrix),
    };
}

function transformsRoughlyEqual(a: THREE.Matrix4, b: THREE.Matrix4, epsilon = 1e-8) {
    const ae = a.elements;
    const be = b.elements;
    for (let i = 0; i < 16; i += 1) {
        if (Math.abs(ae[i] - be[i]) > epsilon) return false;
    }
    return true;
}

export function transformSupportsForModel(
    modelId: string,
    beforeTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
    afterTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
) {
    if (!modelId) return;

    const beforeMatrix = new THREE.Matrix4().compose(
        beforeTransform.position.clone(),
        quaternionFromGlobalEuler(beforeTransform.rotation),
        beforeTransform.scale.clone(),
    );
    const afterMatrix = new THREE.Matrix4().compose(
        afterTransform.position.clone(),
        quaternionFromGlobalEuler(afterTransform.rotation),
        afterTransform.scale.clone(),
    );

    if (transformsRoughlyEqual(beforeMatrix, afterMatrix)) {
        return;
    }

    const deltaMatrix = afterMatrix.clone().multiply(beforeMatrix.clone().invert());
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    let changed = false;
    let nextRoots = state.roots;
    let nextTrunks = state.trunks;
    let nextBranches = state.branches;
    let nextLeaves = state.leaves;
    let nextTwigs = state.twigs;
    let nextSticks = state.sticks;
    let nextBraces = state.braces;
    let nextKnots = state.knots;

    const touchedSegmentIds = new Set<string>();
    const touchedKnotIds = new Set<string>();
    const touchedLeafIds = new Set<string>();
    const touchedBraceIds = new Set<string>();

    for (const root of Object.values(state.roots)) {
        if (root.modelId !== modelId) continue;
        if (!changed) {
            nextRoots = { ...state.roots };
            changed = true;
        }
        nextRoots[root.id] = {
            ...root,
            transform: {
                ...root.transform,
                pos: transformVec3(root.transform.pos, deltaMatrix),
            },
        };
    }

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.modelId !== modelId) continue;
        if (!changed) {
            nextTrunks = { ...state.trunks };
            changed = true;
        }

        trunk.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        const nextTrunk: Trunk = {
            ...trunk,
            segments: trunk.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: trunk.contactCone ? transformContactCone(trunk.contactCone, deltaMatrix, normalMatrix) : trunk.contactCone,
        };

        nextTrunks[trunk.id] = nextTrunk;
    }

    for (const branch of Object.values(state.branches)) {
        if (branch.modelId !== modelId) continue;
        if (!changed) {
            nextBranches = { ...state.branches };
            changed = true;
        }

        touchedKnotIds.add(branch.parentKnotId);
        branch.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        const nextBranch: Branch = {
            ...branch,
            segments: branch.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: branch.contactCone ? transformContactCone(branch.contactCone, deltaMatrix, normalMatrix) : branch.contactCone,
        };

        nextBranches[branch.id] = nextBranch;
    }

    for (const leaf of Object.values(state.leaves)) {
        if (leaf.modelId !== modelId) continue;
        if (!changed) {
            nextLeaves = { ...state.leaves };
            changed = true;
        }

        touchedKnotIds.add(leaf.parentKnotId);
        touchedLeafIds.add(leaf.id);
        nextLeaves[leaf.id] = {
            ...leaf,
            contactCone: transformContactCone(leaf.contactCone, deltaMatrix, normalMatrix),
        };
    }

    for (const twig of Object.values(state.twigs)) {
        if (twig.modelId !== modelId) continue;
        if (!changed) {
            nextTwigs = { ...state.twigs };
            changed = true;
        }

        twig.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        nextTwigs[twig.id] = {
            ...twig,
            segments: twig.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactDiskA: transformContactDisk(twig.contactDiskA, deltaMatrix, normalMatrix),
            contactDiskB: transformContactDisk(twig.contactDiskB, deltaMatrix, normalMatrix),
        };
    }

    for (const stick of Object.values(state.sticks)) {
        if (stick.modelId !== modelId) continue;
        if (!changed) {
            nextSticks = { ...state.sticks };
            changed = true;
        }

        stick.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        nextSticks[stick.id] = {
            ...stick,
            segments: stick.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactConeA: transformContactCone(stick.contactConeA, deltaMatrix, normalMatrix),
            contactConeB: transformContactCone(stick.contactConeB, deltaMatrix, normalMatrix),
        };
    }

    for (const brace of Object.values(state.braces)) {
        if (brace.modelId !== modelId) continue;
        if (!changed) {
            nextBraces = { ...state.braces };
            changed = true;
        }

        touchedKnotIds.add(brace.startKnotId);
        touchedKnotIds.add(brace.endKnotId);
        touchedBraceIds.add(brace.id);

        nextBraces[brace.id] = {
            ...brace,
            curve: brace.curve
                ? {
                    ...brace.curve,
                    controlPoint1: transformVec3(brace.curve.controlPoint1, deltaMatrix),
                    controlPoint2: transformVec3(brace.curve.controlPoint2, deltaMatrix),
                    startTangent: transformDirection(brace.curve.startTangent, normalMatrix),
                    endTangent: transformDirection(brace.curve.endTangent, normalMatrix),
                }
                : brace.curve,
        };
    }

    for (const knot of Object.values(state.knots)) {
        const parentShaftId = knot.parentShaftId;
        const isLeafConeKnot = parentShaftId.startsWith('leafCone:')
            && touchedLeafIds.has(parentShaftId.slice('leafCone:'.length));
        const isBraceSegmentKnot = parentShaftId.startsWith('braceSegment:')
            && touchedBraceIds.has(parentShaftId.slice('braceSegment:'.length));
        const shouldTransform = touchedKnotIds.has(knot.id)
            || touchedSegmentIds.has(parentShaftId)
            || isLeafConeKnot
            || isBraceSegmentKnot;

        if (!shouldTransform) continue;

        if (!changed) {
            nextKnots = { ...state.knots };
            changed = true;
        }

        nextKnots[knot.id] = {
            ...knot,
            pos: transformVec3(knot.pos, deltaMatrix),
        };
    }

    if (changed) {
        state = {
            ...state,
            roots: nextRoots,
            trunks: nextTrunks,
            branches: nextBranches,
            leaves: nextLeaves,
            twigs: nextTwigs,
            sticks: nextSticks,
            braces: nextBraces,
            knots: nextKnots,
        };
        notify();
    }

    transformSupportBracesForModel(modelId, deltaMatrix);
}

export function removeRootById(rootId: string): Roots | null {
    const root = state.roots[rootId];
    if (!root) return null;

    const nextRoots = { ...state.roots };
    delete nextRoots[rootId];

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (state.selectedId === rootId) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        roots: nextRoots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return deepClone(root);
}

// --- Actions ---

export function toggleSegmentCurve(segmentId: string) {
    if (segmentId.startsWith('braceSegment:')) {
        const braceId = segmentId.slice('braceSegment:'.length);
        const brace = state.braces[braceId];
        if (!brace) return;

        const startKnot = state.knots[brace.startKnotId];
        const endKnot = state.knots[brace.endKnotId];
        if (!startKnot || !endKnot) return;

        const newBrace = deepClone(brace);
        if (newBrace.curve?.type === 'bezier') {
            delete (newBrace as any).curve;
        } else {
            const startPos = toVector3(startKnot.pos);
            const endPos = toVector3(endKnot.pos);
            const dir = endPos.clone().sub(startPos).normalize();
            if (dir.lengthSq() === 0) dir.set(0, 0, 1);

            const startTangent = toVec3(dir);
            const endTangent = toVec3(dir);
            const tension = 0.5;
            const bias = 0.5;
            const [cp1, cp2] = calculateBezierControlPoints(startKnot.pos, endKnot.pos, startTangent, endTangent, tension, bias);

            newBrace.curve = {
                type: 'bezier',
                controlPoint1: cp1,
                controlPoint2: cp2,
                startTangent,
                endTangent,
                tension,
                bias,
                resolution: 16,
            };
        }

        updateBrace(newBrace);
        return;
    }

    // Find the segment in trunks/branches/twigs/sticks
    let targetTrunkId: string | null = null;
    let targetBranchId: string | null = null;
    let targetTwigId: string | null = null;
    let targetStickId: string | null = null;
    let targetSupportBraceId: string | null = null;
    let targetSegmentIndex = -1;
    let container: Trunk | Branch | Twig | Stick | SupportBrace | null = null;

    // Search Trunks
    for (const t of Object.values(state.trunks)) {
        const idx = t.segments.findIndex(s => s.id === segmentId);
        if (idx !== -1) {
            targetTrunkId = t.id;
            targetSegmentIndex = idx;
            container = t;
            break;
        }
    }

    // Search Branches if not found
    if (!container) {
        for (const b of Object.values(state.branches)) {
            const idx = b.segments.findIndex(s => s.id === segmentId);
            if (idx !== -1) {
                targetBranchId = b.id;
                targetSegmentIndex = idx;
                container = b;
                break;
            }
        }
    }

    // Search Twigs if not found
    if (!container) {
        for (const t of Object.values(state.twigs)) {
            const idx = t.segments.findIndex(s => s.id === segmentId);
            if (idx !== -1) {
                targetTwigId = t.id;
                targetSegmentIndex = idx;
                container = t;
                break;
            }
        }
    }

    // Search Sticks if not found
    if (!container) {
        for (const spt of Object.values(state.sticks)) {
            const idx = spt.segments.findIndex(s => s.id === segmentId);
            if (idx !== -1) {
                targetStickId = spt.id;
                targetSegmentIndex = idx;
                container = spt;
                break;
            }
        }
    }

    // Search Support Braces if not found
    if (!container) {
        const supportBraces = Object.values(getSupportBraceSnapshot().supportBraces);
        for (const supportBrace of supportBraces) {
            const idx = supportBrace.segments.findIndex(s => s.id === segmentId);
            if (idx !== -1) {
                targetSupportBraceId = supportBrace.id;
                targetSegmentIndex = idx;
                container = supportBrace;
                break;
            }
        }
    }

    if (!container || targetSegmentIndex === -1) return;

    // Create deep clone
    const newContainer = deepClone(container);
    const segment = newContainer.segments[targetSegmentIndex];

    if (segment.type === 'bezier') {
        // Convert to Straight
        const straight: StraightSegment = {
            id: segment.id,
            diameter: segment.diameter,
            topJoint: segment.topJoint,
            bottomJoint: segment.bottomJoint,
            type: 'straight'
        };
        newContainer.segments[targetSegmentIndex] = straight;
    } else {
        // Convert to Bezier

        // Get Start Position (Approximation for initialization)
        let startPos: THREE.Vector3;
        if (targetSegmentIndex === 0) {
            if (targetTrunkId) {
                const root = state.roots[(newContainer as Trunk).rootId];
                if (root) {
                    const startZ = root.transform.pos.z + root.diskHeight + root.coneHeight;
                    startPos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, startZ);
                } else {
                    startPos = new THREE.Vector3();
                }
            } else if (targetSupportBraceId) {
                const root = state.roots[(newContainer as SupportBrace).rootId];
                if (root) {
                    const startZ = root.transform.pos.z + root.diskHeight + root.coneHeight;
                    startPos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, startZ);
                } else {
                    startPos = new THREE.Vector3();
                }
            } else if (targetBranchId) {
                const knot = state.knots[(newContainer as Branch).parentKnotId];
                startPos = knot && knot.pos ? toVector3(knot.pos) : new THREE.Vector3();
            } else {
                startPos = segment.bottomJoint ? toVector3(segment.bottomJoint.pos) : new THREE.Vector3();
            }
        } else {
            const prevSeg = newContainer.segments[targetSegmentIndex - 1];
            // Start is prevSeg.topJoint.pos
            if (prevSeg.topJoint) {
                startPos = toVector3(prevSeg.topJoint.pos);
            } else {
                startPos = new THREE.Vector3(); // Fallback
            }
        }

        // Get End Position (Approximation)
        let endPos: THREE.Vector3;
        if (segment.topJoint) {
            endPos = toVector3(segment.topJoint.pos);
        } else if (targetSupportBraceId) {
            const hostKnot = state.knots[(newContainer as SupportBrace).hostKnotId];
            endPos = hostKnot ? toVector3(hostKnot.pos) : startPos.clone().add(new THREE.Vector3(0, 0, 10));
        } else if ((newContainer as Trunk).contactCone) {
            const cone = (newContainer as Trunk).contactCone!;
            endPos = toVector3(cone.pos);
        } else {
            endPos = startPos.clone().add(new THREE.Vector3(0, 0, 10));
        }

        // Calculate Tangents (Straight line)
        const dir = endPos.clone().sub(startPos).normalize();
        // Handle zero length case
        if (dir.lengthSq() === 0) dir.set(0, 0, 1);

        // Calculate Control Points
        const [cp1, cp2] = calculateBezierControlPoints(
            toVec3(startPos),
            toVec3(endPos),
            toVec3(dir),
            toVec3(dir),
            0.5
        );

        const bezier: BezierSegment = {
            id: segment.id,
            diameter: segment.diameter,
            topJoint: segment.topJoint,
            bottomJoint: segment.bottomJoint,
            type: 'bezier',
            controlPoint1: cp1,
            controlPoint2: cp2,
            startTangent: toVec3(dir),
            endTangent: toVec3(dir),
            tension: 0.5,
            bias: 0.5,
            resolution: 16
        };
        newContainer.segments[targetSegmentIndex] = bezier;
    }

    if (targetTrunkId) {
        updateTrunk(newContainer as Trunk);
    } else if (targetBranchId) {
        updateBranch(newContainer as Branch);
    } else if (targetTwigId) {
        updateTwig(newContainer as Twig);
    } else if (targetStickId) {
        updateStick(newContainer as Stick);
    } else if (targetSupportBraceId) {
        updateSupportBrace(newContainer as SupportBrace);
    }
}

export function resetStore() {
    state = { ...initialState };
    resetSupportBraceStore();
    notify();
}

/**
 * Loads support data from the DragonFruit Interchange Format (e.g. from Lychee conversion).
 */
export function loadFromLychee(data: DragonfruitImportFormat) {
    // Reset first
    resetSupportBraceStore();

    const newState: SupportState = {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
        selectedCategory: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };

    // Populate Roots
    data.roots.forEach(r => {
        newState.roots[r.id] = r;
    });

    // Populate Trunks
    data.trunks.forEach(t => {
        newState.trunks[t.id] = t;
    });

    // Populate Branches
    data.branches.forEach(b => {
        newState.branches[b.id] = b;
    });

    // Populate Leaves
    data.leaves.forEach(l => {
        newState.leaves[l.id] = l;
    });

    // Populate Twigs
    if (data.twigs) {
        data.twigs.forEach((t) => {
            newState.twigs[t.id] = t;
        });
    }

    // Populate Sticks
    if (data.sticks) {
        data.sticks.forEach((s) => {
            newState.sticks[s.id] = s;
        });
    }

    // Populate Braces
    data.braces.forEach(br => {
        newState.braces[br.id] = br;
    });

    // Populate Knots
    if (data.knots) {
        data.knots.forEach(k => {
            newState.knots[k.id] = k;
        });
    }

    for (const supportBraceBuild of data.supportBraces ?? []) {
        addSupportBrace(supportBraceBuild);
    }

    const normalized = normalizeLoadedKnotAndLeafGeometry(newState);
    newState.knots = normalized.knots;
    newState.leaves = normalized.leaves;

    state = newState;
    console.log('[SupportStore] Loaded from Lychee:', {
        roots: Object.keys(state.roots).length,
        trunks: Object.keys(state.trunks).length,
        branches: Object.keys(state.branches).length,
        leaves: Object.keys(state.leaves).length,
        twigs: Object.keys(state.twigs).length,
        sticks: Object.keys(state.sticks).length,
        braces: Object.keys(state.braces).length,
        knots: Object.keys(state.knots).length,
        supportBraces: Object.keys(getSupportBraceSnapshot().supportBraces).length,
    });
    notify();
}

export function setSelectedId(id: string | null) {
    if (state.selectedId === id) return;

    let category: 'trunk' | 'branch' | 'leaf' | 'twig' | 'stick' | 'brace' | 'root' | 'joint' | 'knot' | 'segment' | null = null;

    if (id) {
        const supportBraces = Object.values(getSupportBraceSnapshot().supportBraces);

        if (id.startsWith('braceSegment:')) category = 'segment';
        if (state.roots[id]) category = 'root';
        else if (state.trunks[id]) category = 'trunk';
        else if (state.branches[id]) category = 'branch';
        else if (state.leaves[id]) category = 'leaf';
        else if (state.twigs[id]) category = 'twig';
        else if (state.sticks[id]) category = 'stick';
        else if (state.braces[id]) category = 'brace';
        else if (supportBraces.some((supportBrace) => supportBrace.id === id)) category = 'brace';
        else if (state.knots[id]) category = 'knot';
        else {
            // Check for joints inside trunks
            let foundJoint = false;
            const trunks = Object.values(state.trunks);
            for (const t of trunks) {
                for (const s of t.segments) {
                    if (s.topJoint?.id === id || s.bottomJoint?.id === id) {
                        foundJoint = true;
                        break;
                    }
                }
                if (foundJoint) break;
            }

            if (foundJoint) {
                category = 'joint';
            } else {
                // Check for joints inside branches
                const branches = Object.values(state.branches);
                for (const b of branches) {
                    for (const s of b.segments) {
                        if (s.topJoint?.id === id || s.bottomJoint?.id === id) {
                            foundJoint = true;
                            break;
                        }
                    }
                    if (foundJoint) break;
                }
                if (foundJoint) category = 'joint';
            }

            if (!category) {
                for (const supportBrace of supportBraces) {
                    const hasJoint = supportBrace.segments.some(s => s.topJoint?.id === id || s.bottomJoint?.id === id);
                    if (hasJoint) {
                        foundJoint = true;
                        break;
                    }
                }
                if (foundJoint) category = 'joint';
            }

            if (!category) {
                const twigs = Object.values(state.twigs);
                for (const t of twigs) {
                    for (const s of t.segments) {
                        if (s.topJoint?.id === id || s.bottomJoint?.id === id) {
                            foundJoint = true;
                            break;
                        }
                    }
                    if (foundJoint) break;
                }
                if (foundJoint) category = 'joint';
            }

            if (!category) {
                const sticks = Object.values(state.sticks);
                for (const spt of sticks) {
                    for (const s of spt.segments) {
                        if (s.topJoint?.id === id || s.bottomJoint?.id === id) {
                            foundJoint = true;
                            break;
                        }
                    }
                    if (foundJoint) break;
                }
                if (foundJoint) category = 'joint';
            }

            // Check for segments
            if (!category) {
                const trunks = Object.values(state.trunks);
                for (const t of trunks) {
                    if (t.segments.some(s => s.id === id)) {
                        category = 'segment';
                        break;
                    }
                }
            }

            if (!category) {
                const branches = Object.values(state.branches);
                for (const b of branches) {
                    if (b.segments.some(s => s.id === id)) {
                        category = 'segment';
                        break;
                    }
                }
            }

            if (!category) {
                const twigs = Object.values(state.twigs);
                for (const t of twigs) {
                    if (t.segments.some(s => s.id === id)) {
                        category = 'segment';
                        break;
                    }
                }
            }

            if (!category) {
                const sticks = Object.values(state.sticks);
                for (const spt of sticks) {
                    if (spt.segments.some(s => s.id === id)) {
                        category = 'segment';
                        break;
                    }
                }
            }

            if (!category) {
                for (const supportBrace of supportBraces) {
                    if (supportBrace.segments.some(s => s.id === id)) {
                        category = 'segment';
                        break;
                    }
                }
            }
        }
    }

    state = { ...state, selectedId: id, selectedCategory: category };
    notify();
}

export function setHoveredId(id: string | null) {
    if (state.hoveredId === id) return;
    state = { ...state, hoveredId: id };
    notify();
}

export function setHoveredCategory(category: 'model' | 'support' | 'segment' | 'joint' | 'knot' | 'raft' | 'gizmo' | 'none') {
    if (state.hoveredCategory === category) return;
    state = { ...state, hoveredCategory: category };
    notify();
}

export function setInteractionWarning(warning: import('./types').WarningCode | null) {
    if (state.interactionWarning === warning) return;
    state = { ...state, interactionWarning: warning };
    notify();
}

export function addRoot(root: Roots) {
    state = {
        ...state,
        roots: { ...state.roots, [root.id]: root }
    };
    notify();
}

export function addTrunk(trunk: Trunk) {
    state = {
        ...state,
        trunks: { ...state.trunks, [trunk.id]: trunk }
    };
    notify();
}

export function updateTrunk(trunk: Trunk) {
    // Update trunk
    const nextTrunks = { ...state.trunks, [trunk.id]: trunk };

    // Update any knots attached to this trunk's segments
    const root = state.roots[trunk.rootId];
    let nextKnots = state.knots;
    let nextLeaves = state.leaves;
    let knotsChanged = false;

    if (root) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        const updatedKnotPosById: Record<string, Vec3> = {};

        for (const knot of Object.values(state.knots)) {
            // Find if this knot is attached to one of this trunk's segments
            const segIndex = trunk.segments.findIndex(s => s.id === knot.parentShaftId);
            if (segIndex === -1) continue;

            const seg = trunk.segments[segIndex];
            const endpoints = getTrunkSegmentEndpoints(trunk, seg, segIndex, root);
            const nextDiameter = seg.diameter + 0.1;

            let nextPos = knot.pos;
            let posChanged = false;
            if (endpoints && knot.t !== undefined) {
                const computed = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, seg, knot.t);
                if (computed.x !== knot.pos.x || computed.y !== knot.pos.y || computed.z !== knot.pos.z) {
                    nextPos = computed;
                    posChanged = true;
                }
            }

            const diaChanged = knot.diameter !== nextDiameter;
            if (!posChanged && !diaChanged) continue;

            updatedKnots[knot.id] = { ...knot, pos: nextPos, diameter: nextDiameter };
            knotsChanged = true;
            if (posChanged) {
                updatedKnotPosById[knot.id] = nextPos;
            }
        }

        if (knotsChanged) {
            nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
            const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
            const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
            nextKnots = braceSeg.knots;
        }
    }

    state = {
        ...state,
        trunks: nextTrunks,
        knots: nextKnots,
        leaves: nextLeaves,
    };

    notify();
}

export function addBranch(branch: Branch) {
    state = {
        ...state,
        branches: { ...state.branches, [branch.id]: branch }
    };
    notify();
}

export function addLeaf(leaf: Leaf) {
    state = {
        ...state,
        leaves: { ...state.leaves, [leaf.id]: leaf }
    };
    notify();
}

export function addBrace(brace: Brace) {
    state = {
        ...state,
        braces: { ...state.braces, [brace.id]: brace },
    };
    notify();
}

export function addTwig(twig: Twig) {
    state = {
        ...state,
        twigs: { ...state.twigs, [twig.id]: twig },
    };
    notify();
}

export function addStick(stick: Stick) {
    state = {
        ...state,
        sticks: { ...state.sticks, [stick.id]: stick },
    };
    notify();
}

export function updateTwig(twig: Twig) {
    if (!state.twigs[twig.id]) return;

    const nextTwigs = { ...state.twigs, [twig.id]: twig };

    let nextKnots = state.knots;
    let nextLeaves = state.leaves;

    const updatedKnots: Record<string, Knot> = { ...state.knots };
    const updatedKnotPosById: Record<string, Vec3> = {};
    let knotsChanged = false;

    for (const knot of Object.values(state.knots)) {
        const segIndex = twig.segments.findIndex(s => s.id === knot.parentShaftId);
        if (segIndex === -1) continue;

        const seg = twig.segments[segIndex];
        if (!seg.bottomJoint || !seg.topJoint || knot.t === undefined) continue;

        const newPos = calculateKnotPositionOnSegmentFromT(seg.bottomJoint.pos, seg.topJoint.pos, seg, knot.t);
        if (newPos.x === knot.pos.x && newPos.y === knot.pos.y && newPos.z === knot.pos.z) continue;

        updatedKnots[knot.id] = { ...knot, pos: newPos };
        updatedKnotPosById[knot.id] = newPos;
        knotsChanged = true;
    }

    if (knotsChanged) {
        nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
        const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
        const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
        nextKnots = braceSeg.knots;
    }

    state = {
        ...state,
        twigs: nextTwigs,
        knots: nextKnots,
        leaves: nextLeaves,
    };
    notify();
}

export function updateStick(stick: Stick) {
    if (!state.sticks[stick.id]) return;

    const nextSticks = { ...state.sticks, [stick.id]: stick };

    let nextKnots = state.knots;
    let nextLeaves = state.leaves;

    const updatedKnots: Record<string, Knot> = { ...state.knots };
    const updatedKnotPosById: Record<string, Vec3> = {};
    let knotsChanged = false;

    for (const knot of Object.values(state.knots)) {
        const segIndex = stick.segments.findIndex(s => s.id === knot.parentShaftId);
        if (segIndex === -1) continue;

        const seg = stick.segments[segIndex];
        if (!seg.bottomJoint || !seg.topJoint || knot.t === undefined) continue;

        const newPos = calculateKnotPositionOnSegmentFromT(seg.bottomJoint.pos, seg.topJoint.pos, seg, knot.t);
        if (newPos.x === knot.pos.x && newPos.y === knot.pos.y && newPos.z === knot.pos.z) continue;

        updatedKnots[knot.id] = { ...knot, pos: newPos };
        updatedKnotPosById[knot.id] = newPos;
        knotsChanged = true;
    }

    if (knotsChanged) {
        nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
        const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
        const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
        nextKnots = braceSeg.knots;
    }

    state = {
        ...state,
        sticks: nextSticks,
        knots: nextKnots,
        leaves: nextLeaves,
    };
    notify();
}

export function updateBrace(brace: Brace) {
    if (!state.braces[brace.id]) return;
    const nextBraces = { ...state.braces, [brace.id]: brace };

    const braceSeg1 = recomputeBraceSegmentKnotGeometry(nextBraces, state.knots);
    const changedByBrace1 = getChangedKnotPositions(state.knots, braceSeg1.knots);

    let nextLeaves = state.leaves;
    let nextKnots = braceSeg1.knots;

    if (Object.keys(changedByBrace1).length > 0) {
        nextLeaves = recomputeKnotDependentGeometry(nextLeaves, changedByBrace1);
        const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, nextKnots);
        const braceSeg2 = recomputeBraceSegmentKnotGeometry(nextBraces, leafCone.knots);
        nextKnots = braceSeg2.knots;
    }

    state = {
        ...state,
        braces: nextBraces,
        knots: nextKnots,
        leaves: nextLeaves,
    };
    notify();
}

export function removeBrace(braceId: string): { brace: Brace; startKnot: Knot | null; endKnot: Knot | null } | null {
    const existing = state.braces[braceId];
    if (!existing) return null;

    const snapshots: { brace: Brace; startKnot: Knot | null; endKnot: Knot | null } = {
        brace: deepClone(existing),
        startKnot: null,
        endKnot: null,
    };

    const startKnotId = existing.startKnotId;
    const endKnotId = existing.endKnotId;

    const { [braceId]: _, ...remainingBraces } = state.braces;

    let nextKnots = state.knots;
    const knotsToRemove = [startKnotId, endKnotId].filter(Boolean);
    if (knotsToRemove.length > 0) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        if (startKnotId && updatedKnots[startKnotId]) {
            snapshots.startKnot = deepClone(updatedKnots[startKnotId]);
            delete updatedKnots[startKnotId];
        }
        if (endKnotId && updatedKnots[endKnotId]) {
            snapshots.endKnot = deepClone(updatedKnots[endKnotId]);
            delete updatedKnots[endKnotId];
        }
        nextKnots = updatedKnots;
    }

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (
        state.selectedId === braceId ||
        (startKnotId && state.selectedId === startKnotId) ||
        (endKnotId && state.selectedId === endKnotId)
    ) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        braces: remainingBraces,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return snapshots;
}

export function removeBranch(branchId: string): { branches: Branch[]; braces: Brace[]; supportBraces: SupportBraceBuildResult[]; leaves: Leaf[]; knots: Knot[] } | null {
    const rootBranch = state.branches[branchId];
    if (!rootBranch) return null;

    const branchIdsToRemove = new Set<string>([branchId]);
    const knotIdsToRemove = new Set<string>();

    // Collect branches recursively: if a branch is attached to a knot we remove, it must be removed too.
    // Also remove all knots created on the segments of those branches.
    let grew = true;
    while (grew) {
        grew = false;

        for (const bId of Array.from(branchIdsToRemove)) {
            const b = state.branches[bId];
            if (!b) continue;

            if (b.parentKnotId) {
                knotIdsToRemove.add(b.parentKnotId);
            }

            for (const seg of b.segments) {
                for (const knot of Object.values(state.knots)) {
                    if (knot.parentShaftId === seg.id) {
                        knotIdsToRemove.add(knot.id);
                    }
                }
            }
        }

        for (const b of Object.values(state.branches)) {
            if (branchIdsToRemove.has(b.id)) continue;
            if (b.parentKnotId && knotIdsToRemove.has(b.parentKnotId)) {
                branchIdsToRemove.add(b.id);
                grew = true;
            }
        }
    }

    const leafIdsToRemove = new Set<string>();
    for (const leaf of Object.values(state.leaves)) {
        if (leaf.parentKnotId && knotIdsToRemove.has(leaf.parentKnotId)) {
            leafIdsToRemove.add(leaf.id);
        }
    }

    const braceIdsToRemove = new Set<string>();
    for (const brace of Object.values(state.braces)) {
        if ((brace.startKnotId && knotIdsToRemove.has(brace.startKnotId)) || (brace.endKnotId && knotIdsToRemove.has(brace.endKnotId))) {
            braceIdsToRemove.add(brace.id);
        }
    }

    const branchSegmentIds = new Set<string>();
    for (const bId of branchIdsToRemove) {
        const b = state.branches[bId];
        if (!b) continue;
        for (const seg of b.segments) {
            branchSegmentIds.add(seg.id);
        }
    }

    const supportBraceState = getSupportBraceSnapshot();
    const supportBraceIdsToRemove = new Set<string>();
    for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
        if (branchSegmentIds.has(supportBrace.hostSegmentId) || knotIdsToRemove.has(supportBrace.hostKnotId)) {
            supportBraceIdsToRemove.add(supportBrace.id);
            if (supportBrace.hostKnotId) {
                knotIdsToRemove.add(supportBrace.hostKnotId);
            }
        }
    }

    const snapshots = {
        branches: Array.from(branchIdsToRemove).map((id) => deepClone(state.branches[id])).filter(Boolean),
        braces: Array.from(braceIdsToRemove).map((id) => deepClone(state.braces[id])).filter(Boolean),
        supportBraces: [] as SupportBraceBuildResult[],
        leaves: Array.from(leafIdsToRemove).map((id) => deepClone(state.leaves[id])).filter(Boolean),
        knots: Array.from(knotIdsToRemove).map((id) => deepClone(state.knots[id])).filter(Boolean),
    };

    const supportBraceRootIdsToRemove = new Set<string>();
    for (const supportBraceId of supportBraceIdsToRemove) {
        const currentSupportBraceState = getSupportBraceSnapshot();
        const supportBrace = currentSupportBraceState.supportBraces[supportBraceId];
        if (!supportBrace) continue;

        supportBraceRootIdsToRemove.add(supportBrace.rootId);
        knotIdsToRemove.add(supportBrace.hostKnotId);

        const root = currentSupportBraceState.roots[supportBrace.rootId];
        const hostKnot = currentSupportBraceState.knots[supportBrace.hostKnotId] ?? state.knots[supportBrace.hostKnotId];

        if (root && hostKnot) {
            snapshots.supportBraces.push({
                supportBrace: deepClone(supportBrace),
                root: deepClone(root),
                hostKnot: deepClone(hostKnot),
            });
            supportBraceRootIdsToRemove.add(root.id);
            knotIdsToRemove.add(hostKnot.id);
        }

        removeSupportBrace(supportBraceId);
    }

    const nextBranches = { ...state.branches };
    for (const id of branchIdsToRemove) {
        delete nextBranches[id];
    }

    const nextBraces = { ...state.braces };
    for (const id of braceIdsToRemove) {
        delete nextBraces[id];
    }

    const nextLeaves = { ...state.leaves };
    for (const id of leafIdsToRemove) {
        delete nextLeaves[id];
    }

    const nextKnots = { ...state.knots };
    for (const id of knotIdsToRemove) {
        delete nextKnots[id];
    }

    let nextRoots = state.roots;
    if (supportBraceRootIdsToRemove.size > 0) {
        const updatedRoots: Record<string, Roots> = { ...state.roots };
        for (const rootId of supportBraceRootIdsToRemove) {
            delete updatedRoots[rootId];
        }
        nextRoots = updatedRoots;
    }

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (
        (nextSelectedId && branchIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && braceIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && supportBraceIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && leafIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && knotIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && supportBraceRootIdsToRemove.has(nextSelectedId))
    ) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        branches: nextBranches,
        braces: nextBraces,
        leaves: nextLeaves,
        roots: nextRoots,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return snapshots;
}

export function updateBranch(branch: Branch) {
    if (!state.branches[branch.id]) return;

    const nextBranches = { ...state.branches, [branch.id]: branch };

    // Update any knots attached to this branch's segments
    const parentKnot = state.knots[branch.parentKnotId];
    let nextKnots = state.knots;
    let nextLeaves = state.leaves;

    if (parentKnot) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        const updatedKnotPosById: Record<string, Vec3> = {};
        let knotsChanged = false;

        for (const knot of Object.values(state.knots)) {
            const segIndex = branch.segments.findIndex(s => s.id === knot.parentShaftId);
            if (segIndex === -1) continue;

            const seg = branch.segments[segIndex];
            const endpoints = getBranchSegmentEndpoints(branch, seg, segIndex, parentKnot);
            if (!endpoints || knot.t === undefined) continue;

            const newPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, seg, knot.t);
            if (newPos.x === knot.pos.x && newPos.y === knot.pos.y && newPos.z === knot.pos.z) continue;

            updatedKnots[knot.id] = { ...knot, pos: newPos };
            updatedKnotPosById[knot.id] = newPos;
            knotsChanged = true;
        }

        if (knotsChanged) {
            nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
            const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
            const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
            nextKnots = braceSeg.knots;
        }
    }

    state = {
        ...state,
        branches: nextBranches,
        knots: nextKnots,
        leaves: nextLeaves,
    };
    notify();
}

export function addKnot(knot: Knot) {
    state = {
        ...state,
        knots: { ...state.knots, [knot.id]: knot }
    };
    notify();
}

export function removeKnotById(knotId: string): Knot | null {
    const knot = state.knots[knotId];
    if (!knot) return null;

    const nextKnots = { ...state.knots };
    delete nextKnots[knotId];

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (state.selectedId === knotId) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };
    notify();
    return deepClone(knot);
}

export function updateKnot(knot: Knot) {
    const existing = state.knots[knot.id];
    if (!existing) return;

    const baseKnots = { ...state.knots, [knot.id]: knot };

    let nextLeaves = recomputeKnotDependentGeometry(state.leaves, { [knot.id]: knot.pos });
    const leafCone1 = recomputeLeafConeKnotGeometry(nextLeaves, baseKnots);
    const braceSeg1 = recomputeBraceSegmentKnotGeometry(state.braces, leafCone1.knots);

    const changedByBrace1 = getChangedKnotPositions(leafCone1.knots, braceSeg1.knots);

    let nextKnots = braceSeg1.knots;
    if (Object.keys(changedByBrace1).length > 0) {
        nextLeaves = recomputeKnotDependentGeometry(nextLeaves, changedByBrace1);
        const leafCone2 = recomputeLeafConeKnotGeometry(nextLeaves, nextKnots);
        const braceSeg2 = recomputeBraceSegmentKnotGeometry(state.braces, leafCone2.knots);
        nextKnots = braceSeg2.knots;
    }

    state = { ...state, knots: nextKnots, leaves: nextLeaves };
    notify();
}

export function removeLeaf(leafId: string): { leaf: Leaf; knot: Knot | null } | null {
    const existingLeaf = state.leaves[leafId];
    if (!existingLeaf) return null;

    const snapshots: { leaf: Leaf; knot: Knot | null } = {
        leaf: deepClone(existingLeaf),
        knot: null,
    };

    const knotId = existingLeaf.parentKnotId;
    const { [leafId]: _, ...remainingLeaves } = state.leaves;

    let nextKnots = state.knots;
    if (knotId && state.knots[knotId]) {
        const { [knotId]: removedKnot, ...restKnots } = state.knots;
        snapshots.knot = deepClone(removedKnot);
        nextKnots = restKnots;
    }

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (state.selectedId === leafId || (knotId && state.selectedId === knotId)) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        leaves: remainingLeaves,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };

    notify();
    return snapshots;
}

export function removeTrunk(
    trunkId: string
): { trunk: Trunk; root: Roots | null; branches: Branch[]; braces: Brace[]; supportBraces: SupportBraceBuildResult[]; leaves: Leaf[]; knots: Knot[] } | null {
    const existingTrunk = state.trunks[trunkId];
    if (!existingTrunk) return null;

    const trunkSegmentIds = new Set(existingTrunk.segments.map((s) => s.id));
    const trunkHostedKnotIds = new Set<string>();
    for (const knot of Object.values(state.knots)) {
        if (trunkSegmentIds.has(knot.parentShaftId)) trunkHostedKnotIds.add(knot.id);
    }

    const branchIdsToRemove: string[] = [];
    for (const branch of Object.values(state.branches)) {
        if (branch.parentKnotId && trunkHostedKnotIds.has(branch.parentKnotId)) {
            branchIdsToRemove.push(branch.id);
        }
    }

    const leafIdsToRemove: string[] = [];
    for (const leaf of Object.values(state.leaves)) {
        if (leaf.parentKnotId && trunkHostedKnotIds.has(leaf.parentKnotId)) {
            leafIdsToRemove.push(leaf.id);
        }
    }

    const braceIdsToRemove: string[] = [];
    for (const brace of Object.values(state.braces)) {
        if ((brace.startKnotId && trunkHostedKnotIds.has(brace.startKnotId)) || (brace.endKnotId && trunkHostedKnotIds.has(brace.endKnotId))) {
            braceIdsToRemove.push(brace.id);
        }
    }

    const snapshots: { trunk: Trunk; root: Roots | null; branches: Branch[]; braces: Brace[]; supportBraces: SupportBraceBuildResult[]; leaves: Leaf[]; knots: Knot[] } = {
        trunk: deepClone(existingTrunk),
        root: null,
        branches: [],
        braces: [],
        supportBraces: [],
        leaves: [],
        knots: [],
    };

    const seenBranchIds = new Set<string>();
    const seenBraceIds = new Set<string>();
    const seenSupportBraceIds = new Set<string>();
    const seenLeafIds = new Set<string>();
    const seenKnotIds = new Set<string>();
    const supportBraceRootIdsToRemove = new Set<string>();

    for (const branchId of branchIdsToRemove) {
        const removed = removeBranch(branchId);
        if (!removed) continue;
        for (const b of removed.branches ?? []) {
            if (!b || seenBranchIds.has(b.id)) continue;
            seenBranchIds.add(b.id);
            snapshots.branches.push(b);
        }
        for (const br of removed.braces ?? []) {
            if (!br || seenBraceIds.has(br.id)) continue;
            seenBraceIds.add(br.id);
            snapshots.braces.push(br);
        }
        for (const supportBraceBuild of removed.supportBraces ?? []) {
            if (!supportBraceBuild || seenSupportBraceIds.has(supportBraceBuild.supportBrace.id)) continue;
            seenSupportBraceIds.add(supportBraceBuild.supportBrace.id);
            snapshots.supportBraces.push(supportBraceBuild);
            supportBraceRootIdsToRemove.add(supportBraceBuild.root.id);
            seenKnotIds.add(supportBraceBuild.hostKnot.id);
        }
        for (const l of removed.leaves ?? []) {
            if (!l || seenLeafIds.has(l.id)) continue;
            seenLeafIds.add(l.id);
            snapshots.leaves.push(l);
        }
        for (const k of removed.knots ?? []) {
            if (!k || seenKnotIds.has(k.id)) continue;
            seenKnotIds.add(k.id);
            snapshots.knots.push(k);
        }
    }

    for (const leafId of leafIdsToRemove) {
        const removed = removeLeaf(leafId);
        if (!removed) continue;
        if (removed.leaf && !seenLeafIds.has(removed.leaf.id)) {
            seenLeafIds.add(removed.leaf.id);
            snapshots.leaves.push(removed.leaf);
        }
        if (removed.knot && !seenKnotIds.has(removed.knot.id)) {
            seenKnotIds.add(removed.knot.id);
            snapshots.knots.push(removed.knot);
        }
    }

    for (const braceId of braceIdsToRemove) {
        const removed = removeBrace(braceId);
        if (!removed) continue;
        if (removed.brace && !seenBraceIds.has(removed.brace.id)) {
            seenBraceIds.add(removed.brace.id);
            snapshots.braces.push(removed.brace);
        }
        if (removed.startKnot && !seenKnotIds.has(removed.startKnot.id)) {
            seenKnotIds.add(removed.startKnot.id);
            snapshots.knots.push(removed.startKnot);
        }
        if (removed.endKnot && !seenKnotIds.has(removed.endKnot.id)) {
            seenKnotIds.add(removed.endKnot.id);
            snapshots.knots.push(removed.endKnot);
        }
    }

    const supportBraceState = getSupportBraceSnapshot();
    const supportBraceIdsToRemove = new Set<string>();
    for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
        if (trunkSegmentIds.has(supportBrace.hostSegmentId) || trunkHostedKnotIds.has(supportBrace.hostKnotId)) {
            supportBraceIdsToRemove.add(supportBrace.id);
        }
    }

    for (const supportBraceId of supportBraceIdsToRemove) {
        const currentSupportBraceState = getSupportBraceSnapshot();
        const supportBrace = currentSupportBraceState.supportBraces[supportBraceId];
        if (!supportBrace) continue;

        supportBraceRootIdsToRemove.add(supportBrace.rootId);
        if (!seenKnotIds.has(supportBrace.hostKnotId) && state.knots[supportBrace.hostKnotId]) {
            seenKnotIds.add(supportBrace.hostKnotId);
            snapshots.knots.push(deepClone(state.knots[supportBrace.hostKnotId]));
        }

        const root = currentSupportBraceState.roots[supportBrace.rootId];
        const hostKnot = currentSupportBraceState.knots[supportBrace.hostKnotId] ?? state.knots[supportBrace.hostKnotId];

        if (root && hostKnot && !seenSupportBraceIds.has(supportBrace.id)) {
            seenSupportBraceIds.add(supportBrace.id);
            snapshots.supportBraces.push({
                supportBrace: deepClone(supportBrace),
                root: deepClone(root),
                hostKnot: deepClone(hostKnot),
            });
            supportBraceRootIdsToRemove.add(root.id);
            if (!seenKnotIds.has(hostKnot.id)) {
                seenKnotIds.add(hostKnot.id);
                snapshots.knots.push(deepClone(hostKnot));
            }
        }

        removeSupportBrace(supportBraceId);
    }

    const remainingKnotsToRemove: string[] = [];
    for (const knotId of Array.from(trunkHostedKnotIds)) {
        if (state.knots[knotId]) remainingKnotsToRemove.push(knotId);
    }

    let nextKnots = state.knots;
    if (remainingKnotsToRemove.length > 0) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        for (const knotId of remainingKnotsToRemove) {
            const k = updatedKnots[knotId];
            if (!k) continue;
            if (!seenKnotIds.has(k.id)) {
                seenKnotIds.add(k.id);
                snapshots.knots.push(deepClone(k));
            }
            delete updatedKnots[knotId];
        }
        nextKnots = updatedKnots;
    }

    const { [trunkId]: _, ...remainingTrunks } = state.trunks;
    let nextRoots = state.roots;
    if (supportBraceRootIdsToRemove.size > 0) {
        const updatedRoots: Record<string, Roots> = { ...nextRoots };
        for (const rootId of supportBraceRootIdsToRemove) {
            delete updatedRoots[rootId];
        }
        nextRoots = updatedRoots;
    }
    if (existingTrunk.rootId && state.roots[existingTrunk.rootId]) {
        const { [existingTrunk.rootId]: removedRoot, ...restRoots } = state.roots;
        snapshots.root = deepClone(removedRoot);
        nextRoots = { ...restRoots, ...nextRoots };
        delete nextRoots[existingTrunk.rootId];
    }

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;

    if (state.selectedId === trunkId || state.selectedId === existingTrunk.rootId) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    } else if (state.selectedCategory === 'joint' && state.selectedId) {
        const jointInTrunk =
            existingTrunk.segments.some((s) => s.topJoint?.id === state.selectedId || s.bottomJoint?.id === state.selectedId) ||
            (!!existingTrunk.contactCone?.socketJointId && existingTrunk.contactCone.socketJointId === state.selectedId);
        if (jointInTrunk) {
            nextSelectedId = null;
            nextSelectedCategory = null;
        }
    } else if (state.selectedCategory === 'segment' && state.selectedId) {
        if (trunkSegmentIds.has(state.selectedId)) {
            nextSelectedId = null;
            nextSelectedCategory = null;
        }
    } else if (state.selectedCategory === 'knot' && state.selectedId) {
        if (trunkHostedKnotIds.has(state.selectedId)) {
            nextSelectedId = null;
            nextSelectedCategory = null;
        }
    } else if (state.selectedId && seenSupportBraceIds.has(state.selectedId)) {
        nextSelectedId = null;
        nextSelectedCategory = null;
    }

    state = {
        ...state,
        trunks: remainingTrunks,
        roots: nextRoots,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    };

    notify();
    return snapshots;
}

// --- Selectors / Hooks Helpers ---

export function getRoots() {
    return Object.values(state.roots);
}

export function getTrunks() {
    return Object.values(state.trunks);
}

export function getBranches() {
    return Object.values(state.branches);
}

export function getLeaves() {
    return Object.values(state.leaves);
}

export function getTwigs() {
    return Object.values(state.twigs);
}

export function getSticks() {
    return Object.values(state.sticks);
}

export function getBraces() {
    return Object.values(state.braces);
}

export function getKnotsMap() {
    return state.knots;
}

export function getKnots() {
    return Object.values(state.knots);
}

export function getKnotById(knotId: string) {
    return state.knots[knotId] ?? null;
}

export function getSelectedId() {
    return state.selectedId;
}

export function getSelectedCategory() {
    return state.selectedCategory;
}

export function getHoveredId() {
    return state.hoveredId;
}

export function getHoveredCategory() {
    return state.hoveredCategory;
}

export function getModelIdForSupportEntityId(id: string | null | undefined): string | null {
    if (!id) return null;

    if (id.startsWith('braceSegment:')) {
        const braceId = id.slice('braceSegment:'.length);
        return state.braces[braceId]?.modelId ?? null;
    }

    if (state.roots[id]) return state.roots[id].modelId ?? null;
    if (state.trunks[id]) return state.trunks[id].modelId ?? null;
    if (state.branches[id]) return state.branches[id].modelId ?? null;
    if (state.leaves[id]) return state.leaves[id].modelId ?? null;
    if (state.twigs[id]) return state.twigs[id].modelId ?? null;
    if (state.sticks[id]) return state.sticks[id].modelId ?? null;
    if (state.braces[id]) return state.braces[id].modelId ?? null;

    const supportBraceState = getSupportBraceSnapshot();
    const directSupportBrace = supportBraceState.supportBraces[id];
    if (directSupportBrace) return directSupportBrace.modelId ?? null;

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return trunk.modelId ?? null;
        }
    }

    for (const branch of Object.values(state.branches)) {
        if (branch.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return branch.modelId ?? null;
        }
    }

    for (const twig of Object.values(state.twigs)) {
        if (twig.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return twig.modelId ?? null;
        }
    }

    for (const stick of Object.values(state.sticks)) {
        if (stick.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return stick.modelId ?? null;
        }
    }

    for (const brace of Object.values(state.braces)) {
        if (brace.startKnotId === id || brace.endKnotId === id) {
            return brace.modelId ?? null;
        }
    }

    for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
        if (supportBrace.hostKnotId === id) return supportBrace.modelId ?? null;
        if (supportBrace.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return supportBrace.modelId ?? null;
        }
    }

    if (state.knots[id]) {
        const parentShaftId = state.knots[id].parentShaftId;
        if (parentShaftId) {
            const byParent = getModelIdForSupportEntityId(parentShaftId);
            if (byParent) return byParent;
        }

        for (const branch of Object.values(state.branches)) {
            if (branch.parentKnotId === id) return branch.modelId ?? null;
        }
        for (const leaf of Object.values(state.leaves)) {
            if (leaf.parentKnotId === id) return leaf.modelId ?? null;
        }
    }

    return null;
}

export function getTrunkById(trunkId: string) {
    return state.trunks[trunkId] ?? null;
}

export function getRootById(rootId: string) {
    return state.roots[rootId] ?? null;
}

export function getBranchById(branchId: string) {
    return state.branches[branchId] ?? null;
}

export function getTwigById(twigId: string) {
    return state.twigs[twigId] ?? null;
}

export function getStickById(stickId: string) {
    return state.sticks[stickId] ?? null;
}
