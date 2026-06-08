import * as THREE from 'three';
import { pushHistory } from '@/history/historyStore';
import { getSettings } from '../Settings/state';
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
import { snapToGridIndex } from '../PlacementLogic/Grid/gridMath';
import { JOINT_DIAMETER_OFFSET_MM } from '../constants';
import { getKickstandSnapshot, setKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
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
    type AutoBracingSettings,
} from './settings';
import { generateRequiredKickstands } from './generativeBracing';
import { partitionSupportsWithVoronoi } from './voronoiPartitioning';
import { applyInitialPattern } from './initialPattern';
import { applyRepeatingPattern } from './repeatingPattern';
import { buildBraceProfile } from './braceDiameter';
import { linePassesMeshClearance } from './meshClearance';

const EPS = 0.000001;
type SupportKind = 'trunk' | 'branch' | 'kickstand';

function maxHorizontalRunFromBraceLen(maxBraceLenMm: number): number {
    return maxBraceLenMm;
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

type PairDistanceOverride = {
    ignoreMaxDistance: boolean;
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

function buildKickstandSamples(kickstandState: KickstandState): SupportSample[] {
    const supports: SupportSample[] = [];

    for (const kickstand of Object.values(kickstandState.kickstands)) {
        const root = kickstandState.roots[kickstand.rootId];
        const hostKnot = kickstandState.knots[kickstand.hostKnotId];
        if (!root || !hostKnot) continue;

        const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
        const rootTopZ = root.diskHeight + root.coneHeight;
        let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, rootTopZ));

        const segments: SegmentSample[] = [];
        kickstand.segments.forEach((seg) => {
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
            supportId: kickstand.id,
            supportKind: 'kickstand',
            modelId: kickstand.modelId,
            segments,
            ...ex,
            hostSegmentId: kickstand.hostSegmentId,
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

const KICKSTAND_MAX_EDGES_PER_TRUNK = 2;
const KICKSTAND_MAX_EDGES_PER_KICKSTAND = 2;

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

function getSupportBottomAnchor(support: SupportSample): Vec3 {
    let bottomPoint: Vec3 | null = null;

    for (const segment of support.segments) {
        for (const point of [segment.start, segment.end]) {
            if (!bottomPoint || point.z < bottomPoint.z) bottomPoint = point;
        }
    }

    return bottomPoint ?? support.sortAnchor;
}

function getGridCorrelatedPoint(
    support: SupportSample,
    gridSettings?: { enabled: boolean; spacingMm: number },
): { x: number; y: number } {
    const base = getSupportBottomAnchor(support);
    if (!gridSettings?.enabled || gridSettings.spacingMm <= 0) {
        return { x: base.x, y: base.y };
    }

    const gx = snapToGridIndex(base.x, gridSettings.spacingMm);
    const gy = snapToGridIndex(base.y, gridSettings.spacingMm);
    return {
        x: gx * gridSettings.spacingMm,
        y: gy * gridSettings.spacingMm,
    };
}

function isCardinalDelta(dx: number, dy: number, spacingMm: number): boolean {
    const axisToleranceMm = Math.max(0.1, spacingMm * 0.05);
    return Math.abs(dx) <= axisToleranceMm || Math.abs(dy) <= axisToleranceMm;
}

function buildGroupPairs(
    group: SupportSample[],
    maxLen: number,
    gridSettings?: { enabled: boolean; spacingMm: number },
): Edge[] {
    if (group.length < 2) return [];

    const maxRun = maxHorizontalRunFromBraceLen(maxLen);
    const gridCardinalOnly = Boolean(gridSettings?.enabled);
    const axisToleranceMm = Math.max(0.1, (gridSettings?.spacingMm ?? 1) * 0.05);

    const edges: Edge[] = [];
    for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
            const a = group[i], b = group[j];
            const aPoint = getGridCorrelatedPoint(a, gridSettings);
            const bPoint = getGridCorrelatedPoint(b, gridSettings);
            const dx = bPoint.x - aPoint.x;
            const dy = bPoint.y - aPoint.y;

            if (gridCardinalOnly && Math.abs(dx) > axisToleranceMm && Math.abs(dy) > axisToleranceMm) {
                continue;
            }

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

export function buildAutoBracedSnapshot(snapshot: SupportState, inputSettings: AutoBracingSettings): BuildSnapshotResult {
    const settings = normalizeAutoBracingSettings(inputSettings);
    const activeGridSettings = getSettings().grid;
    const maxRun = maxHorizontalRunFromBraceLen(settings.maxBraceLengthMm);
    const trunkSamples = buildSupportSamples(snapshot).filter(s => s.supportKind === 'trunk');

    if (trunkSamples.length < AUTO_BRACING_HARD_RULES.minGroupSize) {
        return {
            snapshot,
            generatedBraceCount: 0,
            removedBraceCount: 0,
            skippedSupportCount: trunkSamples.length,
            changed: false,
            message: "No eligible supports found for Auto Bracing.",
        };
    }

    let kickstandState = getKickstandSnapshot();
    {
        const nextKickstands: KickstandState['kickstands'] = {};
        const nextRoots: KickstandState['roots'] = {};
        const nextKnots: KickstandState['knots'] = {};
        let removedAutoGeneratedCount = 0;

        for (const [id, kickstand] of Object.entries(kickstandState.kickstands)) {
            if (kickstand.autoBracingGenerated) {
                removedAutoGeneratedCount += 1;
                continue;
            }

            nextKickstands[id] = kickstand;

            const root = kickstandState.roots[kickstand.rootId];
            if (root) nextRoots[root.id] = root;

            const hostKnot = kickstandState.knots[kickstand.hostKnotId];
            if (hostKnot) nextKnots[hostKnot.id] = hostKnot;
        }

        if (removedAutoGeneratedCount > 0) {
            const selectedId = kickstandState.selectedId && nextKickstands[kickstandState.selectedId]
                ? kickstandState.selectedId
                : null;

            kickstandState = {
                ...kickstandState,
                kickstands: nextKickstands,
                roots: nextRoots,
                knots: nextKnots,
                selectedId,
            };

            setKickstandSnapshot(kickstandState);
        }
    }

    const trunkById = new Map(trunkSamples.map((trunk) => [trunk.supportId, trunk]));
    const seedUnitMm = activeGridSettings.spacingMm > 0
        ? activeGridSettings.spacingMm
        : 1;
    const effectiveSeedSpacingMm = settings.seedSpacingMm * seedUnitMm;
    const effectiveSeedJitterMm = settings.seedJitterMm * seedUnitMm;

    const trunkGroupIds = partitionSupportsWithVoronoi(
        trunkSamples.map((trunk) => {
            const base = getGridCorrelatedPoint(trunk, activeGridSettings);
            const visualBase = getSupportBottomAnchor(trunk);
            return {
                supportId: trunk.supportId,
                modelId: trunk.modelId,
                point: { x: base.x, y: base.y },
                debugPoint: { x: visualBase.x, y: visualBase.y },
            };
        }),
        {
            seedSpacingMm: effectiveSeedSpacingMm,
            seedJitterMm: effectiveSeedJitterMm,
            maxNeighborDistanceMm: maxRun,
        },
    );

    const preliminaryTrunkGroups: SupportSample[][] = [];
    for (const groupIds of trunkGroupIds) {
        const groupTrunks = groupIds
            .map((id) => trunkById.get(id))
            .filter((trunk): trunk is SupportSample => Boolean(trunk));
        if (groupTrunks.length > 0) {
            preliminaryTrunkGroups.push(groupTrunks);
        }
    }

    // -- PRELIMINARY BRACING SNAPSHOT (To detect trunks needing generative fallback) --
    // Use the same current-run pairing logic that this invocation will apply,
    // not legacy snapshot braces that are about to be replaced.
    const existingTrunkEdges: Array<{ a: string; b: string; angleRad: number }> = [];
    for (const groupTrunks of preliminaryTrunkGroups) {
        const pairs = buildGroupPairs(groupTrunks, settings.maxBraceLengthMm, activeGridSettings);
        for (const pair of pairs) {
            existingTrunkEdges.push({
                a: pair.a.supportId,
                b: pair.b.supportId,
                angleRad: pair.angleRad,
            });
        }
    }

    // -- GENERATIVE PHASE --
    // Only generate Kickstands if a tall trunk failed to find 2-axis bracing
    // amongst the existing trunks in the preliminary pass.
    const generatedKickstands = generateRequiredKickstands(
        snapshot,
        kickstandState,
        settings,
        existingTrunkEdges,
        activeGridSettings,
    );
    
    let generatedKickstandCount = 0;
    const generatedKickstandIds = new Set<string>();
    if (generatedKickstands.length > 0) {
        const nextKickstands = { ...kickstandState.kickstands };
        const nextRoots = { ...kickstandState.roots };
        const nextKnots = { ...kickstandState.knots };

        for (const build of generatedKickstands) {
            build.kickstand.hostSegmentId = build.kickstand.hostSegmentId || build.hostKnot.parentShaftId;
            build.kickstand.autoBracingGenerated = true;
            generatedKickstandIds.add(build.kickstand.id);
            nextKickstands[build.kickstand.id] = build.kickstand;
            nextRoots[build.root.id] = build.root;
            nextKnots[build.hostKnot.id] = build.hostKnot;
        }

        kickstandState = {
            ...kickstandState,
            kickstands: nextKickstands,
            roots: nextRoots,
            knots: nextKnots
        };
        
        setKickstandSnapshot(kickstandState);
        generatedKickstandCount = generatedKickstands.length;
    }

    const kickstandSamples = buildKickstandSamples(kickstandState);

    const segmentOwnerTrunkId = new Map<string, string>();
    for (const trunk of Object.values(snapshot.trunks)) {
        for (const seg of trunk.segments) {
            segmentOwnerTrunkId.set(seg.id, trunk.id);
        }
    }

    const assignedTrunkIdByKickstandId = new Map<string, string>();
    const kickstandsByTrunkId = new Map<string, SupportSample[]>();

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

    for (const kickstand of kickstandSamples) {
        const hostSegmentId = kickstand.hostSegmentId;
        const hostTrunkId = hostSegmentId ? (segmentOwnerTrunkId.get(hostSegmentId) ?? null) : null;

        const assignedTrunkId = hostTrunkId ?? findNearestTrunkId(kickstand);
        if (!assignedTrunkId) continue;

        assignedTrunkIdByKickstandId.set(kickstand.supportId, assignedTrunkId);
        const list = kickstandsByTrunkId.get(assignedTrunkId) ?? [];
        list.push(kickstand);
        kickstandsByTrunkId.set(assignedTrunkId, list);
    }

    const groupedSupports: SupportSample[][] = [];
    for (const groupIds of trunkGroupIds) {
        const g = groupIds
            .map((id) => trunkById.get(id))
            .filter((trunk): trunk is SupportSample => Boolean(trunk));

        const members: SupportSample[] = [...g];
        for (const trunk of g) {
            const kickstands = kickstandsByTrunkId.get(trunk.supportId);
            if (kickstands && kickstands.length > 0) members.push(...kickstands);
        }
        groupedSupports.push(members);
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
        const pairs = buildGroupPairs(groupTrunks, settings.maxBraceLengthMm, activeGridSettings);
        const pairDistanceOverrides = new Map<string, PairDistanceOverride>();
        const pairKey = (aId: string, bId: string) => [aId, bId].sort().join(':');
        const braceProfile = buildBraceProfile(settings.braceDiameterMm);
        const extra = groupMembers.filter((s) => s.supportKind === 'kickstand');
        if (extra.length > 0 && groupTrunks.length > 0) {
            const kickstandCandidateEdges: Edge[] = [];
            for (const sb of extra) {
                const ignoreDistanceForSb = generatedKickstandIds.has(sb.supportId);
                for (const trunk of groupTrunks) {
                    let d: { hDist: number; angleRad: number } | null = null;

                    if (activeGridSettings.enabled) {
                        const aBase = getGridCorrelatedPoint(trunk, activeGridSettings);
                        const bBase = getGridCorrelatedPoint(sb, activeGridSettings);
                        const dx = bBase.x - aBase.x;
                        const dy = bBase.y - aBase.y;
                        if (!isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) continue;

                        const hDist = Math.sqrt(dx * dx + dy * dy);
                        if (hDist < 0.000001) continue;
                        d = { hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) };
                    } else {
                        const zRef = referenceZForDistance(trunk, sb);
                        d = horizontalDistanceAtZ(trunk, sb, zRef);
                        if (!d) continue;
                    }

                    if (!d) continue;
                    if (d.hDist > maxRun + EPS && !ignoreDistanceForSb) continue;
                    kickstandCandidateEdges.push({
                        a: trunk,
                        b: sb,
                        hDist: d.hDist,
                        angleRad: d.angleRad,
                    });
                }
            }

            // Also check for kickstands near each other (like 2 generated braces on an isolated trunk)
            for (let i = 0; i < extra.length; i++) {
                for (let j = i + 1; j < extra.length; j++) {
                    const sb1 = extra[i];
                    const sb2 = extra[j];
                    const ignoreDistanceForPair = generatedKickstandIds.has(sb1.supportId)
                        || generatedKickstandIds.has(sb2.supportId);
                    let d: { hDist: number; angleRad: number } | null = null;

                    if (activeGridSettings.enabled) {
                        const aBase = getGridCorrelatedPoint(sb1, activeGridSettings);
                        const bBase = getGridCorrelatedPoint(sb2, activeGridSettings);
                        const dx = bBase.x - aBase.x;
                        const dy = bBase.y - aBase.y;
                        if (!isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) continue;

                        const hDist = Math.sqrt(dx * dx + dy * dy);
                        if (hDist < 0.000001) continue;
                        d = { hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) };
                    } else {
                        const zRef = referenceZForDistance(sb1, sb2);
                        d = horizontalDistanceAtZ(sb1, sb2, zRef);
                        if (!d) continue;
                    }

                    if (!d) continue;
                    if (d.hDist > maxRun + EPS && !ignoreDistanceForPair) continue;
                    kickstandCandidateEdges.push({
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
            const kickstandEdgeCount = new Map<string, number>();

            const inc = (map: Map<string, number>, key: string) => {
                map.set(key, (map.get(key) ?? 0) + 1);
            };

            const canTake = (trunkId: string, sbId: string) => {
                const tCount = trunkEdgeCount.get(trunkId) ?? 0;
                const sbCount = kickstandEdgeCount.get(sbId) ?? 0;
                return tCount < KICKSTAND_MAX_EDGES_PER_TRUNK && sbCount < KICKSTAND_MAX_EDGES_PER_KICKSTAND;
            };

            const addEdge = (e: Edge) => {
                pairs.push(e);
                existingEdgeIds.add(edgeId(e));
                inc(trunkEdgeCount, e.a.supportId);
                inc(kickstandEdgeCount, e.b.supportId);
                if (generatedKickstandIds.has(e.a.supportId) || generatedKickstandIds.has(e.b.supportId)) {
                    pairDistanceOverrides.set(pairKey(e.a.supportId, e.b.supportId), { ignoreMaxDistance: true });
                }
            };

            for (const sb of extra) {
                const candidates = kickstandCandidateEdges
                    .filter((e) => e.b.supportId === sb.supportId)
                    .sort((x, y) => x.hDist - y.hDist);

                let chosen: Edge | null = null;
                const assignedHostTrunkId = assignedTrunkIdByKickstandId.get(sb.supportId) ?? null;
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

                for (const cand of kickstandCandidateEdges) {
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
            const place = (lowS: SupportSample, highS: SupportSample, section: 'initial' | 'repeating') => {
                const distanceOverride = pairDistanceOverrides.get(pairKey(lowS.supportId, highS.supportId));
                const ignoreMaxDistance = Boolean(distanceOverride?.ignoreMaxDistance);
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

                if (!ignoreMaxDistance && dzGuess > maxRun + EPS) return;

                if (anchorZ + dzGuess >= lowS.topReferenceZ - 0.1 || anchorZ + dzGuess >= highS.topReferenceZ - 0.1) return;

                highAnchor = resolveAnchorAtZ(highS, anchorZ + dzGuess);
                if (!highAnchor) return;

                const dx = highAnchor.pos.x - lowAnchor.pos.x;
                const dy = highAnchor.pos.y - lowAnchor.pos.y;
                const dz = highAnchor.pos.z - lowAnchor.pos.z;

                if (activeGridSettings.enabled) {
                    if (!ignoreMaxDistance && !isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) return;
                }

                const horizontalSpan = Math.sqrt(dx * dx + dy * dy);
                if (!ignoreMaxDistance && horizontalSpan > settings.maxBraceLengthMm + EPS) return;

                if (!linePassesMeshClearance(lowAnchor.pos, highAnchor.pos, lowAnchor.modelId, settings.braceDiameterMm)) return;

                const sId = createKnotId(), eId = createKnotId(), bId = createBraceId();
                generatedKnots[sId] = { id: sId, parentShaftId: lowAnchor.segmentId, t: lowAnchor.t, pos: lowAnchor.pos, diameter: lowAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM };
                generatedKnots[eId] = { id: eId, parentShaftId: highAnchor.segmentId, t: highAnchor.t, pos: highAnchor.pos, diameter: highAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM };
                generatedBraces[bId] = { id: bId, modelId: lowAnchor.modelId, startKnotId: sId, endKnotId: eId, profile: braceProfile, debugSection: section };
            };

            if (isInitial) {
                applyInitialPattern(pairs, pattern, place);
            } else {
                applyRepeatingPattern(pairs, pattern, place);
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
