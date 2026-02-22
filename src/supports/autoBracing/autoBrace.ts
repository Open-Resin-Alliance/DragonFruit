import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { getSettings } from '../Settings/state';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';
import { getSupportBraceSnapshot } from '../SupportTypes/SupportBrace/supportBraceStore';
import {
    SUPPORT_AUTO_BRACE_REPLACE,
    type SupportReplaceStatePayload,
} from '../history/actionTypes';
import { getSnapshot, setSnapshot } from '../state';
import {
    calculateKnotPositionOnSegmentFromT,
    getTrunkSegmentEndpoints,
} from '../SupportPrimitives/Knot/knotUtils';
import { JOINT_DIAMETER_OFFSET_MM } from '../constants';
import type {
    Brace,
    Branch,
    Knot,
    Segment,
    SupportState,
    Trunk,
    Vec3,
} from '../types';
import {
    AUTO_BRACING_HARD_RULES,
    normalizeAutoBracingSettings,
    type AutoBracingPattern,
    type AutoBracingSettings,
} from './settings';

type SupportKind = 'trunk' | 'branch' | 'supportBrace';

const MESH_CLEARANCE_MM = 1.0;
const BRACE_CLEARANCE_SAMPLE_COUNT = 12;

/**
 * Returns true if the brace centerline from posA to posB maintains at least
 * MESH_CLEARANCE_MM + braceDiameterMm/2 clearance from all registered mesh surfaces.
 * Samples points along the brace, transforms to local mesh space, and queries BVH.
 * The BVH closestPointToPoint returns distance in local space; we convert to world
 * space using the mesh's uniform scale factor.
 */
function bracePassesMeshClearance(posA: Vec3, posB: Vec3, modelId: string, braceDiameterMm: number): boolean {
    const minClearance = MESH_CLEARANCE_MM + braceDiameterMm / 2;
    const meshEntries = getAllMeshEntriesForAutoBrace();

    const entry = meshEntries.get(modelId);
    if (!entry) return true;

    const bvh = (entry.geometry as any).boundsTree;
    if (!bvh) return true;

    const inverseMatrix = entry.transform.clone().invert();

    // Extract world-space scale to convert local distances back to world distances.
    const scaleVec = new THREE.Vector3();
    entry.transform.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleVec);
    const worldScale = (scaleVec.x + scaleVec.y + scaleVec.z) / 3;

    const ax = posA.x, ay = posA.y, az = posA.z;
    const bx = posB.x, by = posB.y, bz = posB.z;
    const resultTarget: { point?: THREE.Vector3; distance?: number } = {};

    for (let i = 0; i <= BRACE_CLEARANCE_SAMPLE_COUNT; i++) {
        const t = i / BRACE_CLEARANCE_SAMPLE_COUNT;
        const worldPoint = new THREE.Vector3(
            ax + (bx - ax) * t,
            ay + (by - ay) * t,
            az + (bz - az) * t,
        );
        const localPoint = worldPoint.clone().applyMatrix4(inverseMatrix);
        const result = bvh.closestPointToPoint(localPoint, resultTarget);
        if (!result) continue;

        // result.distance is in local space; multiply by worldScale to get world mm
        const worldDist = (result.distance as number) * worldScale;
        if (worldDist < minClearance) return false;
    }

    return true;
}

type SegmentSample = {
    segmentId: string;
    segment: Segment;
    start: Vec3;
    end: Vec3;
    diameterMm: number;
};

type SupportSample = {
    supportId: string;
    supportKind: SupportKind;
    modelId: string;
    segments: SegmentSample[];
    topReferenceZ: number;
    bottomReferenceZ: number;
    sortAnchor: Vec3;
};

type AnchorPoint = {
    supportId: string;
    modelId: string;
    segmentId: string;
    t: number;
    pos: Vec3;
    hostDiameterMm: number;
};

type AnchorCandidate = {
    segment: SegmentSample;
    t: number;
    pos: Vec3;
    score: number;
};

type AnchorSpec = {
    anchorZ: number;
};

export interface AutoBraceResult {
    generatedBraceCount: number;
    removedBraceCount: number;
    skippedSupportCount: number;
    underQualifiedSupportCount: number;
    changed: boolean;
    message: string;
}

type BuildSnapshotResult = AutoBraceResult & {
    snapshot: SupportState;
};

const ANCHOR_Z_TOLERANCE_MM = 0.3;

function clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function sortSupports(a: SupportSample, b: SupportSample): number {
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    if (a.sortAnchor.x !== b.sortAnchor.x) return a.sortAnchor.x - b.sortAnchor.x;
    if (a.sortAnchor.y !== b.sortAnchor.y) return a.sortAnchor.y - b.sortAnchor.y;
    if (a.sortAnchor.z !== b.sortAnchor.z) return a.sortAnchor.z - b.sortAnchor.z;
    if (a.supportKind !== b.supportKind) return a.supportKind.localeCompare(b.supportKind);
    return a.supportId.localeCompare(b.supportId);
}

function createUniqueIdFactory(prefix: string, existingIds: Set<string>) {
    let index = 1;
    return () => {
        while (true) {
            const id = `${prefix}-${index}`;
            index += 1;
            if (!existingIds.has(id)) {
                existingIds.add(id);
                return id;
            }
        }
    };
}

function collectSegmentExtrema(segments: SegmentSample[]): { topReferenceZ: number; bottomReferenceZ: number; sortAnchor: Vec3 } {
    let topPoint: Vec3 | null = null;
    let bottomPoint: Vec3 | null = null;

    for (const segment of segments) {
        const points = [segment.start, segment.end];
        for (const point of points) {
            if (!topPoint || point.z > topPoint.z) topPoint = point;
            if (!bottomPoint || point.z < bottomPoint.z) bottomPoint = point;
        }
    }

    if (!topPoint || !bottomPoint) {
        return {
            topReferenceZ: 0,
            bottomReferenceZ: 0,
            sortAnchor: { x: 0, y: 0, z: 0 },
        };
    }

    return {
        topReferenceZ: topPoint.z,
        bottomReferenceZ: bottomPoint.z,
        sortAnchor: topPoint,
    };
}

function buildSupportSamples(snapshot: SupportState): SupportSample[] {
    const supports: SupportSample[] = [];
    const supportBraceSnapshot = getSupportBraceSnapshot();

    for (const trunk of Object.values(snapshot.trunks)) {
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;

        const segments: SegmentSample[] = [];
        trunk.segments.forEach((segment, segmentIndex) => {
            const endpoints = getTrunkSegmentEndpoints(trunk, segment, segmentIndex, root);
            if (!endpoints) return;
            segments.push({
                segmentId: segment.id,
                segment,
                start: endpoints.start,
                end: endpoints.end,
                diameterMm: segment.diameter,
            });
        });

        if (segments.length === 0) continue;

        const extrema = collectSegmentExtrema(segments);
        supports.push({
            supportId: trunk.id,
            supportKind: 'trunk',
            modelId: trunk.modelId,
            segments,
            topReferenceZ: extrema.topReferenceZ,
            bottomReferenceZ: extrema.bottomReferenceZ,
            sortAnchor: extrema.sortAnchor,
        });
    }

    for (const supportBrace of Object.values(supportBraceSnapshot.supportBraces)) {
        const root = snapshot.roots[supportBrace.rootId] ?? supportBraceSnapshot.roots[supportBrace.rootId];
        const hostKnot = snapshot.knots[supportBrace.hostKnotId] ?? supportBraceSnapshot.knots[supportBrace.hostKnotId];
        if (!root || !hostKnot) continue;

        const segments: SegmentSample[] = [];
        let startPos: Vec3 = {
            x: root.transform.pos.x,
            y: root.transform.pos.y,
            z: root.transform.pos.z + root.diskHeight + root.coneHeight,
        };

        supportBrace.segments.forEach((segment, segmentIndex) => {
            const endPos = segment.topJoint?.pos ?? hostKnot.pos;
            segments.push({
                segmentId: segment.id,
                segment,
                start: startPos,
                end: endPos,
                diameterMm: segment.diameter,
            });

            const nextStart = supportBrace.segments[segmentIndex].topJoint?.pos;
            if (nextStart) {
                startPos = nextStart;
            }
        });

        if (segments.length === 0) continue;

        const extrema = collectSegmentExtrema(segments);
        supports.push({
            supportId: supportBrace.id,
            supportKind: 'supportBrace',
            modelId: supportBrace.modelId,
            segments,
            topReferenceZ: extrema.topReferenceZ,
            bottomReferenceZ: extrema.bottomReferenceZ,
            sortAnchor: extrema.sortAnchor,
        });
    }

    // Branches are excluded from auto-bracing for now — separate logic TBD.

    supports.sort(sortSupports);
    return supports;
}

type PairPlacementResult = { anchorA: AnchorPoint; anchorB: AnchorPoint };

function validateCandidate(
    anchorA: AnchorPoint,
    anchorB: AnchorPoint,
): boolean {
    const dx = anchorB.pos.x - anchorA.pos.x;
    const dy = anchorB.pos.y - anchorA.pos.y;
    const dz = Math.abs(anchorB.pos.z - anchorA.pos.z);
    const hDist = Math.sqrt(dx * dx + dy * dy);
    if (hDist < 0.001) return false;

    const angleDeg = Math.abs(Math.atan2(dz, hDist) * (180 / Math.PI));
    const deviation = Math.abs(angleDeg - AUTO_BRACING_HARD_RULES.braceAngleDeg);
    if (deviation > 20) return false;

    // Filter on horizontal distance — maxBraceLengthMm controls how far apart two supports
    // can be and still be braced. At 45°, 3D length = hDist×√2, but hDist is the more
    // intuitive limit (neighbor spacing in XY).
    return hDist <= AUTO_BRACING_HARD_RULES.maxBraceLengthMm;
}

function computeAngleConstrainedDzRange(horizontalDistanceMm: number): { minDz: number; maxDz: number } {
    const toleranceDeg = 20;
    const minAngleDeg = Math.max(1, AUTO_BRACING_HARD_RULES.braceAngleDeg - toleranceDeg);
    const maxAngleDeg = Math.min(89, AUTO_BRACING_HARD_RULES.braceAngleDeg + toleranceDeg);
    const toRad = (deg: number) => deg * (Math.PI / 180);

    return {
        minDz: horizontalDistanceMm * Math.tan(toRad(minAngleDeg)),
        maxDz: horizontalDistanceMm * Math.tan(toRad(maxAngleDeg)),
    };
}

function resolveAnchorAtZStrict(support: SupportSample, targetZ: number): AnchorPoint | null {
    const tolerance = 0.0001;
    if (targetZ < support.bottomReferenceZ - tolerance) return null;
    if (targetZ > support.topReferenceZ - tolerance) return null;
    return resolveAnchorAtZ(support, targetZ);
}

function resolveDirectionalPlacementAtAnchorZ(
    lowSupport: SupportSample,
    highSupport: SupportSample,
    anchorZ: number,
): PairPlacementResult | null {
    const lowAnchor = resolveAnchorAtZStrict(lowSupport, anchorZ);
    const highAnchorAtLowZ = resolveAnchorAtZStrict(highSupport, anchorZ);
    if (!lowAnchor || !highAnchorAtLowZ) return null;

    const dx = highAnchorAtLowZ.pos.x - lowAnchor.pos.x;
    const dy = highAnchorAtLowZ.pos.y - lowAnchor.pos.y;
    const horizontalDistanceMm = Math.sqrt(dx * dx + dy * dy);
    if (horizontalDistanceMm < 0.001) return null;

    const { minDz, maxDz } = computeAngleConstrainedDzRange(horizontalDistanceMm);
    const maxAvailableDz = Math.max(0, highSupport.topReferenceZ - anchorZ);
    const maxCandidateDz = Math.min(maxDz, maxAvailableDz);
    if (maxCandidateDz < minDz) return null;

    const targetDz = clamp(
        horizontalDistanceMm,
        minDz,
        maxCandidateDz,
    );

    let bestPlacement: PairPlacementResult | null = null;
    let bestTargetDelta = Number.POSITIVE_INFINITY;

    const attempts = 12;
    const dzStep = (maxCandidateDz - minDz) / attempts;
    for (let i = 0; i <= attempts; i += 1) {
        const candidateDz = minDz + dzStep * i;
        const highZ = anchorZ + candidateDz;
        const highAnchor = resolveAnchorAtZStrict(highSupport, highZ);
        if (!highAnchor) continue;
        if (!validateCandidate(lowAnchor, highAnchor)) continue;
        if (highAnchor.pos.z - lowAnchor.pos.z < 0.1) continue;

        const targetDelta = Math.abs(candidateDz - targetDz);
        if (targetDelta < bestTargetDelta) {
            bestTargetDelta = targetDelta;
            bestPlacement = { anchorA: lowAnchor, anchorB: highAnchor };
        }
    }

    return bestPlacement;
}

function classifyDebugSection(tierIndex: number): 'top' | 'middle' | 'bottom' {
    if (tierIndex === 0) return 'bottom';
    return 'top';
}

function resolveAnchorAtZ(support: SupportSample, targetZ: number): AnchorPoint | null {
    const EPSILON = 0.000001;

    let best: AnchorCandidate | null = null;

    const createCandidate = (segment: SegmentSample, t: number): AnchorCandidate => {
        const clampedT = clamp(t, 0, 1);
        const pos = calculateKnotPositionOnSegmentFromT(segment.start, segment.end, segment.segment, clampedT);
        return {
            segment,
            t: clampedT,
            pos,
            score: Math.abs(pos.z - targetZ),
        };
    };

    const pickBetterCandidate = (
        current: AnchorCandidate | null,
        candidate: AnchorCandidate,
    ): AnchorCandidate => {
        if (!current) return candidate;

        if (candidate.score < current.score - EPSILON) {
            return candidate;
        }

        if (Math.abs(candidate.score - current.score) <= EPSILON) {
            if (candidate.segment.segmentId < current.segment.segmentId) {
                return candidate;
            }

            if (
                candidate.segment.segmentId === current.segment.segmentId
                && candidate.t < current.t
            ) {
                return candidate;
            }
        }

        return current;
    };

    for (const segment of support.segments) {
        const dz = segment.end.z - segment.start.z;
        const minZ = Math.min(segment.start.z, segment.end.z);
        const maxZ = Math.max(segment.start.z, segment.end.z);

        if (Math.abs(dz) <= EPSILON) {
            continue;
        }

        if (targetZ < minZ - EPSILON || targetZ > maxZ + EPSILON) {
            continue;
        }

        const t = (targetZ - segment.start.z) / dz;
        best = pickBetterCandidate(best, createCandidate(segment, t));
    }

    if (!best) {
        for (const segment of support.segments) {
            best = pickBetterCandidate(best, createCandidate(segment, 0));
            best = pickBetterCandidate(best, createCandidate(segment, 1));
        }
    }

    if (!best) return null;

    return {
        supportId: support.supportId,
        modelId: support.modelId,
        segmentId: best.segment.segmentId,
        t: best.t,
        pos: best.pos,
        hostDiameterMm: best.segment.diameterMm,
    };
}

function buildGroupPairs(group: SupportSample[], pattern: AutoBracingPattern): Array<[SupportSample, SupportSample]> {
    if (group.length < 2) return [];

    const pairs: Array<[SupportSample, SupportSample]> = [];
    const pairKeys = new Set<string>();

    const addPair = (a: SupportSample, b: SupportSample) => {
        const minId = a.supportId < b.supportId ? a.supportId : b.supportId;
        const maxId = a.supportId < b.supportId ? b.supportId : a.supportId;
        const key = `${minId}:${maxId}`;
        if (pairKeys.has(key)) return;
        pairKeys.add(key);
        pairs.push([a, b]);
    };

    // Build MST using Kruskal's algorithm: sort all candidate edges by distance,
    // add each edge only if it connects two previously unconnected components.
    // This guarantees the minimum set of connections with no redundant long diagonals.

    // Generate all candidate edges
    type Edge = { a: SupportSample; b: SupportSample; distSq: number };
    const edges: Edge[] = [];
    for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
            const a = group[i];
            const b = group[j];
            const dx = b.sortAnchor.x - a.sortAnchor.x;
            const dy = b.sortAnchor.y - a.sortAnchor.y;
            edges.push({ a, b, distSq: dx * dx + dy * dy });
        }
    }
    edges.sort((x, y) => x.distSq - y.distSq);

    // Union-Find
    const parent = new Map<string, string>();
    const find = (id: string): string => {
        if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
        return parent.get(id)!;
    };
    const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
    for (const s of group) parent.set(s.supportId, s.supportId);

    // Add shortest edges that connect new components (MST)
    for (const { a, b } of edges) {
        if (find(a.supportId) !== find(b.supportId)) {
            addPair(a, b);
            union(a.supportId, b.supportId);
        }
    }

    // Second-axis pass: for each support that only has connections along one axis direction,
    // find its nearest neighbor in a sufficiently different direction and add that pair.
    // This ensures every support gets two-axis bracing, not just a 1D chain.
    const minSepDeg = AUTO_BRACING_HARD_RULES.minAxisSeparationDeg;

    const getAxisAngle = (a: SupportSample, b: SupportSample): number => {
        const dx = b.sortAnchor.x - a.sortAnchor.x;
        const dy = b.sortAnchor.y - a.sortAnchor.y;
        return normalizeAxisAngleRad(Math.atan2(dy, dx));
    };

    // Build adjacency from current pairs
    const pairNeighbors = new Map<string, SupportSample[]>();
    for (const s of group) pairNeighbors.set(s.supportId, []);
    for (const [a, b] of pairs) {
        pairNeighbors.get(a.supportId)!.push(b);
        pairNeighbors.get(b.supportId)!.push(a);
    }

    const hasTwoAxes = (s: SupportSample): boolean => {
        const neighbors = pairNeighbors.get(s.supportId) ?? [];
        if (neighbors.length < 2) return false;
        const firstAxis = getAxisAngle(s, neighbors[0]);
        return neighbors.slice(1).some(
            (n) => axisSeparationDeg(firstAxis, getAxisAngle(s, n)) >= minSepDeg,
        );
    };

    for (const s of group) {
        if (hasTwoAxes(s)) continue;

        const currentNeighbors = pairNeighbors.get(s.supportId) ?? [];
        const existingAxes = currentNeighbors.map((n) => getAxisAngle(s, n));

        // Find nearest candidate that provides a new axis
        for (const { a, b } of edges) {
            const candidate = a.supportId === s.supportId ? b : b.supportId === s.supportId ? a : null;
            if (!candidate) continue;

            const candidateAxis = getAxisAngle(s, candidate);
            const isNewAxis = existingAxes.every(
                (ax) => axisSeparationDeg(ax, candidateAxis) >= minSepDeg,
            );
            if (!isNewAxis) continue;

            addPair(s, candidate);
            pairNeighbors.get(s.supportId)!.push(candidate);
            pairNeighbors.get(candidate.supportId)!.push(s);
            existingAxes.push(candidateAxis);
            break; // edges are sorted by distance, so first valid is nearest
        }
    }

    return pairs;
}

function partitionSupportsIntoGroups(
    supports: SupportSample[],
    minGroupSize: number,
    maxGroupSize: number,
): SupportSample[][] {
    if (supports.length < minGroupSize) return [];

    const supportDistanceSq = (a: SupportSample, b: SupportSample): number => {
        const dx = a.sortAnchor.x - b.sortAnchor.x;
        const dy = a.sortAnchor.y - b.sortAnchor.y;
        const dz = a.sortAnchor.z - b.sortAnchor.z;
        return dx * dx + dy * dy + dz * dz;
    };

    const pickNextNearestIndex = (
        group: SupportSample[],
        candidates: SupportSample[],
    ): number => {
        let bestIndex = 0;
        let bestDistSq = Number.POSITIVE_INFINITY;

        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];

            let nearestDistSq = Number.POSITIVE_INFINITY;
            for (const current of group) {
                const distSq = supportDistanceSq(current, candidate);
                if (distSq < nearestDistSq) {
                    nearestDistSq = distSq;
                }
            }

            if (nearestDistSq < bestDistSq - 0.000001) {
                bestDistSq = nearestDistSq;
                bestIndex = i;
                continue;
            }

            if (Math.abs(nearestDistSq - bestDistSq) <= 0.000001) {
                const currentBest = candidates[bestIndex];
                if (sortSupports(candidate, currentBest) < 0) {
                    bestIndex = i;
                }
            }
        }

        return bestIndex;
    };

    const remaining = [...supports].sort(sortSupports);
    const groups: SupportSample[][] = [];

    while (remaining.length > 0) {
        const seed = remaining.shift();
        if (!seed) break;

        const group: SupportSample[] = [seed];

        while (group.length < maxGroupSize && remaining.length > 0) {
            const nextIndex = pickNextNearestIndex(group, remaining);
            const [next] = remaining.splice(nextIndex, 1);
            group.push(next);
        }

        groups.push(group);
    }

    if (groups.length > 1) {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup.length < minGroupSize) {
            const previousGroup = groups[groups.length - 2];

            while (lastGroup.length < minGroupSize && previousGroup.length > minGroupSize) {
                const moved = previousGroup.pop();
                if (!moved) break;
                lastGroup.unshift(moved);
            }

            if (lastGroup.length < minGroupSize) {
                previousGroup.push(...lastGroup);
                groups.pop();
            }
        }
    }

    return groups.filter((group) => group.length >= minGroupSize);
}

function selectionExists(snapshot: SupportState, selectedId: string): boolean {
    if (snapshot.roots[selectedId]) return true;
    if (snapshot.trunks[selectedId]) return true;
    if (snapshot.branches[selectedId]) return true;
    if (snapshot.leaves[selectedId]) return true;
    if (snapshot.twigs[selectedId]) return true;
    if (snapshot.sticks[selectedId]) return true;
    if (snapshot.braces[selectedId]) return true;
    if (snapshot.knots[selectedId]) return true;

    if (selectedId.startsWith('braceSegment:')) {
        const braceId = selectedId.slice('braceSegment:'.length);
        return Boolean(snapshot.braces[braceId]);
    }

    const supportBraceSnapshot = getSupportBraceSnapshot();
    if (supportBraceSnapshot.supportBraces[selectedId]) return true;
    if (supportBraceSnapshot.roots[selectedId]) return true;
    if (supportBraceSnapshot.knots[selectedId]) return true;
    if (Object.values(supportBraceSnapshot.supportBraces).some(
        (supportBrace) => supportBrace.segments.some(
            (segment) =>
                segment.id === selectedId
                || segment.bottomJoint?.id === selectedId
                || segment.topJoint?.id === selectedId,
        ),
    )) return true;

    return false;
}

function clearMissingSelection(snapshot: SupportState): SupportState {
    if (!snapshot.selectedId) return snapshot;
    if (selectionExists(snapshot, snapshot.selectedId)) return snapshot;

    return {
        ...snapshot,
        selectedId: null,
        selectedCategory: null,
    };
}

function clearExistingBraceData(snapshot: SupportState): { snapshot: SupportState; removedBraceCount: number } {
    const braceKnotIds = new Set<string>();
    for (const brace of Object.values(snapshot.braces)) {
        braceKnotIds.add(brace.startKnotId);
        braceKnotIds.add(brace.endKnotId);
    }

    const preservedKnotIds = new Set<string>();
    for (const branch of Object.values(snapshot.branches)) {
        preservedKnotIds.add(branch.parentKnotId);
    }
    for (const leaf of Object.values(snapshot.leaves)) {
        preservedKnotIds.add(leaf.parentKnotId);
    }

    const nextKnots: Record<string, Knot> = {};
    for (const [knotId, knot] of Object.entries(snapshot.knots)) {
        if (braceKnotIds.has(knotId) && !preservedKnotIds.has(knotId)) {
            continue;
        }
        nextKnots[knotId] = knot;
    }

    return {
        snapshot: {
            ...snapshot,
            braces: {},
            knots: nextKnots,
        },
        removedBraceCount: Object.keys(snapshot.braces).length,
    };
}

function normalizeAxisAngleRad(angleRad: number): number {
    const pi = Math.PI;
    let normalized = angleRad % pi;
    if (normalized < 0) normalized += pi;
    return normalized;
}

function axisSeparationDeg(aRad: number, bRad: number): number {
    const diff = Math.abs(aRad - bRad);
    const wrapped = Math.min(diff, Math.PI - diff);
    return (wrapped * 180) / Math.PI;
}

function hasTwoDistinctAxes(angles: number[], minSeparationDeg: number): boolean {
    if (angles.length < 2) return false;

    for (let i = 0; i < angles.length; i += 1) {
        for (let j = i + 1; j < angles.length; j += 1) {
            if (axisSeparationDeg(angles[i], angles[j]) >= minSeparationDeg) {
                return true;
            }
        }
    }

    return false;
}

function evaluateAnchorQualification(args: {
    snapshot: SupportState;
    supportSamples: SupportSample[];
    anchorSpecBySupportId: Map<string, AnchorSpec>;
}): { underQualifiedSupportCount: number } {
    const { snapshot, supportSamples, anchorSpecBySupportId } = args;

    const supportIdBySegmentId = new Map<string, string>();
    for (const support of supportSamples) {
        for (const segment of support.segments) {
            supportIdBySegmentId.set(segment.segmentId, support.supportId);
        }
    }

    const axisAnglesBySupportId = new Map<string, number[]>();
    const axisMergeToleranceDeg = 2;

    const addAxisAngle = (supportId: string, angleRad: number) => {
        const normalized = normalizeAxisAngleRad(angleRad);
        const list = axisAnglesBySupportId.get(supportId) ?? [];

        const alreadyPresent = list.some((existing) => axisSeparationDeg(existing, normalized) <= axisMergeToleranceDeg);
        if (!alreadyPresent) {
            list.push(normalized);
        }

        axisAnglesBySupportId.set(supportId, list);
    };

    const registerAxisFromEndpoint = (endpointKnot: Knot, otherKnot: Knot) => {
        const supportId = supportIdBySegmentId.get(endpointKnot.parentShaftId);
        if (!supportId) return;

        const anchorSpec = anchorSpecBySupportId.get(supportId);
        if (!anchorSpec) return;

        // Only count braces whose endpoint is on the qualification anchor Z.
        if (Math.abs(endpointKnot.pos.z - anchorSpec.anchorZ) > ANCHOR_Z_TOLERANCE_MM) return;

        const dx = otherKnot.pos.x - endpointKnot.pos.x;
        const dy = otherKnot.pos.y - endpointKnot.pos.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq <= 0.000001) return;

        addAxisAngle(supportId, Math.atan2(dy, dx));
    };

    for (const brace of Object.values(snapshot.braces)) {
        const startKnot = snapshot.knots[brace.startKnotId];
        const endKnot = snapshot.knots[brace.endKnotId];
        if (!startKnot || !endKnot) continue;

        registerAxisFromEndpoint(startKnot, endKnot);
        registerAxisFromEndpoint(endKnot, startKnot);
    }

    let underQualifiedSupportCount = 0;
    for (const support of supportSamples) {
        if (!anchorSpecBySupportId.has(support.supportId)) continue;

        const axisAngles = axisAnglesBySupportId.get(support.supportId) ?? [];
        const qualified = hasTwoDistinctAxes(axisAngles, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg);
        if (!qualified) {
            underQualifiedSupportCount += 1;
        }
    }

    return { underQualifiedSupportCount };
}

export function buildAutoBracedSnapshot(
    snapshot: SupportState,
    inputSettings: AutoBracingSettings,
): BuildSnapshotResult {
    const settings = normalizeAutoBracingSettings(inputSettings);
    const supportSamples = buildSupportSamples(snapshot);

    const byModel = new Map<string, SupportSample[]>();
    for (const support of supportSamples) {
        if (!byModel.has(support.modelId)) {
            byModel.set(support.modelId, []);
        }
        byModel.get(support.modelId)!.push(support);
    }

    const groupedSupports: SupportSample[][] = [];
    for (const supportsForModel of byModel.values()) {
        supportsForModel.sort(sortSupports);
        const groups = partitionSupportsIntoGroups(
            supportsForModel,
            AUTO_BRACING_HARD_RULES.minGroupSize,
            settings.maxGroupSize,
        );
        groupedSupports.push(...groups);
    }

    const groupedSupportIds = new Set<string>();
    groupedSupports.forEach((group) => {
        group.forEach((support) => groupedSupportIds.add(support.supportId));
    });

    const cleared = clearExistingBraceData(snapshot);
    let nextSnapshot = cleared.snapshot;

    const braceIdSet = new Set<string>(Object.keys(nextSnapshot.braces));
    const knotIdSet = new Set<string>(Object.keys(nextSnapshot.knots));
    const createBraceId = createUniqueIdFactory('auto-brace', braceIdSet);
    const createKnotId = createUniqueIdFactory('auto-brace-knot', knotIdSet);

    const generatedBraces: Record<string, Brace> = {};
    const generatedKnots: Record<string, Knot> = {};
    const anchorSpecBySupportId = new Map<string, AnchorSpec>();

    // Highest populated anchor Z per support (measured-anchor qualification rule).
    const placedAnchorZBySupportId = new Map<string, number>();

    const updatePlacedAnchor = (supportId: string, anchorZ: number) => {
        const existing = placedAnchorZBySupportId.get(supportId);
        if (existing == null || anchorZ > existing) {
            placedAnchorZBySupportId.set(supportId, anchorZ);
        }
    };

    const placeBrace = (
        anchorA: AnchorPoint,
        anchorB: AnchorPoint,
        debugSection: 'top' | 'middle' | 'bottom',
        anchorZ: number,
    ) => {
        if (anchorA.modelId !== anchorB.modelId) return;
        if (anchorA.segmentId === anchorB.segmentId && Math.abs(anchorA.t - anchorB.t) < 0.0001) return;
        if (!bracePassesMeshClearance(anchorA.pos, anchorB.pos, anchorA.modelId, settings.braceDiameterMm)) return;

        const startKnotId = createKnotId();
        const endKnotId = createKnotId();
        const braceId = createBraceId();

        generatedKnots[startKnotId] = {
            id: startKnotId,
            parentShaftId: anchorA.segmentId,
            t: anchorA.t,
            pos: anchorA.pos,
            diameter: Math.max(0.001, anchorA.hostDiameterMm) + JOINT_DIAMETER_OFFSET_MM,
        };
        generatedKnots[endKnotId] = {
            id: endKnotId,
            parentShaftId: anchorB.segmentId,
            t: anchorB.t,
            pos: anchorB.pos,
            diameter: Math.max(0.001, anchorB.hostDiameterMm) + JOINT_DIAMETER_OFFSET_MM,
        };
        generatedBraces[braceId] = {
            id: braceId,
            modelId: anchorA.modelId,
            startKnotId,
            endKnotId,
            profile: { diameter: settings.braceDiameterMm },
            debugSection,
        };

        updatePlacedAnchor(anchorA.supportId, anchorZ);
        updatePlacedAnchor(anchorB.supportId, anchorZ);
    };

    for (const group of groupedSupports) {
        const maxTopReferenceZ = Math.max(...group.map((support) => support.topReferenceZ));
        const interval = Math.max(0.1, settings.repeatIntervalMm);

        let tierIndex = 0;
        for (
            let anchorZ = settings.initialOffsetFromBottomMm;
            anchorZ < maxTopReferenceZ;
            anchorZ += interval, tierIndex += 1
        ) {
            const tierPattern = tierIndex === 0 ? settings.initialPattern : settings.repeatPattern;
            const pairs = buildGroupPairs(group, tierPattern);
            const debugSection = classifyDebugSection(tierIndex);

            for (const [supportA, supportB] of pairs) {
                const forward = resolveDirectionalPlacementAtAnchorZ(supportA, supportB, anchorZ);
                const reverse = resolveDirectionalPlacementAtAnchorZ(supportB, supportA, anchorZ);

                if (tierPattern === 'crossDiagonal') {
                    if (forward && reverse) {
                        placeBrace(forward.anchorA, forward.anchorB, debugSection, anchorZ);
                        placeBrace(reverse.anchorA, reverse.anchorB, debugSection, anchorZ);
                    }
                } else {
                    const primary = forward ?? reverse;
                    if (primary) placeBrace(primary.anchorA, primary.anchorB, debugSection, anchorZ);
                }
            }
        }
    }

    for (const [supportId, anchorZ] of placedAnchorZBySupportId.entries()) {
        anchorSpecBySupportId.set(supportId, { anchorZ });
    }

    nextSnapshot = clearMissingSelection({
        ...nextSnapshot,
        knots: {
            ...nextSnapshot.knots,
            ...generatedKnots,
        },
        braces: {
            ...generatedBraces,
        },
    });

    const qualification = evaluateAnchorQualification({
        snapshot: nextSnapshot,
        supportSamples,
        anchorSpecBySupportId,
    });

    const generatedBraceCount = Object.keys(generatedBraces).length;
    const skippedSupportCount = supportSamples.length - groupedSupportIds.size;
    const underQualifiedSupportCount = qualification.underQualifiedSupportCount;
    const changed = cleared.removedBraceCount > 0 || generatedBraceCount > 0;

    const message = !changed
        ? 'No eligible supports were found for Auto Brace.'
        : underQualifiedSupportCount > 0
            ? `Auto Brace complete: generated ${generatedBraceCount} brace(s), removed ${cleared.removedBraceCount} previous brace(s), ${underQualifiedSupportCount} support(s) remain under-qualified at the anchor section.`
            : `Auto Brace complete: generated ${generatedBraceCount} brace(s), removed ${cleared.removedBraceCount} previous brace(s).`;

    return {
        snapshot: nextSnapshot,
        generatedBraceCount,
        removedBraceCount: cleared.removedBraceCount,
        skippedSupportCount,
        underQualifiedSupportCount,
        changed,
        message,
    };
}

export function runAutoBracing(): AutoBraceResult {
    const before = structuredClone(getSnapshot());
    const activeSettings = normalizeAutoBracingSettings(getSettings().autoBracing);
    const built = buildAutoBracedSnapshot(before, activeSettings);

    if (!built.changed) {
        return {
            generatedBraceCount: built.generatedBraceCount,
            removedBraceCount: built.removedBraceCount,
            skippedSupportCount: built.skippedSupportCount,
            underQualifiedSupportCount: built.underQualifiedSupportCount,
            changed: false,
            message: built.message,
        };
    }

    const after = structuredClone(built.snapshot);
    setSnapshot(after);

    const payload: SupportReplaceStatePayload = {
        before,
        after,
    };

    pushHistory({
        type: SUPPORT_AUTO_BRACE_REPLACE,
        payload,
    });

    return {
        generatedBraceCount: built.generatedBraceCount,
        removedBraceCount: built.removedBraceCount,
        skippedSupportCount: built.skippedSupportCount,
        underQualifiedSupportCount: built.underQualifiedSupportCount,
        changed: true,
        message: built.message,
    };
}
