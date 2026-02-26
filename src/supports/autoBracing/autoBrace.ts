import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { getSettings } from '../Settings/state';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';
import {
    SUPPORT_AUTO_BRACE_REPLACE,
    type SupportReplaceStatePayload,
} from '../history/actionTypes';
import { getSnapshot, setSnapshot } from '../state';
import {
    calculateKnotPositionOnSegmentFromT,
    getTrunkSegmentEndpoints,
    getBranchSegmentEndpoints,
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

const EPS = 0.000001;

type SupportKind = 'trunk' | 'branch';

const BRACE_CLEARANCE_SAMPLE_COUNT = 12;

/**
 * Returns true if the brace centerline from posA to posB maintains clearance.
 */
function bracePassesMeshClearance(posA: Vec3, posB: Vec3, modelId: string, braceDiameterMm: number): boolean {
    const minClearance = AUTO_BRACING_HARD_RULES.supportBraceMeshClearanceMm + braceDiameterMm / 2;
    const meshEntries = getAllMeshEntriesForAutoBrace();

    const entry = meshEntries.get(modelId);
    if (!entry) return true;

    const bvh = (entry.geometry as any).boundsTree;
    if (!bvh) return true;

    const inverseMatrix = entry.transform.clone().invert();
    const scaleVec = new THREE.Vector3();
    entry.transform.decompose(new THREE.Vector3(), new THREE.Quaternion(), scaleVec);
    const worldScale = (scaleVec.x + scaleVec.y + scaleVec.z) / 3;

    const ax = posA.x, ay = posA.y, az = posA.z;
    const bx = posB.x, by = posB.y, bz = posB.z;
    const resultTarget: { point?: THREE.Vector3; distance?: number } = {};

    for (let i = 0; i <= BRACE_CLEARANCE_SAMPLE_COUNT; i++) {
        const t = i / BRACE_CLEARANCE_SAMPLE_COUNT;
        const worldPoint = new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
        const localPoint = worldPoint.clone().applyMatrix4(inverseMatrix);
        const result = bvh.closestPointToPoint(localPoint, resultTarget);
        if (!result) continue;

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

export interface AutoBraceResult {
    generatedBraceCount: number;
    removedBraceCount: number;
    skippedSupportCount: number;
    changed: boolean;
    message: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sortSupports(a: SupportSample, b: SupportSample): number {
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    if (a.sortAnchor.x !== b.sortAnchor.x) return a.sortAnchor.x - b.sortAnchor.x;
    if (a.sortAnchor.y !== b.sortAnchor.y) return a.sortAnchor.y - b.sortAnchor.y;
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
        for (const point of [segment.start, segment.end]) {
            if (!topPoint || point.z > topPoint.z) topPoint = point;
            if (!bottomPoint || point.z < bottomPoint.z) bottomPoint = point;
        }
    }

    return {
        topReferenceZ: topPoint?.z ?? 0,
        bottomReferenceZ: bottomPoint?.z ?? 0,
        sortAnchor: topPoint ?? { x: 0, y: 0, z: 0 },
    };
}

function buildSupportSamples(snapshot: SupportState): SupportSample[] {
    const supports: SupportSample[] = [];

    // Process Trunks
    for (const trunk of Object.values(snapshot.trunks)) {
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;
        const segments: SegmentSample[] = [];
        trunk.segments.forEach((seg, idx) => {
            const ep = getTrunkSegmentEndpoints(trunk, seg, idx, root);
            if (ep) segments.push({ segmentId: seg.id, segment: seg, start: ep.start, end: ep.end, diameterMm: seg.diameter });
        });
        if (segments.length === 0) continue;
        const ex = collectSegmentExtrema(segments);
        supports.push({ supportId: trunk.id, supportKind: 'trunk', modelId: trunk.modelId, segments, ...ex });
    }

    // Process Branches
    for (const branch of Object.values(snapshot.branches)) {
        const knot = snapshot.knots[branch.parentKnotId];
        if (!knot) continue;
        const segments: SegmentSample[] = [];
        branch.segments.forEach((seg, idx) => {
            const ep = getBranchSegmentEndpoints(branch, seg, idx, knot);
            if (ep) segments.push({ segmentId: seg.id, segment: seg, start: ep.start, end: ep.end, diameterMm: seg.diameter });
        });
        if (segments.length === 0) continue;
        const ex = collectSegmentExtrema(segments);
        supports.push({ supportId: branch.id, supportKind: 'branch', modelId: branch.modelId, segments, ...ex });
    }

    supports.sort(sortSupports);
    return supports;
}

function resolveAnchorAtZ(support: SupportSample, targetZ: number): AnchorPoint | null {
    let best: AnchorCandidate | null = null;

    for (const segment of support.segments) {
        const minZ = Math.min(segment.start.z, segment.end.z);
        const maxZ = Math.max(segment.start.z, segment.end.z);
        if (targetZ < minZ - EPS || targetZ > maxZ + EPS) continue;

        const dz = segment.end.z - segment.start.z;
        const t = Math.abs(dz) < EPS ? 0 : (targetZ - segment.start.z) / dz;
        const clampedT = clamp(t, 0, 1);
        const pos = calculateKnotPositionOnSegmentFromT(segment.start, segment.end, segment.segment, clampedT);
        const score = Math.abs(pos.z - targetZ);

        if (!best || score < best.score - EPS) {
            best = { segment, t: clampedT, pos, score };
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

function normalizeAxisAngleRad(angleRad: number): number {
    let n = angleRad % Math.PI;
    if (n < 0) n += Math.PI;
    return n;
}

function axisSeparationDeg(aRad: number, bRad: number): number {
    const diff = Math.abs(aRad - bRad);
    return (Math.min(diff, Math.PI - diff) * 180) / Math.PI;
}

type Edge = { a: SupportSample; b: SupportSample; hDist: number; angleRad: number };

function buildGroupPairs(group: SupportSample[], maxLen: number): Edge[] {
    if (group.length < 2) return [];

    const edges: Edge[] = [];
    for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
            const a = group[i], b = group[j];
            const dx = b.sortAnchor.x - a.sortAnchor.x;
            const dy = b.sortAnchor.y - a.sortAnchor.y;
            const hDist = Math.sqrt(dx * dx + dy * dy);
            if (hDist < 0.001 || hDist > maxLen) continue;
            edges.push({ a, b, hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) });
        }
    }
    edges.sort((x, y) => x.hDist - y.hDist);

    const result: Edge[] = [];
    const adjacency = new Map<string, Edge[]>();
    for (const s of group) adjacency.set(s.supportId, []);

    // 1. Minimum Spanning Tree (MST)
    const parent = new Map<string, string>();
    const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
    for (const s of group) parent.set(s.supportId, s.supportId);

    const addedSet = new Set<string>();
    const getEdgeId = (e: Edge) => [e.a.supportId, e.b.supportId].sort().join(':');

    for (const e of edges) {
        if (find(e.a.supportId) !== find(e.b.supportId)) {
            result.push(e);
            addedSet.add(getEdgeId(e));
            parent.set(find(e.a.supportId), find(e.b.supportId));
            adjacency.get(e.a.supportId)!.push(e);
            adjacency.get(e.b.supportId)!.push(e);
        }
    }

    // 2. Two-Axis Priority (90/50 rule)
    for (const s of group) {
        const currentEdges = adjacency.get(s.supportId)!;
        const axes = currentEdges.map(e => e.angleRad);

        const isQualified = () => {
            for (let i = 0; i < axes.length; i++) {
                for (let j = i + 1; j < axes.length; j++) {
                    if (axisSeparationDeg(axes[i], axes[j]) >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) return true;
                }
            }
            return false;
        };

        if (isQualified()) continue;

        // Find nearest best axial fallback
        let bestCandidate: Edge | null = null;
        let bestScore = -1; // Higher is better (closer to 90)

        for (const e of edges) {
            if (addedSet.has(getEdgeId(e))) continue;
            const other = e.a.supportId === s.supportId ? e.b : e.b.supportId === s.supportId ? e.a : null;
            if (!other) continue;

            // Rule: Skip if they already share a braced neighbor to reduce redundancy
            const nA = adjacency.get(s.supportId)!.map(oe => oe.a.supportId === s.supportId ? oe.b.supportId : oe.a.supportId);
            const nB = adjacency.get(other.supportId)!.map(oe => oe.a.supportId === other.supportId ? oe.b.supportId : oe.a.supportId);
            const setA = new Set(nA);
            if (nB.some(id => setA.has(id))) continue;

            for (const existing of axes) {
                const sep = axisSeparationDeg(existing, e.angleRad);
                if (sep >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) {
                    const score = 90 - Math.abs(90 - sep);
                    if (score > bestScore) {
                        bestScore = score;
                        bestCandidate = e;
                    }
                }
            }
        }

        if (bestCandidate) {
            result.push(bestCandidate);
            addedSet.add(getEdgeId(bestCandidate));
            adjacency.get(s.supportId)!.push(bestCandidate);
            adjacency.get(bestCandidate.a.supportId === s.supportId ? bestCandidate.b.supportId : bestCandidate.a.supportId)!.push(bestCandidate);
        }
    }

    return result;
}

function partitionSupportsIntoGroups(supports: SupportSample[], max: number, maxDist: number): SupportSample[][] {
    const min = AUTO_BRACING_HARD_RULES.minGroupSize;
    if (supports.length < min) return [];

    const remaining = [...supports].sort(sortSupports);
    const groups: SupportSample[][] = [];

    while (remaining.length > 0) {
        const seed = remaining.shift()!;
        const group = [seed];
        while (group.length < max && remaining.length > 0) {
            let bestIdx = -1, bestDist = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                for (const g of group) {
                    const d = Math.sqrt((g.sortAnchor.x - remaining[i].sortAnchor.x) ** 2 + (g.sortAnchor.y - remaining[i].sortAnchor.y) ** 2);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                }
            }
            if (bestDist > maxDist) break;
            group.push(remaining.splice(bestIdx, 1)[0]);
        }
        groups.push(group);
    }
    // Cleanup small tail groups
    if (groups.length > 1) {
        const last = groups[groups.length - 1];
        if (last.length < min) {
            const prev = groups[groups.length - 2];
            if (prev.length + last.length <= max) {
                prev.push(...last);
                groups.pop();
            } else {
                while (last.length < min && prev.length > min) last.unshift(prev.pop()!);
                if (last.length < min) { prev.push(...last); groups.pop(); }
            }
        }
    }
    return groups.filter(g => g.length >= min);
}

export function buildAutoBracedSnapshot(snapshot: SupportState, inputSettings: AutoBracingSettings): BuildSnapshotResult {
    const settings = normalizeAutoBracingSettings(inputSettings);
    const supportSamples = buildSupportSamples(snapshot).filter(s => s.supportKind === 'trunk');
    const byModel = new Map<string, SupportSample[]>();
    for (const s of supportSamples) {
        if (!byModel.has(s.modelId)) byModel.set(s.modelId, []);
        byModel.get(s.modelId)!.push(s);
    }

    const groupedSupports: SupportSample[][] = [];
    for (const list of byModel.values()) groupedSupports.push(...partitionSupportsIntoGroups(list, settings.maxGroupSize, settings.maxBraceLengthMm));

    const groupedIds = new Set<string>();
    groupedSupports.forEach(g => g.forEach(s => groupedIds.add(s.supportId)));

    const braceKnotIds = new Set<string>();
    for (const b of Object.values(snapshot.braces)) { braceKnotIds.add(b.startKnotId); braceKnotIds.add(b.endKnotId); }
    const preservedKnotIds = new Set<string>();
    for (const b of Object.values(snapshot.branches)) preservedKnotIds.add(b.parentKnotId);
    for (const l of Object.values(snapshot.leaves)) preservedKnotIds.add(l.parentKnotId);

    const nextKnots: Record<string, Knot> = {};
    for (const [id, k] of Object.entries(snapshot.knots)) { if (!braceKnotIds.has(id) || preservedKnotIds.has(id)) nextKnots[id] = k; }

    let nextSnapshot: SupportState = { ...snapshot, braces: {}, knots: nextKnots, selectedId: (snapshot.selectedId && snapshot.braces[snapshot.selectedId.replace('braceSegment:', '')]) ? null : snapshot.selectedId };

    const braceIds = new Set<string>(Object.keys(nextSnapshot.braces));
    const knotIds = new Set<string>(Object.keys(nextSnapshot.knots));
    const createBraceId = createUniqueIdFactory('auto-brace', braceIds);
    const createKnotId = createUniqueIdFactory('auto-brace-knot', knotIds);

    const generatedBraces: Record<string, Brace> = {};
    const generatedKnots: Record<string, Knot> = {};

    for (const group of groupedSupports) {
        const pairs = buildGroupPairs(group, settings.maxBraceLengthMm);
        const maxZ = Math.max(...group.map(s => s.topReferenceZ));

        const ladder: number[] = [settings.initialDistanceMm];
        let curr = settings.initialDistanceMm + settings.patternIntervalMm;
        while (curr <= maxZ) { ladder.push(curr); curr += settings.patternIntervalMm; }

        ladder.forEach((anchorZ, tierIndex) => {
            const isInitial = tierIndex === 0;
            const pattern = isInitial ? settings.initialPattern : settings.repeatingPattern;
            for (const edge of pairs) {
                const dz = edge.hDist; // 45 degrees: dz = dx

                // Termination: If the brace would end above or at the support tip, skip this tier for this pair.
                if (anchorZ + dz >= edge.a.topReferenceZ - 0.1 || anchorZ + dz >= edge.b.topReferenceZ - 0.1) continue;

                const place = (lowS: SupportSample, highS: SupportSample, section: 'initial' | 'repeating') => {
                    const lowAnchor = resolveAnchorAtZ(lowS, anchorZ);
                    const highAnchor = resolveAnchorAtZ(highS, anchorZ + dz);
                    if (!lowAnchor || !highAnchor) return;

                    if (!bracePassesMeshClearance(lowAnchor.pos, highAnchor.pos, lowAnchor.modelId, settings.braceDiameterMm)) return;

                    const sId = createKnotId(), eId = createKnotId(), bId = createBraceId();
                    generatedKnots[sId] = { id: sId, parentShaftId: lowAnchor.segmentId, t: lowAnchor.t, pos: lowAnchor.pos, diameter: lowAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM };
                    generatedKnots[eId] = { id: eId, parentShaftId: highAnchor.segmentId, t: highAnchor.t, pos: highAnchor.pos, diameter: highAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM };
                    generatedBraces[bId] = { id: bId, modelId: lowAnchor.modelId, startKnotId: sId, endKnotId: eId, profile: { diameter: settings.braceDiameterMm }, debugSection: section };
                };

                place(edge.a, edge.b, isInitial ? 'initial' : 'repeating');
                if (pattern === 'crossDiagonal') place(edge.b, edge.a, isInitial ? 'initial' : 'repeating');
            }
        });
    }

    nextSnapshot.knots = { ...nextSnapshot.knots, ...generatedKnots };
    nextSnapshot.braces = generatedBraces;

    const generatedBraceCount = Object.keys(generatedBraces).length;
    const removedBraceCount = Object.keys(snapshot.braces).length;
    const changed = generatedBraceCount > 0 || removedBraceCount > 0;

    return {
        snapshot: nextSnapshot,
        generatedBraceCount,
        removedBraceCount,
        skippedSupportCount: supportSamples.length - groupedIds.size,
        changed,
        message: changed
            ? `Auto Brace complete: generated ${generatedBraceCount} brace(s), removed ${removedBraceCount} legacy brace(s).`
            : "No eligible supports found for Auto Bracing.",
    };
}

export function runAutoBracing(): AutoBraceResult {
    const before = structuredClone(getSnapshot());
    const built = buildAutoBracedSnapshot(before, getSettings().autoBracing);
    if (!built.changed) return built;

    setSnapshot(built.snapshot);
    pushHistory({ type: SUPPORT_AUTO_BRACE_REPLACE, payload: { before, after: built.snapshot } });
    return built;
}

type BuildSnapshotResult = AutoBraceResult & { snapshot: SupportState };
