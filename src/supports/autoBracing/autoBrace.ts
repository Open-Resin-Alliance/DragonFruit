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
import { getSupportBraceSnapshot, setSupportBraceSnapshot } from '../SupportTypes/SupportBrace/supportBraceStore';
import type { SupportBraceState } from '../SupportTypes/SupportBrace/types';
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
import { generateRequiredSupportBraces } from './generativeBracing';

const EPS = 0.000001;
const SQRT2 = Math.SQRT2;

type SupportKind = 'trunk' | 'branch' | 'supportBrace';

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

function maxHorizontalRunFromBraceLen(maxBraceLenMm: number): number {
    return maxBraceLenMm / SQRT2;
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
    hostSegmentId?: string;
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

function buildSupportBraceSamples(supportBraceState: SupportBraceState): SupportSample[] {
    const supports: SupportSample[] = [];

    for (const supportBrace of Object.values(supportBraceState.supportBraces)) {
        const root = supportBraceState.roots[supportBrace.rootId];
        const hostKnot = supportBraceState.knots[supportBrace.hostKnotId];
        if (!root || !hostKnot) continue;

        const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
        const rootTopZ = root.diskHeight + root.coneHeight;
        let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, rootTopZ));

        const segments: SegmentSample[] = [];
        supportBrace.segments.forEach((seg) => {
            const endPoint = seg.topJoint
                ? new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z)
                : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);

            segments.push({
                segmentId: seg.id,
                segment: seg,
                start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                diameterMm: seg.diameter,
            });

            currentStart = endPoint;
        });

        if (segments.length === 0) continue;
        const ex = collectSegmentExtrema(segments);
        supports.push({
            supportId: supportBrace.id,
            supportKind: 'supportBrace',
            modelId: supportBrace.modelId,
            segments,
            ...ex,
            hostSegmentId: supportBrace.hostSegmentId,
        });
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

const SUPPORT_BRACE_MAX_EDGES_PER_TRUNK = 3;
const SUPPORT_BRACE_MAX_EDGES_PER_SUPPORT_BRACE = 2;

function referenceZForDistance(a: SupportSample, b: SupportSample): number {
    const low = Math.max(a.bottomReferenceZ, b.bottomReferenceZ);
    const high = Math.min(a.topReferenceZ, b.topReferenceZ);
    if (high > low + 0.001) return (low + high) / 2;
    return Math.min(a.topReferenceZ, b.topReferenceZ);
}

function horizontalDistanceAtZ(a: SupportSample, b: SupportSample, z: number): { hDist: number; angleRad: number } | null {
    const aAnchor = resolveAnchorAtZ(a, z);
    const bAnchor = resolveAnchorAtZ(b, z);
    const aPos = aAnchor?.pos ?? a.sortAnchor;
    const bPos = bAnchor?.pos ?? b.sortAnchor;

    const dx = bPos.x - aPos.x;
    const dy = bPos.y - aPos.y;
    const hDist = Math.sqrt(dx * dx + dy * dy);
    if (hDist < 0.000001) return null;
    return { hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) };
}

function buildGroupPairs(group: SupportSample[], maxLen: number): Edge[] {
    if (group.length < 2) return [];

    const maxRun = maxHorizontalRunFromBraceLen(maxLen);

    const edges: Edge[] = [];
    for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
            const a = group[i], b = group[j];
            const dx = b.sortAnchor.x - a.sortAnchor.x;
            const dy = b.sortAnchor.y - a.sortAnchor.y;
            const hDist = Math.sqrt(dx * dx + dy * dy);
            if (hDist < 0.001 || hDist > maxRun) continue;
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

function partitionSupportsIntoGroups(
    supports: SupportSample[],
    max: number,
    maxBraceLen: number,
    weightBySupportId?: Map<string, number>,
): SupportSample[][] {
    const min = AUTO_BRACING_HARD_RULES.minGroupSize;
    
    const maxRun = maxHorizontalRunFromBraceLen(maxBraceLen);
    const weightOf = (s: SupportSample) => weightBySupportId?.get(s.supportId) ?? 1;
    const groupWeight = (items: SupportSample[]) => items.reduce((sum, item) => sum + weightOf(item), 0);

    // If total weight is less than min, we can still brace them if there's enough elements in the end, 
    // but the strict "skip everything if < min" rule is handled later after support braces are mixed in.
    if (groupWeight(supports) < min && supports.length > 0 && groupWeight(supports) === supports.length) {
        // If it's pure trunks and still below min, we can bail. But if weight > length, it means it has support braces, so we should try to keep it.
        if (groupWeight(supports) < min) {
             return [];
        }
    }

    const remaining = [...supports].sort(sortSupports);
    const groups: SupportSample[][] = [];

    while (remaining.length > 0) {
        const seed = remaining.shift()!;
        const group = [seed];
        let currentWeight = weightOf(seed);

        while (currentWeight < max && remaining.length > 0) {
            let bestIdx = -1;
            let bestDist = Infinity;

            for (let i = 0; i < remaining.length; i++) {
                const candidate = remaining[i];
                const candidateWeight = weightOf(candidate);
                if (currentWeight + candidateWeight > max) continue;

                for (const g of group) {
                    const d = Math.sqrt(
                        (g.sortAnchor.x - candidate.sortAnchor.x) ** 2
                        + (g.sortAnchor.y - candidate.sortAnchor.y) ** 2,
                    );
                    if (d < bestDist) {
                        bestDist = d;
                        bestIdx = i;
                    }
                }
            }

            if (bestIdx === -1) break;
            if (bestDist > maxRun) break;

            const chosen = remaining.splice(bestIdx, 1)[0];
            group.push(chosen);
            currentWeight += weightOf(chosen);
        }
        groups.push(group);
    }
    // Cleanup small tail groups
    if (groups.length > 1) {
        const last = groups[groups.length - 1];
        if (groupWeight(last) < min) {
            const prev = groups[groups.length - 2];
            if (groupWeight(prev) + groupWeight(last) <= max) {
                prev.push(...last);
                groups.pop();
            } else {
                while (groupWeight(last) < min && groupWeight(prev) > min) {
                    const moved = prev[prev.length - 1];
                    if (!moved) break;
                    if (groupWeight(last) + weightOf(moved) > max) break;
                    last.unshift(prev.pop()!);
                }
                if (groupWeight(last) < min && groupWeight(prev) + groupWeight(last) <= max) {
                    prev.push(...last);
                    groups.pop();
                }
            }
        }
    }
    return groups.filter(g => groupWeight(g) >= min); 
}

export function buildAutoBracedSnapshot(snapshot: SupportState, inputSettings: AutoBracingSettings): BuildSnapshotResult {
    const settings = normalizeAutoBracingSettings(inputSettings);
    const maxRun = maxHorizontalRunFromBraceLen(settings.maxBraceLengthMm);
    const trunkSamples = buildSupportSamples(snapshot).filter(s => s.supportKind === 'trunk');

    let supportBraceState = getSupportBraceSnapshot();

    // -- PRELIMINARY PAIRING PASS (To detect trunks needing generative fallback) --
    const tempByModel = new Map<string, SupportSample[]>();
    for (const s of trunkSamples) {
        if (!tempByModel.has(s.modelId)) tempByModel.set(s.modelId, []);
        tempByModel.get(s.modelId)!.push(s);
    }
    
    const existingTrunkEdges: Array<{ a: string; b: string; angleRad: number }> = [];
    for (const list of tempByModel.values()) {
        // Evaluate physical pairing across the ENTIRE model first.
        // If a trunk can physically reach another trunk, it is not "isolated", 
        // even if it ultimately gets placed in a different group later.
        const pairs = buildGroupPairs(list, settings.maxBraceLengthMm);
        for (const edge of pairs) {
            existingTrunkEdges.push({
                a: edge.a.supportId,
                b: edge.b.supportId,
                angleRad: edge.angleRad
            });
        }
    }

    // -- GENERATIVE PHASE --
    // Only generate Support Braces if a tall trunk failed to find 2-axis bracing
    // amongst the existing trunks in the preliminary pass.
    const generatedSupportBraces = generateRequiredSupportBraces(snapshot, supportBraceState, settings, existingTrunkEdges);
    
    let generatedSupportBraceCount = 0;
    if (generatedSupportBraces.length > 0) {
        const nextSupportBraces = { ...supportBraceState.supportBraces };
        const nextRoots = { ...supportBraceState.roots };
        const nextKnots = { ...supportBraceState.knots };

        for (const build of generatedSupportBraces) {
            // Ensure the generated support brace explicitly tracks its host to guarantee grouping
            build.supportBrace.hostSegmentId = build.supportBrace.hostSegmentId || build.hostKnot.parentShaftId;
            nextSupportBraces[build.supportBrace.id] = build.supportBrace;
            nextRoots[build.root.id] = build.root;
            nextKnots[build.hostKnot.id] = build.hostKnot;
        }

        supportBraceState = {
            ...supportBraceState,
            supportBraces: nextSupportBraces,
            roots: nextRoots,
            knots: nextKnots
        };
        
        // Update the global store so they exist in the app
        setSupportBraceSnapshot(supportBraceState);
        generatedSupportBraceCount = generatedSupportBraces.length;
    }
    // -- END GENERATIVE PHASE --

    const supportBraceSamples = buildSupportBraceSamples(supportBraceState);

    const segmentOwnerTrunkId = new Map<string, string>();
    for (const trunk of Object.values(snapshot.trunks)) {
        for (const seg of trunk.segments) {
            segmentOwnerTrunkId.set(seg.id, trunk.id);
        }
    }

    const assignedTrunkIdBySupportBraceId = new Map<string, string>();
    const supportBracesByTrunkId = new Map<string, SupportSample[]>();

    const findNearestTrunkId = (sb: SupportSample): string | null => {
        let bestId: string | null = null;
        let bestDist = Infinity;
        for (const trunk of trunkSamples) {
            if (trunk.modelId !== sb.modelId) continue;
            const zRef = referenceZForDistance(trunk, sb);
            const d = horizontalDistanceAtZ(trunk, sb, zRef);
            if (!d) continue;
            if (d.hDist < bestDist) {
                bestDist = d.hDist;
                bestId = trunk.supportId;
            }
        }
        if (!bestId) return null;
        if (bestDist > maxRun + EPS) return null;
        return bestId;
    };

    for (const sb of supportBraceSamples) {
        const hostSegmentId = sb.hostSegmentId;
        const hostTrunkId = hostSegmentId ? (segmentOwnerTrunkId.get(hostSegmentId) ?? null) : null;

        const assignedTrunkId = hostTrunkId ?? findNearestTrunkId(sb);
        if (!assignedTrunkId) continue;

        assignedTrunkIdBySupportBraceId.set(sb.supportId, assignedTrunkId);
        const list = supportBracesByTrunkId.get(assignedTrunkId) ?? [];
        list.push(sb);
        supportBracesByTrunkId.set(assignedTrunkId, list);
    }

    const weightByTrunkId = new Map<string, number>();
    for (const trunk of trunkSamples) {
        const count = supportBracesByTrunkId.get(trunk.supportId)?.length ?? 0;
        weightByTrunkId.set(trunk.supportId, 1 + count);
    }

    const byModel = new Map<string, SupportSample[]>();
    for (const s of trunkSamples) {
        if (!byModel.has(s.modelId)) byModel.set(s.modelId, []);
        byModel.get(s.modelId)!.push(s);
    }

    const groupedSupports: SupportSample[][] = [];
    for (const list of byModel.values()) {
        const trunkGroups = partitionSupportsIntoGroups(list, settings.maxGroupSize, settings.maxBraceLengthMm, weightByTrunkId);
        for (const g of trunkGroups) {
            const members: SupportSample[] = [...g];
            for (const trunk of g) {
                const sbs = supportBracesByTrunkId.get(trunk.supportId);
                if (sbs && sbs.length > 0) members.push(...sbs);
            }
            groupedSupports.push(members);
        }
    }

    const groupedIds = new Set<string>();
    groupedSupports.forEach(g => g.forEach(s => { if (s.supportKind === 'trunk') groupedIds.add(s.supportId); }));

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

    for (let groupIndex = 0; groupIndex < groupedSupports.length; groupIndex += 1) {
        const groupMembers = groupedSupports[groupIndex];
        const groupTrunks = groupMembers.filter((s) => s.supportKind === 'trunk');
        const pairs = buildGroupPairs(groupTrunks, settings.maxBraceLengthMm);
        const extra = groupMembers.filter((s) => s.supportKind === 'supportBrace');
        if (extra.length > 0 && groupTrunks.length > 0) {
            const supportBraceCandidateEdges: Edge[] = [];
            for (const sb of extra) {
                for (const trunk of groupTrunks) {
                    const zRef = referenceZForDistance(trunk, sb);
                    const d = horizontalDistanceAtZ(trunk, sb, zRef);
                    if (!d) continue;
                    if (d.hDist > maxRun + EPS) continue;
                    supportBraceCandidateEdges.push({
                        a: trunk,
                        b: sb,
                        hDist: d.hDist,
                        angleRad: d.angleRad,
                    });
                }
            }

            // Also check for support braces near each other (like 2 generated braces on an isolated trunk)
            for (let i = 0; i < extra.length; i++) {
                for (let j = i + 1; j < extra.length; j++) {
                    const sb1 = extra[i];
                    const sb2 = extra[j];
                    const zRef = referenceZForDistance(sb1, sb2);
                    const d = horizontalDistanceAtZ(sb1, sb2, zRef);
                    if (!d) continue;
                    if (d.hDist > maxRun + EPS) continue;
                    // For the sake of the graph, we inject this as an edge, keeping the structure generic
                    // We'll treat sb1 as 'a' (like a pseudo-trunk for this connection)
                    supportBraceCandidateEdges.push({
                        a: sb1,
                        b: sb2,
                        hDist: d.hDist,
                        angleRad: d.angleRad,
                    });
                }
            }

            const edgeId = (e: Edge) => [e.a.supportId, e.b.supportId].sort().join(':');
            const existingEdgeIds = new Set(pairs.map(edgeId));
            const trunkEdgeCount = new Map<string, number>();
            const supportBraceEdgeCount = new Map<string, number>();

            const inc = (map: Map<string, number>, key: string) => {
                map.set(key, (map.get(key) ?? 0) + 1);
            };

            const canTake = (trunkId: string, sbId: string) => {
                const tCount = trunkEdgeCount.get(trunkId) ?? 0;
                const sbCount = supportBraceEdgeCount.get(sbId) ?? 0;
                return tCount < SUPPORT_BRACE_MAX_EDGES_PER_TRUNK && sbCount < SUPPORT_BRACE_MAX_EDGES_PER_SUPPORT_BRACE;
            };

            const addEdge = (e: Edge) => {
                pairs.push(e);
                existingEdgeIds.add(edgeId(e));
                inc(trunkEdgeCount, e.a.supportId);
                inc(supportBraceEdgeCount, e.b.supportId);
            };

            for (const sb of extra) {
                const candidates = supportBraceCandidateEdges
                    .filter((e) => e.b.supportId === sb.supportId)
                    .sort((x, y) => x.hDist - y.hDist);

                let chosen: Edge | null = null;
                const assignedHostTrunkId = assignedTrunkIdBySupportBraceId.get(sb.supportId) ?? null;
                if (assignedHostTrunkId) {
                    for (const cand of candidates) {
                        if (cand.a.supportId !== assignedHostTrunkId) continue;
                        if (existingEdgeIds.has(edgeId(cand))) continue;
                        if (canTake(cand.a.supportId, cand.b.supportId)) {
                            chosen = cand;
                            break;
                        }
                    }
                }

                if (!chosen && assignedHostTrunkId) {
                    for (const cand of candidates) {
                        if (cand.a.supportId !== assignedHostTrunkId) continue;
                        if (existingEdgeIds.has(edgeId(cand))) continue;
                        chosen = cand;
                        break;
                    }
                }

                if (!chosen) {
                    for (const cand of candidates) {
                        if (existingEdgeIds.has(edgeId(cand))) continue;
                        if (canTake(cand.a.supportId, cand.b.supportId)) {
                            chosen = cand;
                            break;
                        }
                    }
                }

                if (!chosen) {
                    for (const cand of candidates) {
                        if (existingEdgeIds.has(edgeId(cand))) continue;
                        chosen = cand;
                        break;
                    }
                }

                if (chosen) {
                    addEdge(chosen);
                }
            }

            for (const trunk of groupTrunks) {
                const axes: number[] = [];
                for (const e of pairs) {
                    if (e.a.supportId === trunk.supportId || e.b.supportId === trunk.supportId) {
                        axes.push(e.angleRad);
                    }
                }

                let qualified = false;
                for (let i = 0; i < axes.length; i++) {
                    for (let j = i + 1; j < axes.length; j++) {
                        if (axisSeparationDeg(axes[i], axes[j]) >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) {
                            qualified = true;
                            break;
                        }
                    }
                    if (qualified) break;
                }
                if (qualified) continue;

                let bestCandidate: Edge | null = null;
                let bestScore = -1;

                for (const cand of supportBraceCandidateEdges) {
                    if (cand.a.supportId !== trunk.supportId) continue;
                    if (existingEdgeIds.has(edgeId(cand))) continue;

                    if (!canTake(cand.a.supportId, cand.b.supportId)) continue;

                    if (axes.length === 0) {
                        bestCandidate = cand;
                        break;
                    }

                    for (const existing of axes) {
                        const sep = axisSeparationDeg(existing, cand.angleRad);
                        if (sep >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) {
                            const score = 90 - Math.abs(90 - sep);
                            if (score > bestScore) {
                                bestScore = score;
                                bestCandidate = cand;
                            }
                        }
                    }
                }

                if (bestCandidate) {
                    addEdge(bestCandidate);
                }
            }
        }
        const maxZ = Math.max(...groupTrunks.map(s => s.topReferenceZ));

        const ladder: number[] = [settings.initialDistanceMm];
        let curr = settings.initialDistanceMm + settings.patternIntervalMm;
        while (curr <= maxZ) { ladder.push(curr); curr += settings.patternIntervalMm; }

        ladder.forEach((anchorZ, tierIndex) => {
            const isInitial = tierIndex === 0;
            const pattern = isInitial ? settings.initialPattern : settings.repeatingPattern;
            for (const edge of pairs) {
                const place = (lowS: SupportSample, highS: SupportSample, section: 'initial' | 'repeating') => {
                    const lowAnchor = resolveAnchorAtZ(lowS, anchorZ);
                    if (!lowAnchor) return;

                    const sameTierAnchor = resolveAnchorAtZ(highS, anchorZ);
                    if (!sameTierAnchor) return;

                    let dzGuess = Math.sqrt(
                        (sameTierAnchor.pos.x - lowAnchor.pos.x) ** 2
                        + (sameTierAnchor.pos.y - lowAnchor.pos.y) ** 2,
                    );
                    if (dzGuess < EPS) return;

                    let highAnchor: AnchorPoint | null = null;
                    for (let iter = 0; iter < 3; iter++) {
                        highAnchor = resolveAnchorAtZ(highS, anchorZ + dzGuess);
                        if (!highAnchor) return;
                        const hDist = Math.sqrt(
                            (highAnchor.pos.x - lowAnchor.pos.x) ** 2
                            + (highAnchor.pos.y - lowAnchor.pos.y) ** 2,
                        );
                        if (Math.abs(hDist - dzGuess) < 0.01) {
                            dzGuess = hDist;
                            break;
                        }
                        dzGuess = hDist;
                        if (dzGuess < EPS) return;
                    }

                    if (dzGuess > maxRun + EPS) return;

                    if (anchorZ + dzGuess >= lowS.topReferenceZ - 0.1 || anchorZ + dzGuess >= highS.topReferenceZ - 0.1) return;

                    highAnchor = resolveAnchorAtZ(highS, anchorZ + dzGuess);
                    if (!highAnchor) return;

                    const dx = highAnchor.pos.x - lowAnchor.pos.x;
                    const dy = highAnchor.pos.y - lowAnchor.pos.y;
                    const dz = highAnchor.pos.z - lowAnchor.pos.z;
                    const braceLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (braceLen > settings.maxBraceLengthMm + EPS) return;

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
        skippedSupportCount: trunkSamples.length - groupedIds.size,
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
