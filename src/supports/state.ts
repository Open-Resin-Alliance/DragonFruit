import { SupportState, DragonfruitImportFormat, Trunk, Roots, Segment, BezierSegment, StraightSegment, Branch, Knot, Vec3, Leaf, Brace, Twig, Stick, Anchor } from './types';
import { calculateBezierControlPoints, getBezierPointAtT, toVector3, toVec3 } from './Curves/BezierUtils';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints, calculateKnotPositionOnSegmentFromT } from './SupportPrimitives/Knot/knotUtils';
import type { SupportTipProfile } from './SupportPrimitives/ContactCone/types';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { emitSupportInteractionReset } from './interaction/supportInteractionReset';
import { getJointDiameter, JOINT_DIAMETER_OFFSET_MM } from './constants';
import { addKickstand, getKickstandSnapshot, reassignAllKickstandModelIds, removeKickstand, resetKickstandStore, setKickstandSnapshot, transformAllKickstands, transformKickstandsForModel, updateKickstand } from './SupportTypes/Kickstand/kickstandStore';
import type { Kickstand, KickstandBuildResult, KickstandRemoveResult } from './SupportTypes/Kickstand/types';
import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { generateUuid } from '@/utils/uuid';
import type { SupportSettings } from './Settings/types';
import { createDefaultSettings } from './Settings/types';
import { decodeSupportSettingsHex, encodeSupportSettingsHex } from './Settings/supportSettingsCodec';

export type { SupportState } from './types';

function isSupportSettingsDebugEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem('df-debug-support-settings') === '1';
    } catch {
        return false;
    }
}

function logSupportSettingsDebug(...args: unknown[]): void {
    if (!isSupportSettingsDebugEnabled()) return;
    console.log('[SupportSettingsDebug]', ...args);
}

const listeners = new Set<() => void>();
let notifyBatchDepth = 0;
let pendingNotify = false;

type SupportSettingsHexCache = {
    trunk: Record<string, string>;
    branch: Record<string, string>;
    leaf: Record<string, string>;
};

const initialState: SupportState = {
    roots: {},
    trunks: {},
    branches: {},
    leaves: {},
    twigs: {},
    sticks: {},
    braces: {},
    anchors: {},
    knots: {},
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
};

let state: SupportState = { ...initialState };

let supportSettingsHexCache: SupportSettingsHexCache = {
    trunk: {},
    branch: {},
    leaf: {},
};

type SelectionCategory = 'trunk' | 'branch' | 'leaf' | 'twig' | 'stick' | 'brace' | 'anchor' | 'root' | 'joint' | 'knot' | 'segment' | 'contactDisk' | null;

interface SelectionLookupCache {
    trunksRef: SupportState['trunks'];
    branchesRef: SupportState['branches'];
    leavesRef: SupportState['leaves'];
    twigsRef: SupportState['twigs'];
    sticksRef: SupportState['sticks'];
    anchorsRef: SupportState['anchors'];
    kickstandsRef: Record<string, Kickstand>;
    jointIds: Set<string>;
    segmentIds: Set<string>;
    contactDiskIds: Set<string>;
    kickstandIds: Set<string>;
}

let selectionLookupCache: SelectionLookupCache | null = null;

function getSelectionLookupCache(): SelectionLookupCache {
    const kickstandSnapshot = getKickstandSnapshot();
    const kickstands = kickstandSnapshot.kickstands;

    if (
        selectionLookupCache
        && selectionLookupCache.trunksRef === state.trunks
        && selectionLookupCache.branchesRef === state.branches
        && selectionLookupCache.leavesRef === state.leaves
        && selectionLookupCache.twigsRef === state.twigs
        && selectionLookupCache.sticksRef === state.sticks
        && selectionLookupCache.anchorsRef === state.anchors
        && selectionLookupCache.kickstandsRef === kickstands
    ) {
        return selectionLookupCache;
    }

    const jointIds = new Set<string>();
    const segmentIds = new Set<string>();
    const contactDiskIds = new Set<string>();
    const kickstandIds = new Set<string>();

    for (const trunk of Object.values(state.trunks)) {
        for (const segment of trunk.segments) {
            segmentIds.add(segment.id);
            if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
            if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
        }

        if (trunk.contactCone?.id) {
            contactDiskIds.add(trunk.contactCone.id);
        }
    }

    for (const branch of Object.values(state.branches)) {
        for (const segment of branch.segments) {
            segmentIds.add(segment.id);
            if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
            if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
        }

        if (branch.contactCone?.id) {
            contactDiskIds.add(branch.contactCone.id);
        }
    }

    for (const leaf of Object.values(state.leaves)) {
        if (leaf.contactCone?.id) {
            contactDiskIds.add(leaf.contactCone.id);
        }
    }

    for (const twig of Object.values(state.twigs)) {
        for (const segment of twig.segments) {
            segmentIds.add(segment.id);
            if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
            if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
        }

        if (twig.contactDiskA?.id) contactDiskIds.add(twig.contactDiskA.id);
        if (twig.contactDiskB?.id) contactDiskIds.add(twig.contactDiskB.id);
    }

    for (const stick of Object.values(state.sticks)) {
        for (const segment of stick.segments) {
            segmentIds.add(segment.id);
            if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
            if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
        }

        if (stick.contactConeA?.id) contactDiskIds.add(stick.contactConeA.id);
        if (stick.contactConeB?.id) contactDiskIds.add(stick.contactConeB.id);
    }

    for (const anchor of Object.values(state.anchors)) {
        if (anchor.contactCone?.id) {
            contactDiskIds.add(anchor.contactCone.id);
        }
    }

    for (const kickstand of Object.values(kickstands)) {
        kickstandIds.add(kickstand.id);
        for (const segment of kickstand.segments) {
            segmentIds.add(segment.id);
            if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
            if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
        }
    }

    selectionLookupCache = {
        trunksRef: state.trunks,
        branchesRef: state.branches,
        leavesRef: state.leaves,
        twigsRef: state.twigs,
        sticksRef: state.sticks,
        anchorsRef: state.anchors,
        kickstandsRef: kickstands,
        jointIds,
        segmentIds,
        contactDiskIds,
        kickstandIds,
    };

    return selectionLookupCache;
}

function resolveSelectionCategory(id: string): SelectionCategory {
    if (!id) return null;
    if (id.startsWith('braceSegment:')) return 'segment';
    if (state.roots[id]) return 'root';
    if (state.trunks[id]) return 'trunk';
    if (state.branches[id]) return 'branch';
    if (state.leaves[id]) return 'leaf';
    if (state.twigs[id]) return 'twig';
    if (state.sticks[id]) return 'stick';
    if (state.braces[id]) return 'brace';
    if (state.anchors[id]) return 'anchor';

    const lookup = getSelectionLookupCache();
    if (lookup.kickstandIds.has(id)) return 'brace';
    if (state.knots[id]) return 'knot';
    if (lookup.jointIds.has(id)) return 'joint';
    if (lookup.segmentIds.has(id)) return 'segment';
    if (lookup.contactDiskIds.has(id)) return 'contactDisk';

    return null;
}

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
    if (notifyBatchDepth > 0) {
        pendingNotify = true;
        return;
    }
    listeners.forEach((l) => l());
}

export function beginSupportStateBatch() {
    notifyBatchDepth += 1;
}

export function endSupportStateBatch() {
    if (notifyBatchDepth <= 0) return;
    notifyBatchDepth -= 1;
    if (notifyBatchDepth === 0 && pendingNotify) {
        pendingNotify = false;
        listeners.forEach((l) => l());
    }
}

function rebuildSupportSettingsHexCacheFromState() {
    const next: SupportSettingsHexCache = {
        trunk: {},
        branch: {},
        leaf: {},
    };

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.settingsCodeHex) next.trunk[trunk.id] = trunk.settingsCodeHex;
    }
    for (const branch of Object.values(state.branches)) {
        if (branch.settingsCodeHex) next.branch[branch.id] = branch.settingsCodeHex;
    }
    for (const leaf of Object.values(state.leaves)) {
        if (leaf.settingsCodeHex) next.leaf[leaf.id] = leaf.settingsCodeHex;
    }

    supportSettingsHexCache = next;
}

function clearSupportSettingsHexCache() {
    supportSettingsHexCache = {
        trunk: {},
        branch: {},
        leaf: {},
    };
}

function getCachedSupportSettingsHex(kind: 'trunk' | 'branch' | 'leaf', id: string, entityHex?: string): string | null {
    const cached = supportSettingsHexCache[kind][id];
    if (cached) return cached;
    if (entityHex) {
        supportSettingsHexCache[kind][id] = entityHex;
        return entityHex;
    }
    return null;
}

function setCachedSupportSettingsHex(kind: 'trunk' | 'branch' | 'leaf', id: string, hex: string) {
    supportSettingsHexCache[kind][id] = hex;
}

function deleteCachedSupportSettingsHex(kind: 'trunk' | 'branch' | 'leaf', id: string) {
    delete supportSettingsHexCache[kind][id];
}

function syncKickstandHostKnotsFromSharedKnots(sharedKnots: Record<string, Knot>) {
    const kickstandState = getKickstandSnapshot();
    let nextKnots = kickstandState.knots;
    let changed = false;

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        const hostKnot = sharedKnots[kickstand.hostKnotId];
        if (!hostKnot) continue;

        const existing = nextKnots[hostKnot.id];
        if (
            existing
            && existing.pos.x === hostKnot.pos.x
            && existing.pos.y === hostKnot.pos.y
            && existing.pos.z === hostKnot.pos.z
            && existing.t === hostKnot.t
            && existing.diameter === hostKnot.diameter
            && existing.parentShaftId === hostKnot.parentShaftId
        ) {
            continue;
        }

        if (!changed) {
            nextKnots = { ...kickstandState.knots };
            changed = true;
        }

        nextKnots[hostKnot.id] = { ...hostKnot };
    }

    if (!changed) return;

    setKickstandSnapshot({
        ...kickstandState,
        knots: nextKnots,
    });
}

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSnapshot() {
    return state;
}

export function reassignAllSupportModelIds(modelId: string): boolean {
    if (!modelId) return false;

    let changed = false;
    let nextRoots = state.roots;
    let nextTrunks = state.trunks;
    let nextBranches = state.branches;
    let nextLeaves = state.leaves;
    let nextTwigs = state.twigs;
    let nextSticks = state.sticks;
    let nextBraces = state.braces;
    let nextAnchors = state.anchors;

    for (const root of Object.values(state.roots)) {
        if (root.modelId === modelId) continue;
        if (!changed) {
            nextRoots = { ...state.roots };
            changed = true;
        }
        nextRoots[root.id] = { ...root, modelId };
    }

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.modelId === modelId) continue;
        if (!changed) {
            nextTrunks = { ...state.trunks };
            changed = true;
        }
        nextTrunks[trunk.id] = { ...trunk, modelId };
    }

    for (const branch of Object.values(state.branches)) {
        if (branch.modelId === modelId) continue;
        if (!changed) {
            nextBranches = { ...state.branches };
            changed = true;
        }
        nextBranches[branch.id] = { ...branch, modelId };
    }

    for (const leaf of Object.values(state.leaves)) {
        if (leaf.modelId === modelId) continue;
        if (!changed) {
            nextLeaves = { ...state.leaves };
            changed = true;
        }
        nextLeaves[leaf.id] = { ...leaf, modelId };
    }

    for (const twig of Object.values(state.twigs)) {
        if (twig.modelId === modelId) continue;
        if (!changed) {
            nextTwigs = { ...state.twigs };
            changed = true;
        }
        nextTwigs[twig.id] = { ...twig, modelId };
    }

    for (const stick of Object.values(state.sticks)) {
        if (stick.modelId === modelId) continue;
        if (!changed) {
            nextSticks = { ...state.sticks };
            changed = true;
        }
        nextSticks[stick.id] = { ...stick, modelId };
    }

    for (const brace of Object.values(state.braces)) {
        if (brace.modelId === modelId) continue;
        if (!changed) {
            nextBraces = { ...state.braces };
            changed = true;
        }
        nextBraces[brace.id] = { ...brace, modelId };
    }

    for (const anchor of Object.values(state.anchors)) {
        if (anchor.modelId === modelId) continue;
        if (!changed) {
            nextAnchors = { ...state.anchors };
            changed = true;
        }
        nextAnchors[anchor.id] = { ...anchor, modelId };
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
            anchors: nextAnchors,
        };
        notify();
    }

    const kickstandChanged = reassignAllKickstandModelIds(modelId);
    return changed || kickstandChanged;
}

export function setSnapshot(next: SupportState) {
    state = next;
    rebuildSupportSettingsHexCacheFromState();
    emitSupportInteractionReset('setSnapshot');
    notify();
}

function transformVec3(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const v = new THREE.Vector3(value.x, value.y, value.z).applyMatrix4(matrix);
    return { x: v.x, y: v.y, z: v.z };
}

function transformVec3PreserveZ(value: Vec3, matrix: THREE.Matrix4): Vec3 {
    const transformed = transformVec3(value, matrix);
    return {
        ...transformed,
        z: value.z,
    };
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
        const bezierNext = next as BezierSegment;
        bezierNext.controlPoint1 = transformVec3(segment.controlPoint1, matrix);
        bezierNext.controlPoint2 = transformVec3(segment.controlPoint2, matrix);
        bezierNext.startTangent = transformDirection(segment.startTangent, normalMatrix);
        bezierNext.endTangent = transformDirection(segment.endTangent, normalMatrix);
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

function vectorsRoughlyEqual(a: THREE.Vector3, b: THREE.Vector3, epsilon = 1e-8) {
    return Math.abs(a.x - b.x) <= epsilon
        && Math.abs(a.y - b.y) <= epsilon
        && Math.abs(a.z - b.z) <= epsilon;
}

function eulersRoughlyEqual(a: THREE.Euler, b: THREE.Euler, epsilon = 1e-8) {
    return Math.abs(a.x - b.x) <= epsilon
        && Math.abs(a.y - b.y) <= epsilon
        && Math.abs(a.z - b.z) <= epsilon
        && a.order === b.order;
}

export type SupportTransformCommitResult = {
    supportsChanged: boolean;
    kickstandsChanged: boolean;
};

export function transformSupportsForModel(
    modelId: string,
    beforeTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
    afterTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
): SupportTransformCommitResult {
    if (!modelId) {
        return {
            supportsChanged: false,
            kickstandsChanged: false,
        };
    }

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
        return {
            supportsChanged: false,
            kickstandsChanged: false,
        };
    }

    const isPureTranslation = eulersRoughlyEqual(beforeTransform.rotation, afterTransform.rotation)
        && vectorsRoughlyEqual(beforeTransform.scale, afterTransform.scale);
    const deltaTranslation = afterTransform.position.clone().sub(beforeTransform.position);
    const preserveRootZ = isPureTranslation && Math.abs(deltaTranslation.z) > 1e-8;

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

    const touchedRootIds = new Set<string>();
    const touchedSegmentIds = new Set<string>();
    const touchedJointIds = new Set<string>();
    const touchedKnotIds = new Set<string>();
    const touchedLeafIds = new Set<string>();
    const touchedBraceIds = new Set<string>();
    const affectedBranchIds = new Set<string>();
    const affectedLeafIds = new Set<string>();
    const affectedBraceIds = new Set<string>();
    const affectedTwigIds = new Set<string>();
    const affectedStickIds = new Set<string>();

    const segmentModelIdById = new Map<string, string | undefined>();
    for (const trunk of Object.values(state.trunks)) {
        for (const segment of trunk.segments) segmentModelIdById.set(segment.id, trunk.modelId);
    }
    for (const branch of Object.values(state.branches)) {
        for (const segment of branch.segments) segmentModelIdById.set(segment.id, branch.modelId);
    }
    for (const twig of Object.values(state.twigs)) {
        for (const segment of twig.segments) segmentModelIdById.set(segment.id, twig.modelId);
    }
    for (const stick of Object.values(state.sticks)) {
        for (const segment of stick.segments) segmentModelIdById.set(segment.id, stick.modelId);
    }

    const resolveModelIdFromParentShaft = (parentShaftId: string, visitedBraceIds?: Set<string>): string | undefined => {
        if (parentShaftId.startsWith('leafCone:')) {
            const leafId = parentShaftId.slice('leafCone:'.length);
            const leaf = state.leaves[leafId];
            if (!leaf) return undefined;
            return leaf.modelId ?? resolveModelIdFromKnot(leaf.parentKnotId, visitedBraceIds);
        }

        if (parentShaftId.startsWith('braceSegment:')) {
            const braceId = parentShaftId.slice('braceSegment:'.length);
            const brace = state.braces[braceId];
            if (!brace) return undefined;

            const nextVisited = visitedBraceIds ?? new Set<string>();
            if (nextVisited.has(braceId)) return brace.modelId;
            nextVisited.add(braceId);

            return brace.modelId
                ?? resolveModelIdFromKnot(brace.startKnotId, nextVisited)
                ?? resolveModelIdFromKnot(brace.endKnotId, nextVisited);
        }

        return segmentModelIdById.get(parentShaftId);
    };

    const resolveModelIdFromKnot = (knotId: string | undefined, visitedBraceIds?: Set<string>): string | undefined => {
        if (!knotId) return undefined;
        const knot = state.knots[knotId];
        if (!knot) return undefined;
        return resolveModelIdFromParentShaft(knot.parentShaftId, visitedBraceIds);
    };

    for (const root of Object.values(state.roots)) {
        if (root.modelId !== modelId) continue;
        if (!changed) {
            nextRoots = { ...state.roots };
            changed = true;
        }
        touchedRootIds.add(root.id);
        nextRoots[root.id] = {
            ...root,
            transform: {
                ...root.transform,
                pos: preserveRootZ
                    ? transformVec3PreserveZ(root.transform.pos, deltaMatrix)
                    : transformVec3(root.transform.pos, deltaMatrix),
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
        trunk.segments.forEach((segment) => {
            if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
            if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
        });
        if (trunk.contactCone?.socketJointId) {
            touchedJointIds.add(trunk.contactCone.socketJointId);
        }
        const nextTrunk: Trunk = {
            ...trunk,
            segments: trunk.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: trunk.contactCone ? transformContactCone(trunk.contactCone, deltaMatrix, normalMatrix) : trunk.contactCone,
        };

        nextTrunks[trunk.id] = nextTrunk;
    }

    let expandedGraph = true;
    while (expandedGraph) {
        expandedGraph = false;

        for (const branch of Object.values(state.branches)) {
            if (affectedBranchIds.has(branch.id)) continue;

            const parentKnot = state.knots[branch.parentKnotId];
            const isConnectedToMovedGraph = touchedKnotIds.has(branch.parentKnotId)
                || (!!parentKnot && touchedSegmentIds.has(parentKnot.parentShaftId));
            const resolvedBranchModelId = branch.modelId ?? resolveModelIdFromKnot(branch.parentKnotId);

            if (resolvedBranchModelId !== modelId && !isConnectedToMovedGraph) continue;

            affectedBranchIds.add(branch.id);
            touchedKnotIds.add(branch.parentKnotId);
            branch.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
            branch.segments.forEach((segment) => {
                if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
                if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
            });
            if (branch.contactCone?.socketJointId) {
                touchedJointIds.add(branch.contactCone.socketJointId);
            }
            expandedGraph = true;
        }

        for (const leaf of Object.values(state.leaves)) {
            if (affectedLeafIds.has(leaf.id)) continue;

            const parentKnot = state.knots[leaf.parentKnotId];
            const isConnectedToMovedGraph = touchedKnotIds.has(leaf.parentKnotId)
                || (!!parentKnot && touchedSegmentIds.has(parentKnot.parentShaftId));
            const resolvedLeafModelId = leaf.modelId ?? resolveModelIdFromKnot(leaf.parentKnotId);

            if (resolvedLeafModelId !== modelId && !isConnectedToMovedGraph) continue;

            affectedLeafIds.add(leaf.id);
            touchedKnotIds.add(leaf.parentKnotId);
            touchedLeafIds.add(leaf.id);
            expandedGraph = true;
        }

        for (const brace of Object.values(state.braces)) {
            if (affectedBraceIds.has(brace.id)) continue;

            const startKnot = state.knots[brace.startKnotId];
            const endKnot = state.knots[brace.endKnotId];
            const startParentShaftId = startKnot?.parentShaftId;
            const endParentShaftId = endKnot?.parentShaftId;
            const isConnectedToMovedGraph = touchedKnotIds.has(brace.startKnotId)
                || touchedKnotIds.has(brace.endKnotId)
                || (!!startParentShaftId && (touchedSegmentIds.has(startParentShaftId)
                    || (startParentShaftId.startsWith('braceSegment:')
                        && touchedBraceIds.has(startParentShaftId.slice('braceSegment:'.length)))))
                || (!!endParentShaftId && (touchedSegmentIds.has(endParentShaftId)
                    || (endParentShaftId.startsWith('braceSegment:')
                        && touchedBraceIds.has(endParentShaftId.slice('braceSegment:'.length)))));
            const resolvedBraceModelId = brace.modelId
                ?? resolveModelIdFromKnot(brace.startKnotId)
                ?? resolveModelIdFromKnot(brace.endKnotId);

            if (resolvedBraceModelId !== modelId && !isConnectedToMovedGraph) continue;

            affectedBraceIds.add(brace.id);
            touchedKnotIds.add(brace.startKnotId);
            touchedKnotIds.add(brace.endKnotId);
            touchedBraceIds.add(brace.id);
            touchedSegmentIds.add(`braceSegment:${brace.id}`);
            expandedGraph = true;
        }

        for (const twig of Object.values(state.twigs)) {
            if (affectedTwigIds.has(twig.id)) continue;

            const isConnectedToMovedGraph = twig.segments.some((segment) => {
                const bottomJointId = segment.bottomJoint?.id;
                const topJointId = segment.topJoint?.id;
                return (!!bottomJointId && touchedJointIds.has(bottomJointId))
                    || (!!topJointId && touchedJointIds.has(topJointId));
            });

            if (twig.modelId !== modelId && !isConnectedToMovedGraph) continue;

            affectedTwigIds.add(twig.id);
            twig.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
            twig.segments.forEach((segment) => {
                if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
                if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
            });
            expandedGraph = true;
        }

        for (const stick of Object.values(state.sticks)) {
            if (affectedStickIds.has(stick.id)) continue;

            const isConnectedToMovedGraph = stick.segments.some((segment) => {
                const bottomJointId = segment.bottomJoint?.id;
                const topJointId = segment.topJoint?.id;
                return (!!bottomJointId && touchedJointIds.has(bottomJointId))
                    || (!!topJointId && touchedJointIds.has(topJointId));
            });

            if (stick.modelId !== modelId && !isConnectedToMovedGraph) continue;

            affectedStickIds.add(stick.id);
            stick.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
            stick.segments.forEach((segment) => {
                if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
                if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
            });
            if (stick.contactConeA?.socketJointId) touchedJointIds.add(stick.contactConeA.socketJointId);
            if (stick.contactConeB?.socketJointId) touchedJointIds.add(stick.contactConeB.socketJointId);
            expandedGraph = true;
        }
    }

    for (const branchId of affectedBranchIds) {
        const branch = state.branches[branchId];
        if (!branch) continue;

        if (!changed) {
            nextBranches = { ...state.branches };
            changed = true;
        }

        nextBranches[branch.id] = {
            ...branch,
            segments: branch.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: branch.contactCone ? transformContactCone(branch.contactCone, deltaMatrix, normalMatrix) : branch.contactCone,
        };
    }

    for (const leafId of affectedLeafIds) {
        const leaf = state.leaves[leafId];
        if (!leaf) continue;

        if (!changed) {
            nextLeaves = { ...state.leaves };
            changed = true;
        }

        nextLeaves[leaf.id] = {
            ...leaf,
            contactCone: transformContactCone(leaf.contactCone, deltaMatrix, normalMatrix),
        };
    }

    for (const twigId of affectedTwigIds) {
        const twig = state.twigs[twigId];
        if (!twig) continue;
        if (!changed) {
            nextTwigs = { ...state.twigs };
            changed = true;
        }

        twig.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        twig.segments.forEach((segment) => {
            if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
            if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
        });
        nextTwigs[twig.id] = {
            ...twig,
            segments: twig.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactDiskA: transformContactDisk(twig.contactDiskA, deltaMatrix, normalMatrix),
            contactDiskB: transformContactDisk(twig.contactDiskB, deltaMatrix, normalMatrix),
        };
    }

    for (const stickId of affectedStickIds) {
        const stick = state.sticks[stickId];
        if (!stick) continue;
        if (!changed) {
            nextSticks = { ...state.sticks };
            changed = true;
        }

        stick.segments.forEach((segment) => touchedSegmentIds.add(segment.id));
        stick.segments.forEach((segment) => {
            if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
            if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
        });
        if (stick.contactConeA?.socketJointId) touchedJointIds.add(stick.contactConeA.socketJointId);
        if (stick.contactConeB?.socketJointId) touchedJointIds.add(stick.contactConeB.socketJointId);
        nextSticks[stick.id] = {
            ...stick,
            segments: stick.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactConeA: transformContactCone(stick.contactConeA, deltaMatrix, normalMatrix),
            contactConeB: transformContactCone(stick.contactConeB, deltaMatrix, normalMatrix),
        };
    }

    for (const braceId of affectedBraceIds) {
        const brace = state.braces[braceId];
        if (!brace) continue;

        if (!changed) {
            nextBraces = { ...state.braces };
            changed = true;
        }

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

    let nextAnchors = state.anchors;
    for (const anchor of Object.values(state.anchors)) {
        if (anchor.modelId !== modelId) continue;
        if (!changed) {
            nextAnchors = { ...state.anchors };
            changed = true;
        }
        nextAnchors[anchor.id] = {
            ...anchor,
            rootPos: transformVec3(anchor.rootPos, deltaMatrix),
            joint: {
                ...anchor.joint,
                pos: transformVec3(anchor.joint.pos, deltaMatrix),
            },
            segments: anchor.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: transformContactCone(anchor.contactCone, deltaMatrix, normalMatrix),
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
            anchors: nextAnchors,
            knots: nextKnots,
        };
        notify();
    }

    const kickstandsChanged = transformKickstandsForModel(
        modelId,
        deltaMatrix,
        touchedRootIds,
        touchedKnotIds,
        touchedSegmentIds,
        preserveRootZ,
    );

    return {
        supportsChanged: changed,
        kickstandsChanged,
    };
}

export function transformAllSupportsForSingleModel(
    beforeTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
    afterTransform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 },
): SupportTransformCommitResult {
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
        return {
            supportsChanged: false,
            kickstandsChanged: false,
        };
    }

    const isPureTranslation = eulersRoughlyEqual(beforeTransform.rotation, afterTransform.rotation)
        && vectorsRoughlyEqual(beforeTransform.scale, afterTransform.scale);
    const deltaTranslation = afterTransform.position.clone().sub(beforeTransform.position);
    const preserveRootZ = isPureTranslation && Math.abs(deltaTranslation.z) > 1e-8;

    const deltaMatrix = afterMatrix.clone().multiply(beforeMatrix.clone().invert());
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    const nextRoots: Record<string, Roots> = {};
    for (const root of Object.values(state.roots)) {
        nextRoots[root.id] = {
            ...root,
            transform: {
                ...root.transform,
                pos: preserveRootZ
                    ? transformVec3PreserveZ(root.transform.pos, deltaMatrix)
                    : transformVec3(root.transform.pos, deltaMatrix),
            },
        };
    }

    const nextTrunks: Record<string, Trunk> = {};
    for (const trunk of Object.values(state.trunks)) {
        nextTrunks[trunk.id] = {
            ...trunk,
            segments: trunk.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: trunk.contactCone ? transformContactCone(trunk.contactCone, deltaMatrix, normalMatrix) : trunk.contactCone,
        };
    }

    const nextBranches: Record<string, Branch> = {};
    for (const branch of Object.values(state.branches)) {
        nextBranches[branch.id] = {
            ...branch,
            segments: branch.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: branch.contactCone ? transformContactCone(branch.contactCone, deltaMatrix, normalMatrix) : branch.contactCone,
        };
    }

    const nextLeaves: Record<string, Leaf> = {};
    for (const leaf of Object.values(state.leaves)) {
        nextLeaves[leaf.id] = {
            ...leaf,
            contactCone: transformContactCone(leaf.contactCone, deltaMatrix, normalMatrix),
        };
    }

    const nextTwigs: Record<string, Twig> = {};
    for (const twig of Object.values(state.twigs)) {
        nextTwigs[twig.id] = {
            ...twig,
            segments: twig.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactDiskA: transformContactDisk(twig.contactDiskA, deltaMatrix, normalMatrix),
            contactDiskB: transformContactDisk(twig.contactDiskB, deltaMatrix, normalMatrix),
        };
    }

    const nextSticks: Record<string, Stick> = {};
    for (const stick of Object.values(state.sticks)) {
        nextSticks[stick.id] = {
            ...stick,
            segments: stick.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactConeA: transformContactCone(stick.contactConeA, deltaMatrix, normalMatrix),
            contactConeB: transformContactCone(stick.contactConeB, deltaMatrix, normalMatrix),
        };
    }

    const nextBraces: Record<string, Brace> = {};
    for (const brace of Object.values(state.braces)) {
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

    const nextAnchors: Record<string, Anchor> = {};
    for (const anchor of Object.values(state.anchors)) {
        nextAnchors[anchor.id] = {
            ...anchor,
            rootPos: transformVec3(anchor.rootPos, deltaMatrix),
            joint: {
                ...anchor.joint,
                pos: transformVec3(anchor.joint.pos, deltaMatrix),
            },
            segments: anchor.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
            contactCone: transformContactCone(anchor.contactCone, deltaMatrix, normalMatrix),
        };
    }

    const nextKnots: Record<string, Knot> = {};
    for (const knot of Object.values(state.knots)) {
        nextKnots[knot.id] = {
            ...knot,
            pos: transformVec3(knot.pos, deltaMatrix),
        };
    }

    state = {
        ...state,
        roots: nextRoots,
        trunks: nextTrunks,
        branches: nextBranches,
        leaves: nextLeaves,
        twigs: nextTwigs,
        sticks: nextSticks,
        braces: nextBraces,
        anchors: nextAnchors,
        knots: nextKnots,
    };
    notify();

    const kickstandsChanged = transformAllKickstands(deltaMatrix, preserveRootZ);

    return {
        supportsChanged: true,
        kickstandsChanged,
    };
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
    let targetKickstandId: string | null = null;
    let targetSegmentIndex = -1;
    let container: Trunk | Branch | Twig | Stick | Kickstand | null = null;

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

    // Search Kickstands if not found
    if (!container) {
        const kickstands = Object.values(getKickstandSnapshot().kickstands);
        for (const kickstand of kickstands) {
            const idx = kickstand.segments.findIndex(s => s.id === segmentId);
            if (idx !== -1) {
                targetKickstandId = kickstand.id;
                targetSegmentIndex = idx;
                container = kickstand;
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
        if (segment.bottomJoint) {
            startPos = toVector3(segment.bottomJoint.pos);
        } else if (targetSegmentIndex === 0) {
            if (targetTrunkId) {
                const root = state.roots[(newContainer as Trunk).rootId];
                if (root) {
                    const startZ = root.transform.pos.z + root.diskHeight + root.coneHeight;
                    startPos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, startZ);
                } else {
                    startPos = new THREE.Vector3();
                }
            } else if (targetKickstandId) {
                const root = state.roots[(newContainer as Kickstand).rootId];
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
                startPos = new THREE.Vector3();
            }
        } else {
            const prevSeg = newContainer.segments[targetSegmentIndex - 1];
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
        } else if (targetKickstandId) {
            const hostKnot = state.knots[(newContainer as Kickstand).hostKnotId];
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
    } else if (targetKickstandId) {
        updateKickstand(newContainer as Kickstand);
    }
}

export function resetStore() {
    state = { ...initialState };
    clearSupportSettingsHexCache();
    resetKickstandStore();
    emitSupportInteractionReset('resetStore');
    notify();
}

/**
 * Loads support data from the DragonFruit Interchange Format (e.g. from Lychee conversion).
 */
export function loadFromLychee(data: DragonfruitImportFormat) {
    // Reset first
    resetKickstandStore();

    const newState: SupportState = {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        anchors: {},
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

    // Populate Anchors
    if (data.anchors) {
        data.anchors.forEach(a => {
            newState.anchors[a.id] = a;
        });
    }

    // Populate Knots
    if (data.knots) {
        data.knots.forEach(k => {
            newState.knots[k.id] = k;
        });
    }

    for (const kickstandBuild of data.kickstands ?? []) {
        addKickstand(kickstandBuild);
    }

    const normalized = normalizeLoadedKnotAndLeafGeometry(newState);
    newState.knots = normalized.knots;
    newState.leaves = normalized.leaves;

    state = newState;
    rebuildSupportSettingsHexCacheFromState();
    emitSupportInteractionReset('loadFromLychee');
    console.log('[SupportStore] Loaded from Lychee:', {
        roots: Object.keys(state.roots).length,
        trunks: Object.keys(state.trunks).length,
        branches: Object.keys(state.branches).length,
        leaves: Object.keys(state.leaves).length,
        twigs: Object.keys(state.twigs).length,
        sticks: Object.keys(state.sticks).length,
        braces: Object.keys(state.braces).length,
        anchors: Object.keys(state.anchors).length,
        knots: Object.keys(state.knots).length,
        kickstands: Object.keys(getKickstandSnapshot().kickstands).length,
    });
    notify();
}

function getOrCreateMappedId(sourceId: string, idMap: Map<string, string>): string {
    const mapped = idMap.get(sourceId);
    if (mapped) return mapped;
    const created = generateUuid();
    idMap.set(sourceId, created);
    return created;
}

function remapSupportJoint<T extends { id: string }>(
    joint: T | undefined,
    jointIdMap: Map<string, string>,
): T | undefined {
    if (!joint) return joint;
    const mappedId = getOrCreateMappedId(joint.id, jointIdMap);
    return {
        ...joint,
        id: mappedId,
    };
}

/**
 * Regenerates support primitive IDs (and rewires internal references) so imported payloads
 * are isolated from existing scene data and cannot overwrite by dictionary key collisions.
 */
function isolateImportedSupportPayload(data: DragonfruitImportFormat): DragonfruitImportFormat {
    const cloned = deepClone(data);

    const rootIdMap = new Map<string, string>();
    const knotIdMap = new Map<string, string>();
    const leafIdMap = new Map<string, string>();
    const braceIdMap = new Map<string, string>();
    const segmentIdMap = new Map<string, string>();
    const jointIdMap = new Map<string, string>();

    const kickstandRootIdMap = new Map<string, string>();
    const kickstandKnotIdMap = new Map<string, string>();

    cloned.knots.forEach((knot) => {
        knotIdMap.set(knot.id, generateUuid());
    });

    cloned.roots = cloned.roots.map((root) => {
        const nextId = generateUuid();
        rootIdMap.set(root.id, nextId);
        return {
            ...root,
            id: nextId,
        };
    });

    cloned.trunks = cloned.trunks.map((trunk) => {
        const nextSegments = trunk.segments.map((segment) => {
            const nextSegmentId = generateUuid();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        return {
            ...trunk,
            id: generateUuid(),
            rootId: getOrCreateMappedId(trunk.rootId, rootIdMap),
            segments: nextSegments,
            contactCone: trunk.contactCone
                ? {
                    ...trunk.contactCone,
                    id: generateUuid(),
                    socketJointId: trunk.contactCone.socketJointId
                        ? getOrCreateMappedId(trunk.contactCone.socketJointId, jointIdMap)
                        : trunk.contactCone.socketJointId,
                }
                : trunk.contactCone,
        };
    });

    cloned.branches = cloned.branches.map((branch) => {
        const nextSegments = branch.segments.map((segment) => {
            const nextSegmentId = generateUuid();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        return {
            ...branch,
            id: generateUuid(),
            parentKnotId: getOrCreateMappedId(branch.parentKnotId, knotIdMap),
            segments: nextSegments,
            contactCone: branch.contactCone
                ? {
                    ...branch.contactCone,
                    id: generateUuid(),
                    socketJointId: branch.contactCone.socketJointId
                        ? getOrCreateMappedId(branch.contactCone.socketJointId, jointIdMap)
                        : branch.contactCone.socketJointId,
                }
                : branch.contactCone,
        };
    });

    cloned.leaves = cloned.leaves.map((leaf) => {
        const nextId = generateUuid();
        leafIdMap.set(leaf.id, nextId);
        return {
            ...leaf,
            id: nextId,
            parentKnotId: getOrCreateMappedId(leaf.parentKnotId, knotIdMap),
            contactCone: {
                ...leaf.contactCone,
                id: generateUuid(),
                socketJointId: leaf.contactCone.socketJointId
                    ? getOrCreateMappedId(leaf.contactCone.socketJointId, jointIdMap)
                    : leaf.contactCone.socketJointId,
            },
        };
    });

    cloned.twigs = (cloned.twigs ?? []).map((twig) => {
        const nextSegments = twig.segments.map((segment) => {
            const nextSegmentId = generateUuid();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        return {
            ...twig,
            id: generateUuid(),
            segments: nextSegments,
            contactDiskA: {
                ...twig.contactDiskA,
                id: generateUuid(),
            },
            contactDiskB: {
                ...twig.contactDiskB,
                id: generateUuid(),
            },
        };
    });

    cloned.sticks = (cloned.sticks ?? []).map((stick) => {
        const nextSegments = stick.segments.map((segment) => {
            const nextSegmentId = generateUuid();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        return {
            ...stick,
            id: generateUuid(),
            segments: nextSegments,
            contactConeA: {
                ...stick.contactConeA,
                id: generateUuid(),
                socketJointId: stick.contactConeA.socketJointId
                    ? getOrCreateMappedId(stick.contactConeA.socketJointId, jointIdMap)
                    : stick.contactConeA.socketJointId,
            },
            contactConeB: {
                ...stick.contactConeB,
                id: generateUuid(),
                socketJointId: stick.contactConeB.socketJointId
                    ? getOrCreateMappedId(stick.contactConeB.socketJointId, jointIdMap)
                    : stick.contactConeB.socketJointId,
            },
        };
    });

    cloned.braces = cloned.braces.map((brace) => {
        const nextId = generateUuid();
        braceIdMap.set(brace.id, nextId);
        return {
            ...brace,
            id: nextId,
            startKnotId: getOrCreateMappedId(brace.startKnotId, knotIdMap),
            endKnotId: getOrCreateMappedId(brace.endKnotId, knotIdMap),
        };
    });

    cloned.knots = cloned.knots.map((knot) => {
        let parentShaftId = knot.parentShaftId;
        if (parentShaftId.startsWith('leafCone:')) {
            const leafId = parentShaftId.slice('leafCone:'.length);
            parentShaftId = `leafCone:${getOrCreateMappedId(leafId, leafIdMap)}`;
        } else if (parentShaftId.startsWith('braceSegment:')) {
            const braceId = parentShaftId.slice('braceSegment:'.length);
            parentShaftId = `braceSegment:${getOrCreateMappedId(braceId, braceIdMap)}`;
        } else {
            parentShaftId = getOrCreateMappedId(parentShaftId, segmentIdMap);
        }

        return {
            ...knot,
            id: getOrCreateMappedId(knot.id, knotIdMap),
            parentShaftId,
        };
    });

    cloned.kickstands = (cloned.kickstands ?? []).map((build) => {
        const nextRootId = generateUuid();
        kickstandRootIdMap.set(build.root.id, nextRootId);

        const nextHostKnotId = generateUuid();
        kickstandKnotIdMap.set(build.hostKnot.id, nextHostKnotId);

        const nextKickstandSegments = build.kickstand.segments.map((segment) => {
            const nextSegmentId = generateUuid();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        const hostParentShaftId = build.hostKnot.parentShaftId.startsWith('leafCone:')
            ? `leafCone:${getOrCreateMappedId(build.hostKnot.parentShaftId.slice('leafCone:'.length), leafIdMap)}`
            : build.hostKnot.parentShaftId.startsWith('braceSegment:')
                ? `braceSegment:${getOrCreateMappedId(build.hostKnot.parentShaftId.slice('braceSegment:'.length), braceIdMap)}`
                : getOrCreateMappedId(build.hostKnot.parentShaftId, segmentIdMap);

        return {
            root: {
                ...build.root,
                id: nextRootId,
            },
            hostKnot: {
                ...build.hostKnot,
                id: nextHostKnotId,
                parentShaftId: hostParentShaftId,
            },
            kickstand: {
                ...build.kickstand,
                id: generateUuid(),
                rootId: getOrCreateMappedId(build.kickstand.rootId, kickstandRootIdMap),
                hostKnotId: getOrCreateMappedId(build.kickstand.hostKnotId, kickstandKnotIdMap),
                hostSegmentId: getOrCreateMappedId(build.kickstand.hostSegmentId, segmentIdMap),
                segments: nextKickstandSegments,
            },
        } as KickstandBuildResult;
    });

    return cloned;
}

/**
 * Merges support data from the DragonFruit Interchange Format into the existing scene state,
 * preserving supports for all models already in the scene.
 * Use this when importing an additional scene file into an already-populated scene.
 */
export function mergeFromLychee(data: DragonfruitImportFormat) {
    const isolated = isolateImportedSupportPayload(data);

    const merged: SupportState = {
        ...state,
        roots: { ...state.roots },
        trunks: { ...state.trunks },
        branches: { ...state.branches },
        leaves: { ...state.leaves },
        twigs: { ...state.twigs },
        sticks: { ...state.sticks },
        braces: { ...state.braces },
        anchors: { ...state.anchors },
        knots: { ...state.knots },
    };

    isolated.roots.forEach(r => { merged.roots[r.id] = r; });
    isolated.trunks.forEach(t => { merged.trunks[t.id] = t; });
    isolated.branches.forEach(b => { merged.branches[b.id] = b; });
    isolated.leaves.forEach(l => { merged.leaves[l.id] = l; });
    if (isolated.twigs) { isolated.twigs.forEach(t => { merged.twigs[t.id] = t; }); }
    if (isolated.sticks) { isolated.sticks.forEach(s => { merged.sticks[s.id] = s; }); }
    isolated.braces.forEach(br => { merged.braces[br.id] = br; });
    if (isolated.anchors) { isolated.anchors.forEach(a => { merged.anchors[a.id] = a; }); }
    if (isolated.knots) { isolated.knots.forEach(k => { merged.knots[k.id] = k; }); }

    for (const kickstandBuild of isolated.kickstands ?? []) {
        addKickstand(kickstandBuild);
    }

    const normalized = normalizeLoadedKnotAndLeafGeometry(merged);
    merged.knots = normalized.knots;
    merged.leaves = normalized.leaves;

    state = merged;
    rebuildSupportSettingsHexCacheFromState();
    emitSupportInteractionReset('mergeFromLychee');
    console.log('[SupportStore] Merged from Lychee:', {
        roots: Object.keys(state.roots).length,
        trunks: Object.keys(state.trunks).length,
        branches: Object.keys(state.branches).length,
        leaves: Object.keys(state.leaves).length,
        twigs: Object.keys(state.twigs).length,
        sticks: Object.keys(state.sticks).length,
        braces: Object.keys(state.braces).length,
        anchors: Object.keys(state.anchors).length,
        knots: Object.keys(state.knots).length,
        kickstands: Object.keys(getKickstandSnapshot().kickstands).length,
    });
    notify();
}

export function setSelectedId(id: string | null) {
    if (state.selectedId === id) return;
    const category: SelectionCategory = id ? resolveSelectionCategory(id) : null;

    state = { ...state, selectedId: id, selectedCategory: category };
    notify();
}

export function setHoveredId(id: string | null) {
    if (state.hoveredId === id) return;
    state = { ...state, hoveredId: id };
    notify();
}

export function setHoveredCategory(category: 'model' | 'support' | 'contactDisk' | 'segment' | 'joint' | 'knot' | 'raft' | 'gizmo' | 'none') {
    if (state.hoveredCategory === category) return;
    state = { ...state, hoveredCategory: category };
    notify();
}

export function setHoveredState(
    category: 'model' | 'support' | 'contactDisk' | 'segment' | 'joint' | 'knot' | 'raft' | 'gizmo' | 'none',
    id: string | null,
) {
    if (state.hoveredCategory === category && state.hoveredId === id) return;
    state = { ...state, hoveredCategory: category, hoveredId: id };
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
    if (trunk.settingsCodeHex) {
        setCachedSupportSettingsHex('trunk', trunk.id, trunk.settingsCodeHex);
    }

    state = {
        ...state,
        trunks: { ...state.trunks, [trunk.id]: trunk }
    };
    notify();
}

export function updateTrunk(trunk: Trunk, options?: { skipDependentGeometry?: boolean }) {
    const skipDependentGeometry = options?.skipDependentGeometry === true;

    const cachedHex = getCachedSupportSettingsHex('trunk', trunk.id, trunk.settingsCodeHex ?? undefined);
    const nextTrunk = !trunk.settingsCodeHex && cachedHex
        ? { ...trunk, settingsCodeHex: cachedHex }
        : trunk;

    if (nextTrunk.settingsCodeHex) {
        setCachedSupportSettingsHex('trunk', nextTrunk.id, nextTrunk.settingsCodeHex);
    }

    // Update trunk
    const nextTrunks = { ...state.trunks, [nextTrunk.id]: nextTrunk };

    // Update any knots attached to this trunk's segments
    const root = state.roots[nextTrunk.rootId];
    let nextKnots = state.knots;
    let nextLeaves = state.leaves;
    let knotsChanged = false;

    if (root) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        const updatedKnotPosById: Record<string, Vec3> = {};

        for (const knot of Object.values(state.knots)) {
            // Find if this knot is attached to one of this trunk's segments
            const segIndex = nextTrunk.segments.findIndex(s => s.id === knot.parentShaftId);
            if (segIndex === -1) continue;

            const seg = nextTrunk.segments[segIndex];
            const endpoints = getTrunkSegmentEndpoints(nextTrunk, seg, segIndex, root);
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
            if (skipDependentGeometry) {
                // Drag-time fast path: keep knot positions responsive, defer expensive
                // leaf dependent recomputations until drag commit, but keep braces in sync
                // so they don't visually snap after trunk/branch moves.
                const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, updatedKnots);
                nextKnots = braceSeg.knots;
            } else {
                nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
                const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
                const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
                nextKnots = braceSeg.knots;
            }
        }
    }

    state = {
        ...state,
        trunks: nextTrunks,
        knots: nextKnots,
        leaves: nextLeaves,
    };

    syncKickstandHostKnotsFromSharedKnots(nextKnots);

    notify();
}

export function addBranch(branch: Branch) {
    if (branch.settingsCodeHex) {
        setCachedSupportSettingsHex('branch', branch.id, branch.settingsCodeHex);
    }

    state = {
        ...state,
        branches: { ...state.branches, [branch.id]: branch }
    };
    notify();
}

export function addLeaf(leaf: Leaf) {
    if (leaf.settingsCodeHex) {
        setCachedSupportSettingsHex('leaf', leaf.id, leaf.settingsCodeHex);
    }

    state = {
        ...state,
        leaves: { ...state.leaves, [leaf.id]: leaf }
    };
    notify();
}

export function updateLeaf(leaf: Leaf) {
    if (!state.leaves[leaf.id]) return;

    const cachedHex = getCachedSupportSettingsHex('leaf', leaf.id, leaf.settingsCodeHex ?? undefined);
    const nextLeaf = !leaf.settingsCodeHex && cachedHex
        ? { ...leaf, settingsCodeHex: cachedHex }
        : leaf;

    if (nextLeaf.settingsCodeHex) {
        setCachedSupportSettingsHex('leaf', nextLeaf.id, nextLeaf.settingsCodeHex);
    }

    const nextLeaves = { ...state.leaves, [nextLeaf.id]: nextLeaf };
    const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, state.knots);
    const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);

    state = {
        ...state,
        leaves: nextLeaves,
        knots: braceSeg.knots,
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

export function addAnchor(anchor: Anchor) {
    state = {
        ...state,
        anchors: { ...state.anchors, [anchor.id]: anchor },
    };
    notify();
}

export function updateAnchor(anchor: Anchor) {
    if (!state.anchors[anchor.id]) return;
    state = {
        ...state,
        anchors: { ...state.anchors, [anchor.id]: anchor },
    };
    notify();
}

export function removeAnchor(anchorId: string): { anchor: Anchor } | null {
    const anchor = state.anchors[anchorId];
    if (!anchor) return null;
    const { [anchorId]: _, ...rest } = state.anchors;
    state = { ...state, anchors: rest };
    notify();
    return { anchor };
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

export function removeKickstandCascade(kickstandId: string): KickstandRemoveResult | null {
    const kickstandState = getKickstandSnapshot();
    const kickstand = kickstandState.kickstands[kickstandId];
    if (!kickstand) return null;

    const kickstandSegmentIds = new Set(kickstand.segments.map((segment) => segment.id));
    const directKnotIds = new Set<string>();
    for (const knot of Object.values(state.knots)) {
        if (kickstandSegmentIds.has(knot.parentShaftId)) {
            directKnotIds.add(knot.id);
        }
    }

    const branchIdsToRemove: string[] = [];
    for (const branch of Object.values(state.branches)) {
        if (branch.parentKnotId && directKnotIds.has(branch.parentKnotId)) {
            branchIdsToRemove.push(branch.id);
        }
    }

    const leafIdsToRemove: string[] = [];
    for (const leaf of Object.values(state.leaves)) {
        if (leaf.parentKnotId && directKnotIds.has(leaf.parentKnotId)) {
            leafIdsToRemove.push(leaf.id);
        }
    }

    const braceIdsToRemove: string[] = [];
    for (const brace of Object.values(state.braces)) {
        if ((brace.startKnotId && directKnotIds.has(brace.startKnotId)) || (brace.endKnotId && directKnotIds.has(brace.endKnotId))) {
            braceIdsToRemove.push(brace.id);
        }
    }

    const build = removeKickstand(kickstandId);
    if (!build) return null;

    const snapshots: KickstandRemoveResult = {
        build,
        branches: [],
        braces: [],
        kickstands: [],
        leaves: [],
        knots: [],
    };

    const seenBranchIds = new Set<string>();
    const seenBraceIds = new Set<string>();
    const seenKickstandIds = new Set<string>();
    const seenLeafIds = new Set<string>();
    const seenKnotIds = new Set<string>();

    for (const branchId of branchIdsToRemove) {
        const removed = removeBranch(branchId);
        if (!removed) continue;

        for (const branch of removed.branches ?? []) {
            if (!branch || seenBranchIds.has(branch.id)) continue;
            seenBranchIds.add(branch.id);
            snapshots.branches.push(branch);
        }

        for (const brace of removed.braces ?? []) {
            if (!brace || seenBraceIds.has(brace.id)) continue;
            seenBraceIds.add(brace.id);
            snapshots.braces.push(brace);
        }

        for (const nestedKickstand of removed.kickstands ?? []) {
            if (!nestedKickstand || seenKickstandIds.has(nestedKickstand.kickstand.id)) continue;
            seenKickstandIds.add(nestedKickstand.kickstand.id);
            snapshots.kickstands.push(nestedKickstand);
        }

        for (const leaf of removed.leaves ?? []) {
            if (!leaf || seenLeafIds.has(leaf.id)) continue;
            seenLeafIds.add(leaf.id);
            snapshots.leaves.push(leaf);
        }

        for (const knot of removed.knots ?? []) {
            if (!knot || seenKnotIds.has(knot.id)) continue;
            seenKnotIds.add(knot.id);
            snapshots.knots.push(knot);
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

    for (const knotId of directKnotIds) {
        const removedKnot = removeKnotById(knotId);
        if (!removedKnot || seenKnotIds.has(removedKnot.id)) continue;
        seenKnotIds.add(removedKnot.id);
        snapshots.knots.push(removedKnot);
    }

    if (state.knots[build.hostKnot.id]) {
        removeKnotById(build.hostKnot.id);
    }

    if (state.roots[build.root.id]) {
        removeRootById(build.root.id);
    }

    return snapshots;
}

export function removeBranch(branchId: string): { branches: Branch[]; braces: Brace[]; kickstands: KickstandBuildResult[]; leaves: Leaf[]; knots: Knot[] } | null {
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

    const kickstandState = getKickstandSnapshot();
    const kickstandIdsToRemove = new Set<string>();
    for (const kickstand of Object.values(kickstandState.kickstands)) {
        if (branchSegmentIds.has(kickstand.hostSegmentId) || knotIdsToRemove.has(kickstand.hostKnotId)) {
            kickstandIdsToRemove.add(kickstand.id);
            if (kickstand.hostKnotId) {
                knotIdsToRemove.add(kickstand.hostKnotId);
            }
        }
    }

    const snapshots = {
        branches: Array.from(branchIdsToRemove).map((id) => deepClone(state.branches[id])).filter(Boolean),
        braces: Array.from(braceIdsToRemove).map((id) => deepClone(state.braces[id])).filter(Boolean),
        kickstands: [] as KickstandBuildResult[],
        leaves: Array.from(leafIdsToRemove).map((id) => deepClone(state.leaves[id])).filter(Boolean),
        knots: Array.from(knotIdsToRemove).map((id) => deepClone(state.knots[id])).filter(Boolean),
    };

    const kickstandRootIdsToRemove = new Set<string>();
    for (const kickstandId of kickstandIdsToRemove) {
        const removed = removeKickstandCascade(kickstandId);
        if (!removed) continue;

        snapshots.kickstands.push(removed.build);
        kickstandRootIdsToRemove.add(removed.build.root.id);

        for (const nestedKickstand of removed.kickstands ?? []) {
            snapshots.kickstands.push(nestedKickstand);
            kickstandRootIdsToRemove.add(nestedKickstand.root.id);
        }

        snapshots.branches.push(...removed.branches);
        snapshots.braces.push(...removed.braces);
        snapshots.leaves.push(...removed.leaves);
        snapshots.knots.push(...removed.knots);
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
    if (kickstandRootIdsToRemove.size > 0) {
        const updatedRoots: Record<string, Roots> = { ...state.roots };
        for (const rootId of kickstandRootIdsToRemove) {
            delete updatedRoots[rootId];
        }
        nextRoots = updatedRoots;
    }

    let nextSelectedId = state.selectedId;
    let nextSelectedCategory = state.selectedCategory;
    if (
        (nextSelectedId && branchIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && braceIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && kickstandIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && leafIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && knotIdsToRemove.has(nextSelectedId)) ||
        (nextSelectedId && kickstandRootIdsToRemove.has(nextSelectedId))
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

    for (const id of branchIdsToRemove) {
        deleteCachedSupportSettingsHex('branch', id);
    }
    for (const id of leafIdsToRemove) {
        deleteCachedSupportSettingsHex('leaf', id);
    }

    notify();
    return snapshots;
}

export function updateBranch(branch: Branch, options?: { skipDependentGeometry?: boolean }) {
    const skipDependentGeometry = options?.skipDependentGeometry === true;

    if (!state.branches[branch.id]) return;

    const cachedHex = getCachedSupportSettingsHex('branch', branch.id, branch.settingsCodeHex ?? undefined);
    const nextBranch = !branch.settingsCodeHex && cachedHex
        ? { ...branch, settingsCodeHex: cachedHex }
        : branch;

    if (nextBranch.settingsCodeHex) {
        setCachedSupportSettingsHex('branch', nextBranch.id, nextBranch.settingsCodeHex);
    }

    const nextBranches = { ...state.branches, [nextBranch.id]: nextBranch };

    // Update any knots attached to this branch's segments
    const parentKnot = state.knots[nextBranch.parentKnotId];
    let nextKnots = state.knots;
    let nextLeaves = state.leaves;

    if (parentKnot) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        const updatedKnotPosById: Record<string, Vec3> = {};
        let knotsChanged = false;

        for (const knot of Object.values(state.knots)) {
            const segIndex = nextBranch.segments.findIndex(s => s.id === knot.parentShaftId);
            if (segIndex === -1) continue;

            const seg = nextBranch.segments[segIndex];
            const endpoints = getBranchSegmentEndpoints(nextBranch, seg, segIndex, parentKnot);
            if (!endpoints || knot.t === undefined) continue;

            const newPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, seg, knot.t);
            if (newPos.x === knot.pos.x && newPos.y === knot.pos.y && newPos.z === knot.pos.z) continue;

            updatedKnots[knot.id] = { ...knot, pos: newPos };
            updatedKnotPosById[knot.id] = newPos;
            knotsChanged = true;
        }

        if (knotsChanged) {
            if (skipDependentGeometry) {
                // Drag-time fast path: defer expensive leaf dependent recomputations until commit,
                // but keep brace geometry current so it stays anchored to the moving branch.
                const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, updatedKnots);
                nextKnots = braceSeg.knots;
            } else {
                nextLeaves = recomputeKnotDependentGeometry(state.leaves, updatedKnotPosById);
                const leafCone = recomputeLeafConeKnotGeometry(nextLeaves, updatedKnots);
                const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, leafCone.knots);
                nextKnots = braceSeg.knots;
            }
        }
    }

    state = {
        ...state,
        branches: nextBranches,
        knots: nextKnots,
        leaves: nextLeaves,
    };

    syncKickstandHostKnotsFromSharedKnots(nextKnots);

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

export function updateKnot(knot: Knot, options?: { skipDependentGeometry?: boolean }) {
    const skipDependentGeometry = options?.skipDependentGeometry === true;
    const existing = state.knots[knot.id];
    if (!existing) return;

    const kickstandState = getKickstandSnapshot();
    const hostKickstand = Object.values(kickstandState.kickstands).find((kickstand) => kickstand.hostKnotId === knot.id);
    if (hostKickstand) {
        setKickstandSnapshot({
            ...kickstandState,
            knots: {
                ...kickstandState.knots,
                [knot.id]: knot,
            },
        });
    }

    const baseKnots = { ...state.knots, [knot.id]: knot };

    if (skipDependentGeometry) {
        // Drag-time fast path: keep knot + brace-segment knots responsive while
        // deferring expensive leaf-dependent geometry recomputes until commit.
        const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, baseKnots);
        state = { ...state, knots: braceSeg.knots };
        notify();
        return;
    }

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

export function applyKnotDragFramePreview(
    knot: Knot,
    branchSegmentsById: Record<string, Branch['segments']> = {},
) {
    const existing = state.knots[knot.id];
    if (!existing) return;

    const knotUnchanged = existing.parentShaftId === knot.parentShaftId
        && existing.t === knot.t
        && existing.diameter === knot.diameter
        && existing.pos.x === knot.pos.x
        && existing.pos.y === knot.pos.y
        && existing.pos.z === knot.pos.z;

    let nextBranches = state.branches;
    const branchIds = Object.keys(branchSegmentsById);
    let branchesChanged = false;
    if (branchIds.length > 0) {
        const updatedBranches: Record<string, Branch> = { ...state.branches };

        for (const branchId of branchIds) {
            const branch = state.branches[branchId];
            const nextSegments = branchSegmentsById[branchId];
            if (!branch || !nextSegments) continue;
            if (branch.segments === nextSegments) continue;
            updatedBranches[branchId] = { ...branch, segments: nextSegments };
            branchesChanged = true;
        }

        if (branchesChanged) {
            nextBranches = updatedBranches;
        }
    }

    if (knotUnchanged && !branchesChanged) {
        return;
    }

    if (!knotUnchanged) {
        const kickstandState = getKickstandSnapshot();
        const hostKickstand = Object.values(kickstandState.kickstands).find((kickstand) => kickstand.hostKnotId === knot.id);
        if (hostKickstand) {
            setKickstandSnapshot({
                ...kickstandState,
                knots: {
                    ...kickstandState.knots,
                    [knot.id]: knot,
                },
            });
        }
    }

    let nextKnots = state.knots;
    if (!knotUnchanged) {
        const baseKnots = { ...state.knots, [knot.id]: knot };
        const braceSeg = recomputeBraceSegmentKnotGeometry(state.braces, baseKnots);
        nextKnots = braceSeg.knots;
    }

    state = {
        ...state,
        branches: nextBranches,
        knots: nextKnots,
    };

    if (!knotUnchanged) {
        syncKickstandHostKnotsFromSharedKnots(nextKnots);
    }

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

    deleteCachedSupportSettingsHex('leaf', leafId);

    notify();
    return snapshots;
}

export function removeTrunk(
    trunkId: string
): { trunk: Trunk; root: Roots | null; branches: Branch[]; braces: Brace[]; kickstands: KickstandBuildResult[]; leaves: Leaf[]; knots: Knot[] } | null {
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

    const snapshots: { trunk: Trunk; root: Roots | null; branches: Branch[]; braces: Brace[]; kickstands: KickstandBuildResult[]; leaves: Leaf[]; knots: Knot[] } = {
        trunk: deepClone(existingTrunk),
        root: null,
        branches: [],
        braces: [],
        kickstands: [],
        leaves: [],
        knots: [],
    };

    const seenBranchIds = new Set<string>();
    const seenBraceIds = new Set<string>();
    const seenKickstandIds = new Set<string>();
    const seenLeafIds = new Set<string>();
    const seenKnotIds = new Set<string>();
    const kickstandRootIdsToRemove = new Set<string>();

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
        for (const kickstandBuild of removed.kickstands ?? []) {
            if (!kickstandBuild || seenKickstandIds.has(kickstandBuild.kickstand.id)) continue;
            seenKickstandIds.add(kickstandBuild.kickstand.id);
            snapshots.kickstands.push(kickstandBuild);
            kickstandRootIdsToRemove.add(kickstandBuild.root.id);
            seenKnotIds.add(kickstandBuild.hostKnot.id);
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

    const kickstandState = getKickstandSnapshot();
    const kickstandIdsToRemove = new Set<string>();
    for (const kickstand of Object.values(kickstandState.kickstands)) {
        if (trunkSegmentIds.has(kickstand.hostSegmentId) || trunkHostedKnotIds.has(kickstand.hostKnotId)) {
            kickstandIdsToRemove.add(kickstand.id);
        }
    }

    for (const kickstandId of kickstandIdsToRemove) {
        const removed = removeKickstandCascade(kickstandId);
        if (!removed) continue;

        if (!seenKickstandIds.has(removed.build.kickstand.id)) {
            seenKickstandIds.add(removed.build.kickstand.id);
            snapshots.kickstands.push(removed.build);
            kickstandRootIdsToRemove.add(removed.build.root.id);
        }

        for (const nestedKickstand of removed.kickstands ?? []) {
            if (!nestedKickstand || seenKickstandIds.has(nestedKickstand.kickstand.id)) continue;
            seenKickstandIds.add(nestedKickstand.kickstand.id);
            snapshots.kickstands.push(nestedKickstand);
            kickstandRootIdsToRemove.add(nestedKickstand.root.id);
        }

        for (const branch of removed.branches ?? []) {
            if (!branch || seenBranchIds.has(branch.id)) continue;
            seenBranchIds.add(branch.id);
            snapshots.branches.push(branch);
        }

        for (const brace of removed.braces ?? []) {
            if (!brace || seenBraceIds.has(brace.id)) continue;
            seenBraceIds.add(brace.id);
            snapshots.braces.push(brace);
        }

        for (const leaf of removed.leaves ?? []) {
            if (!leaf || seenLeafIds.has(leaf.id)) continue;
            seenLeafIds.add(leaf.id);
            snapshots.leaves.push(leaf);
        }

        for (const knot of removed.knots ?? []) {
            if (!knot || seenKnotIds.has(knot.id)) continue;
            seenKnotIds.add(knot.id);
            snapshots.knots.push(knot);
        }
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
    if (kickstandRootIdsToRemove.size > 0) {
        const updatedRoots: Record<string, Roots> = { ...nextRoots };
        for (const rootId of kickstandRootIdsToRemove) {
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
    } else if (state.selectedId && seenKickstandIds.has(state.selectedId)) {
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

    deleteCachedSupportSettingsHex('trunk', trunkId);
    for (const branch of snapshots.branches) {
        deleteCachedSupportSettingsHex('branch', branch.id);
    }
    for (const leaf of snapshots.leaves) {
        deleteCachedSupportSettingsHex('leaf', leaf.id);
    }

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

export function getAnchors() {
    return Object.values(state.anchors);
}

export function getAnchorById(anchorId: string) {
    return state.anchors[anchorId] ?? null;
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
    if (state.anchors[id]) return state.anchors[id].modelId ?? null;

    const kickstandState = getKickstandSnapshot();
    const directKickstand = kickstandState.kickstands[id];
    if (directKickstand) return directKickstand.modelId ?? null;

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

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        if (kickstand.hostKnotId === id) return kickstand.modelId ?? null;
        if (kickstand.segments.some((segment) => segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
            return kickstand.modelId ?? null;
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

export type EditableSupportKind = 'trunk' | 'branch' | 'leaf';

export type EditableSupportTarget = {
    kind: EditableSupportKind;
    id: string;
};

function mergeSettingsWithDefaults(base?: SupportSettings): SupportSettings {
    const defaults = createDefaultSettings();
    if (!base) return defaults;

    return {
        ...defaults,
        ...base,
        tip: { ...defaults.tip, ...base.tip },
        shaft: { ...defaults.shaft, ...base.shaft },
        roots: { ...defaults.roots, ...base.roots },
        baseFlare: { ...defaults.baseFlare, ...base.baseFlare },
        joint: { ...defaults.joint, ...base.joint },
        grid: { ...defaults.grid, ...base.grid },
        meshToMesh: { ...defaults.meshToMesh, ...base.meshToMesh },
        autoBracing: { ...defaults.autoBracing, ...base.autoBracing },
    };
}

function inferSettingsFromTrunk(trunk: Trunk, root: Roots | null, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = trunk.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;
    const shaftDiameter = trunk.baseDiameterMm ?? trunk.segments[0]?.diameter ?? merged.shaft.diameterMm;

    return {
        ...merged,
        tip: {
            ...merged.tip,
            contactDiameterMm: coneProfile?.contactDiameterMm ?? merged.tip.contactDiameterMm,
            bodyDiameterMm: coneProfile?.bodyDiameterMm ?? merged.tip.bodyDiameterMm,
            lengthMm: coneProfile?.lengthMm ?? merged.tip.lengthMm,
            penetrationMm: coneProfile?.penetrationMm ?? merged.tip.penetrationMm,
            diskThicknessMm: diskConeProfile?.diskThicknessMm ?? merged.tip.diskThicknessMm,
            maxStandoffMm: diskConeProfile?.maxStandoffMm ?? merged.tip.maxStandoffMm,
            standoffAngleThreshold: diskConeProfile?.standoffAngleThreshold ?? merged.tip.standoffAngleThreshold,
        },
        shaft: {
            ...merged.shaft,
            diameterMm: shaftDiameter,
            secondaryDiameterMm: shaftDiameter,
        },
        roots: {
            ...merged.roots,
            diameterMm: root?.diameter ?? merged.roots.diameterMm,
            diskHeightMm: root?.diskHeight ?? merged.roots.diskHeightMm,
            coneHeightMm: root?.coneHeight ?? merged.roots.coneHeightMm,
        },
    };
}

function inferSettingsFromBranch(branch: Branch, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = branch.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;
    const shaftDiameter = branch.segments[0]?.diameter ?? merged.shaft.diameterMm;

    return {
        ...merged,
        tip: {
            ...merged.tip,
            contactDiameterMm: coneProfile?.contactDiameterMm ?? merged.tip.contactDiameterMm,
            bodyDiameterMm: coneProfile?.bodyDiameterMm ?? merged.tip.bodyDiameterMm,
            lengthMm: coneProfile?.lengthMm ?? merged.tip.lengthMm,
            penetrationMm: coneProfile?.penetrationMm ?? merged.tip.penetrationMm,
            diskThicknessMm: diskConeProfile?.diskThicknessMm ?? merged.tip.diskThicknessMm,
            maxStandoffMm: diskConeProfile?.maxStandoffMm ?? merged.tip.maxStandoffMm,
            standoffAngleThreshold: diskConeProfile?.standoffAngleThreshold ?? merged.tip.standoffAngleThreshold,
        },
        shaft: {
            ...merged.shaft,
            diameterMm: shaftDiameter,
            secondaryDiameterMm: shaftDiameter,
        },
    };
}

function inferSettingsFromLeaf(leaf: Leaf, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = leaf.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;

    return {
        ...merged,
        tip: {
            ...merged.tip,
            contactDiameterMm: coneProfile?.contactDiameterMm ?? merged.tip.contactDiameterMm,
            bodyDiameterMm: coneProfile?.bodyDiameterMm ?? merged.tip.bodyDiameterMm,
            lengthMm: coneProfile?.lengthMm ?? merged.tip.lengthMm,
            penetrationMm: coneProfile?.penetrationMm ?? merged.tip.penetrationMm,
            diskThicknessMm: diskConeProfile?.diskThicknessMm ?? merged.tip.diskThicknessMm,
            maxStandoffMm: diskConeProfile?.maxStandoffMm ?? merged.tip.maxStandoffMm,
            standoffAngleThreshold: diskConeProfile?.standoffAngleThreshold ?? merged.tip.standoffAngleThreshold,
        },
    };
}

function updateSegmentDiametersAndJoints(
    segments: Segment[],
    shaftDiameterMm: number,
    socketJointId?: string,
    socketPos?: Vec3,
): Segment[] {
    const jointDiameter = getJointDiameter(shaftDiameterMm);
    return segments.map((segment) => {
        const nextTopJoint = segment.topJoint
            ? {
                ...segment.topJoint,
                diameter: jointDiameter,
                pos: socketJointId && socketPos && segment.topJoint.id === socketJointId
                    ? { ...socketPos }
                    : segment.topJoint.pos,
            }
            : segment.topJoint;

        const nextBottomJoint = segment.bottomJoint
            ? {
                ...segment.bottomJoint,
                diameter: jointDiameter,
                pos: socketJointId && socketPos && segment.bottomJoint.id === socketJointId
                    ? { ...socketPos }
                    : segment.bottomJoint.pos,
            }
            : segment.bottomJoint;

        return {
            ...segment,
            diameter: shaftDiameterMm,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });
}

export function resolveEditableSupportTarget(selectedId: string | null, selectedCategory: SelectionCategory | undefined): EditableSupportTarget | null {
    if (!selectedId) return null;

    if (selectedCategory === 'trunk' || selectedCategory === 'branch' || selectedCategory === 'leaf') {
        return { kind: selectedCategory, id: selectedId };
    }

    if (selectedCategory === 'root') {
        const trunk = Object.values(state.trunks).find((candidate) => candidate.rootId === selectedId);
        if (!trunk) return null;
        return { kind: 'trunk', id: trunk.id };
    }

    if (selectedCategory === 'segment' || selectedCategory === 'joint') {
        for (const trunk of Object.values(state.trunks)) {
            const owns = trunk.segments.some((segment) => {
                if (selectedCategory === 'segment') return segment.id === selectedId;
                return segment.topJoint?.id === selectedId || segment.bottomJoint?.id === selectedId || trunk.contactCone?.socketJointId === selectedId;
            });
            if (owns) return { kind: 'trunk', id: trunk.id };
        }

        for (const branch of Object.values(state.branches)) {
            const owns = branch.segments.some((segment) => {
                if (selectedCategory === 'segment') return segment.id === selectedId;
                return segment.topJoint?.id === selectedId || segment.bottomJoint?.id === selectedId || branch.contactCone?.socketJointId === selectedId;
            });
            if (owns) return { kind: 'branch', id: branch.id };
        }
    }

    if (selectedCategory === 'contactDisk') {
        for (const trunk of Object.values(state.trunks)) {
            if (trunk.contactCone?.id === selectedId) {
                return { kind: 'trunk', id: trunk.id };
            }
        }

        for (const branch of Object.values(state.branches)) {
            if (branch.contactCone?.id === selectedId) {
                return { kind: 'branch', id: branch.id };
            }
        }

        for (const leaf of Object.values(state.leaves)) {
            if (leaf.contactCone?.id === selectedId) {
                return { kind: 'leaf', id: leaf.id };
            }
        }
    }

    if (selectedCategory === 'knot') {
        const knot = state.knots[selectedId];
        if (!knot) return null;

        if (knot.parentShaftId.startsWith('leafCone:')) {
            const leafId = knot.parentShaftId.slice('leafCone:'.length);
            if (state.leaves[leafId]) return { kind: 'leaf', id: leafId };
        }

        for (const trunk of Object.values(state.trunks)) {
            if (trunk.segments.some((segment) => segment.id === knot.parentShaftId)) {
                return { kind: 'trunk', id: trunk.id };
            }
        }

        for (const branch of Object.values(state.branches)) {
            if (branch.segments.some((segment) => segment.id === knot.parentShaftId) || branch.parentKnotId === selectedId) {
                return { kind: 'branch', id: branch.id };
            }
        }

        for (const leaf of Object.values(state.leaves)) {
            if (leaf.parentKnotId === selectedId) {
                return { kind: 'leaf', id: leaf.id };
            }
        }
    }

    // Fallback: if category-based routing failed, resolve by ownership scans.
    if (state.trunks[selectedId]) return { kind: 'trunk', id: selectedId };
    if (state.branches[selectedId]) return { kind: 'branch', id: selectedId };
    if (state.leaves[selectedId]) return { kind: 'leaf', id: selectedId };

    for (const trunk of Object.values(state.trunks)) {
        if (trunk.rootId === selectedId) return { kind: 'trunk', id: trunk.id };
        if (trunk.contactCone?.id === selectedId) return { kind: 'trunk', id: trunk.id };
        if (trunk.contactCone?.socketJointId === selectedId) return { kind: 'trunk', id: trunk.id };
        if (trunk.segments.some((segment) => segment.id === selectedId || segment.topJoint?.id === selectedId || segment.bottomJoint?.id === selectedId)) {
            return { kind: 'trunk', id: trunk.id };
        }
    }

    for (const branch of Object.values(state.branches)) {
        if (branch.contactCone?.id === selectedId) return { kind: 'branch', id: branch.id };
        if (branch.contactCone?.socketJointId === selectedId) return { kind: 'branch', id: branch.id };
        if (branch.segments.some((segment) => segment.id === selectedId || segment.topJoint?.id === selectedId || segment.bottomJoint?.id === selectedId)) {
            return { kind: 'branch', id: branch.id };
        }
    }

    for (const leaf of Object.values(state.leaves)) {
        if (leaf.contactCone?.id === selectedId) return { kind: 'leaf', id: leaf.id };
        if (leaf.contactCone?.socketJointId === selectedId) return { kind: 'leaf', id: leaf.id };
        if (leaf.parentKnotId === selectedId) return { kind: 'leaf', id: leaf.id };
    }

    if (state.knots[selectedId]) {
        const knot = state.knots[selectedId];
        if (knot.parentShaftId.startsWith('leafCone:')) {
            const leafId = knot.parentShaftId.slice('leafCone:'.length);
            if (state.leaves[leafId]) return { kind: 'leaf', id: leafId };
        }

        for (const trunk of Object.values(state.trunks)) {
            if (trunk.segments.some((segment) => segment.id === knot.parentShaftId)) {
                return { kind: 'trunk', id: trunk.id };
            }
        }

        for (const branch of Object.values(state.branches)) {
            if (branch.segments.some((segment) => segment.id === knot.parentShaftId) || branch.parentKnotId === selectedId) {
                return { kind: 'branch', id: branch.id };
            }
        }
    }

    return null;
}

export function getSupportSettingsForTarget(target: EditableSupportTarget, base?: SupportSettings): SupportSettings | null {
    if (target.kind === 'trunk') {
        const trunk = state.trunks[target.id];
        if (!trunk) return null;
        const root = state.roots[trunk.rootId] ?? null;
        const encoded = getCachedSupportSettingsHex('trunk', trunk.id, trunk.settingsCodeHex);
        const decoded = encoded ? decodeSupportSettingsHex(encoded, base) : null;
        logSupportSettingsDebug('read target', target, {
            hasHex: Boolean(encoded),
            hexPreview: encoded?.slice(0, 18),
            decodeOk: Boolean(decoded),
            source: decoded ? 'hex' : 'inferred',
        });
        return decoded ?? inferSettingsFromTrunk(trunk, root, base);
    }

    if (target.kind === 'branch') {
        const branch = state.branches[target.id];
        if (!branch) return null;
        const encoded = getCachedSupportSettingsHex('branch', branch.id, branch.settingsCodeHex);
        const decoded = encoded ? decodeSupportSettingsHex(encoded, base) : null;
        logSupportSettingsDebug('read target', target, {
            hasHex: Boolean(encoded),
            hexPreview: encoded?.slice(0, 18),
            decodeOk: Boolean(decoded),
            source: decoded ? 'hex' : 'inferred',
        });
        return decoded ?? inferSettingsFromBranch(branch, base);
    }

    const leaf = state.leaves[target.id];
    if (!leaf) return null;
    const encoded = getCachedSupportSettingsHex('leaf', leaf.id, leaf.settingsCodeHex);
    const decoded = encoded ? decodeSupportSettingsHex(encoded, base) : null;
    logSupportSettingsDebug('read target', target, {
        hasHex: Boolean(encoded),
        hexPreview: encoded?.slice(0, 18),
        decodeOk: Boolean(decoded),
        source: decoded ? 'hex' : 'inferred',
    });
    return decoded ?? inferSettingsFromLeaf(leaf, base);
}

export function getSupportSettingsForSelection(
    selectedId: string | null,
    selectedCategory: SelectionCategory | undefined,
    base?: SupportSettings,
): SupportSettings | null {
    const target = resolveEditableSupportTarget(selectedId, selectedCategory);
    if (!target) return null;
    return getSupportSettingsForTarget(target, base);
}

function applyTipSettingsToConeProfile(
    profile: SupportTipProfile,
    tip: SupportSettings['tip'],
    options?: { includeBodyAndLength?: boolean },
): SupportTipProfile {
    const includeBodyAndLength = options?.includeBodyAndLength ?? true;
    const baseProfile = includeBodyAndLength
        ? {
            ...profile,
            contactDiameterMm: tip.contactDiameterMm,
            bodyDiameterMm: tip.bodyDiameterMm,
            lengthMm: tip.lengthMm,
            penetrationMm: tip.penetrationMm,
        }
        : {
            ...profile,
            contactDiameterMm: tip.contactDiameterMm,
            penetrationMm: tip.penetrationMm,
        };

    if (profile.type === 'disk') {
        return {
            ...baseProfile,
            type: 'disk',
            diskThicknessMm: tip.diskThicknessMm ?? profile.diskThicknessMm,
            maxStandoffMm: tip.maxStandoffMm ?? profile.maxStandoffMm,
            standoffAngleThreshold: tip.standoffAngleThreshold ?? profile.standoffAngleThreshold,
        };
    }

    if (profile.type === 'sphere') {
        return {
            ...baseProfile,
            type: 'sphere',
            sphereRadiusRatio: tip.sphereRadiusRatio ?? profile.sphereRadiusRatio,
        };
    }

    return baseProfile;
}

export function applySettingsToSupportTarget(target: EditableSupportTarget, settings: SupportSettings): boolean {
    logSupportSettingsDebug('apply start', target);

    if (target.kind === 'trunk') {
        const trunk = state.trunks[target.id];
        if (!trunk) return false;

        const root = state.roots[trunk.rootId];
        if (!root) return false;

        const nextRoot: Roots = {
            ...root,
            diameter: settings.roots.diameterMm,
            diskHeight: settings.roots.diskHeightMm,
            coneHeight: settings.roots.coneHeightMm,
        };

        const nextContactCone = trunk.contactCone
            ? {
                ...trunk.contactCone,
                profile: applyTipSettingsToConeProfile(trunk.contactCone.profile, settings.tip),
            }
            : trunk.contactCone;

        const socketPos = nextContactCone ? getFinalSocketPosition(nextContactCone) : undefined;
        const nextSegments = updateSegmentDiametersAndJoints(
            trunk.segments,
            settings.shaft.diameterMm,
            nextContactCone?.socketJointId,
            socketPos,
        );
        const nextTrunkSettingsCodeHex = encodeSupportSettingsHex(settings);

        const nextTrunk: Trunk = {
            ...trunk,
            settingsCodeHex: nextTrunkSettingsCodeHex,
            baseDiameterMm: settings.shaft.diameterMm,
            segments: nextSegments,
            contactCone: nextContactCone,
        };

        setCachedSupportSettingsHex('trunk', nextTrunk.id, nextTrunkSettingsCodeHex);

        logSupportSettingsDebug('apply trunk hex', {
            target,
            prevHex: trunk.settingsCodeHex?.slice(0, 18),
            nextHex: nextTrunk.settingsCodeHex?.slice(0, 18),
        });

        state = {
            ...state,
            roots: {
                ...state.roots,
                [nextRoot.id]: nextRoot,
            },
        };

        updateTrunk(nextTrunk);
        logSupportSettingsDebug('apply done', target);
        return true;
    }

    if (target.kind === 'branch') {
        const branch = state.branches[target.id];
        if (!branch) return false;

        const nextContactCone = branch.contactCone
            ? {
                ...branch.contactCone,
                profile: applyTipSettingsToConeProfile(branch.contactCone.profile, settings.tip),
            }
            : branch.contactCone;

        const socketPos = nextContactCone ? getFinalSocketPosition(nextContactCone) : undefined;
        const nextSegments = updateSegmentDiametersAndJoints(
            branch.segments,
            settings.shaft.diameterMm,
            nextContactCone?.socketJointId,
            socketPos,
        );
        const nextBranchSettingsCodeHex = encodeSupportSettingsHex(settings);

        const nextBranch: Branch = {
            ...branch,
            settingsCodeHex: nextBranchSettingsCodeHex,
            segments: nextSegments,
            contactCone: nextContactCone,
        };

        setCachedSupportSettingsHex('branch', nextBranch.id, nextBranchSettingsCodeHex);

        logSupportSettingsDebug('apply branch hex', {
            target,
            prevHex: branch.settingsCodeHex?.slice(0, 18),
            nextHex: nextBranch.settingsCodeHex?.slice(0, 18),
        });

        updateBranch(nextBranch);
        logSupportSettingsDebug('apply done', target);
        return true;
    }

    const leaf = state.leaves[target.id];
    if (!leaf) return false;

    const nextLeafSettingsCodeHex = encodeSupportSettingsHex(settings);
    const nextLeaf: Leaf = {
        ...leaf,
        settingsCodeHex: nextLeafSettingsCodeHex,
        contactCone: {
            ...leaf.contactCone,
            profile: applyTipSettingsToConeProfile(leaf.contactCone.profile, settings.tip, { includeBodyAndLength: false }),
        },
    };

    setCachedSupportSettingsHex('leaf', nextLeaf.id, nextLeafSettingsCodeHex);

    logSupportSettingsDebug('apply leaf hex', {
        target,
        prevHex: leaf.settingsCodeHex?.slice(0, 18),
        nextHex: nextLeaf.settingsCodeHex?.slice(0, 18),
    });

    updateLeaf(nextLeaf);
    logSupportSettingsDebug('apply done', target);
    return true;
}

export function applySettingsToSupportSelection(
    selectedId: string | null,
    selectedCategory: SelectionCategory | undefined,
    settings: SupportSettings,
): boolean {
    const target = resolveEditableSupportTarget(selectedId, selectedCategory);
    if (!target) return false;
    return applySettingsToSupportTarget(target, settings);
}
