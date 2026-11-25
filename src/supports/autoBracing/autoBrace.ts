import * as THREE from 'three';

import { pushSupportHistory } from '@/supports/history/supportHistory';
import { getSettings } from '../Settings/state';
import {
    SUPPORT_AUTO_BRACE_REPLACE,
    type SupportReplaceStatePayload,
} from '../history/actionTypes';
import { cloneSupportState, getSnapshot, removeSupportEntities, setSnapshot } from '../state';
import {
    calculateKnotPositionOnSegmentFromT,
} from '../SupportPrimitives/Knot/knotUtils';
import { snapToGridIndex } from '../PlacementLogic/Grid/gridMath';
import { JOINT_DIAMETER_OFFSET_MM } from '../constants';
import { normalizeAxisAngleRad, axisSeparationDeg, hasQualifiedTwoAxisBracing } from './twoAxisDetection';
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
import { partitionSupportsWithVoronoi } from './voronoiPartitioning';
import { applyInitialPattern } from './initialPattern';
import { applyRepeatingPattern } from './repeatingPattern';
import { runZigZagChain } from './zigzagChain';
import { buildBraceProfile } from './braceDiameter';
import { MIN_HEIGHT_FOR_MANDATORY_BRACING_MM } from '../SupportTypes/Kickstand/kickstandStabiliser';
import type { KickstandBuildResult } from '../SupportTypes/Kickstand/types';
import { generateLateralStabilisers, getSupportTypeDescriptor, parsePrefixedSegmentId, isAutoBraceableShaftType, isLateralStabiliserType, lateralStabiliserTypes, spanKnotHostType, SUPPORT_TYPES, type SupportCollectionKey, type SupportEdge, type SupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';
import { resolveSegmentEndpoints } from '../SupportPrimitives/Knot/segmentEndpoints';
import { linePassesMeshClearance, withScopedAutoBraceModels } from './meshClearance';

const EPS = 0.000001;
/** The types auto-bracing samples. Derived, so a ninth type joins by declaring it. */
type SidebarPanel = SupportTypeId;

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
    supportKind: SidebarPanel;
    modelId: string;
    segments: SegmentSample[];
    topReferenceZ: number;
    bottomReferenceZ: number;
    sortAnchor: Vec3;
    bottomSortAnchor: Vec3;
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
    allowDiagonal?: boolean;
};

/**
 * Outcome of a bracing run, as a code rather than a sentence.
 *
 * The engine has no business producing display copy: it is imported by the unit
 * tests, which run under tsx with no Lingui macro transform, and a localized
 * string here would also freeze the language at call time. The UI turns the code
 * and the counts below into text — see `formatAutoBraceStatus`.
 */
export type AutoBraceStatus =
    /** Fewer eligible trunks than the minimum group size — nothing to brace. */
    | 'no-eligible-supports'
    /** Braces were generated and/or legacy braces removed; see the counts. */
    | 'complete';

export interface AutoBraceResult {
    generatedBraceCount: number;
    removedBraceCount: number;
    skippedSupportCount: number;
    changed: boolean;
    status: AutoBraceStatus;
}

function sortSupports(a: SupportSample, b: SupportSample): number {
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    if (a.sortAnchor.x !== b.sortAnchor.x) return a.sortAnchor.x - b.sortAnchor.x;
    if (a.sortAnchor.y !== b.sortAnchor.y) return a.sortAnchor.y - b.sortAnchor.y;
    // Generated kickstands carry random ids; comparing those first made the
    // brace pass order-dependent on a uuid. Resolve coincident plan anchors by
    // height and kind before falling back to the id.
    if (a.topReferenceZ !== b.topReferenceZ) return a.topReferenceZ - b.topReferenceZ;
    if (a.bottomReferenceZ !== b.bottomReferenceZ) return a.bottomReferenceZ - b.bottomReferenceZ;
    if (a.bottomSortAnchor.x !== b.bottomSortAnchor.x) return a.bottomSortAnchor.x - b.bottomSortAnchor.x;
    if (a.bottomSortAnchor.y !== b.bottomSortAnchor.y) return a.bottomSortAnchor.y - b.bottomSortAnchor.y;
    if (a.supportKind !== b.supportKind) return a.supportKind.localeCompare(b.supportKind);
    // Ids are random for generated supports. At equal geometry the stable sort
    // keeps the insertion order, which is the placement order; comparing ids
    // here made the brace pass differ between runs.
    return 0;
}

/** Brace knots stay this far below a shaft's top (the contact-cone base), so a
 *  brace never fuses the terminal finger into the support next door and the
 *  contact cone snaps away cleanly in post-cure removal. */
export const BRACE_CANOPY_KEEP_OUT_MM = 2.5;

function braceAtZWithinCanopy(sample: SupportSample, z: number): boolean {
    return z > sample.topReferenceZ - BRACE_CANOPY_KEEP_OUT_MM + 1e-6;
}

/** Brace attachment heights quantize to this rung, so neighbouring braces that
 *  meet the same shaft at the same tier share a knot instead of splitting it
 *  into two near-coincident sub-millimetre segments. */
export const BRACE_RUNG_MM = 0.5;
const BRACE_KNOT_SHARE_TOL_Z_MM = 0.05;
const BRACE_KNOT_SHARE_TOL_PLAN_MM = 0.05;

/** Reuse a knot already on this segment at this rung, or mint one. */
function makeBraceKnotTaker(
    knots: Record<string, Knot>,
    createKnotId: () => string,
): (segmentId: string, pos: Vec3, t: number | undefined, diameter: number) => Knot {
    const byRung = new Map<string, Knot>();
    const keyOf = (segmentId: string, z: number) => `${segmentId}:${Math.round(z / BRACE_RUNG_MM)}`;
    for (const knot of Object.values(knots)) {
        byRung.set(keyOf(knot.parentShaftId, knot.pos.z), knot);
    }
    return (segmentId, pos, t, diameter) => {
        const key = keyOf(segmentId, pos.z);
        const existing = byRung.get(key);
        if (existing
            && Math.abs(existing.pos.z - pos.z) <= BRACE_KNOT_SHARE_TOL_Z_MM
            && Math.hypot(existing.pos.x - pos.x, existing.pos.y - pos.y) <= BRACE_KNOT_SHARE_TOL_PLAN_MM) {
            return existing;
        }
        const knot: Knot = { id: createKnotId(), parentShaftId: segmentId, t, pos, diameter };
        knots[knot.id] = knot;
        byRung.set(key, knot);
        return knot;
    };
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

function collectSegmentExtrema(segments: SegmentSample[]): {
    topReferenceZ: number;
    bottomReferenceZ: number;
    sortAnchor: Vec3;
    bottomSortAnchor: Vec3;
} {
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
        bottomSortAnchor: bottomPoint ?? { x: 0, y: 0, z: 0 },
    };
}

/**
 * Shaft samples for every type auto-bracing can brace.
 *
 * Endpoints now come from the shared walker, and which types take part is
 * declared as `isAutoBraceable`.
 */
function buildSupportSamples(snapshot: SupportState, targetModelId?: string): SupportSample[] {
    const supports: SupportSample[] = [];

    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.isAutoBraceable) continue;

        const collection = snapshot[descriptor.location.key as SupportCollectionKey] as unknown as Record<string, {
            id: string;
            modelId: string;
            segments: Segment[];
            rootId?: string;
            parentKnotId?: string;
            hostKnotId?: string;
            hostSegmentId?: string;
        }>;

        const knotField = descriptor.edges.find(
            (edge: SupportEdge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
        )?.field;

        for (const entity of Object.values(collection ?? {})) {
            const resolvedModelId = entity.modelId ?? (entity.rootId ? snapshot.roots[entity.rootId]?.modelId : undefined) ?? '';
            if (targetModelId && resolvedModelId !== targetModelId) continue;

            const hostKnotId = knotField ? (entity as Record<string, unknown>)[knotField] : undefined;
            const hosts = {
                root: entity.rootId ? snapshot.roots[entity.rootId] : undefined,
                hostKnot: typeof hostKnotId === 'string' ? snapshot.knots[hostKnotId] : undefined,
            };

            const segments: SegmentSample[] = [];
            entity.segments.forEach((seg, idx) => {
                const ep = resolveSegmentEndpoints(entity, seg, idx, hosts);
                if (ep) segments.push({ segmentId: seg.id, segment: seg, start: ep.start, end: ep.end, diameterMm: seg.diameter });
            });
            if (segments.length === 0) continue;

            supports.push({
                supportId: entity.id,
                supportKind: descriptor.id,
                modelId: resolvedModelId,
                segments,
                ...collectSegmentExtrema(segments),
                ...(entity.hostSegmentId ? { hostSegmentId: entity.hostSegmentId } : {}),
            });
        }
    }

    supports.sort(sortSupports);
    return supports;
}

/**
 * The slice of SupportState a lateral stabiliser reads and rewrites.
 *
 * Pick<> rather than a bespoke shape: these ARE SupportState's collections, so
 * a field added to one of them cannot drift out of sync here.
 */
type StabiliserSource = Pick<SupportState, 'kickstands' | 'roots' | 'knots'>;

/**
 * Samples for stabilisers held outside the store -- the set a regeneration
 * pass has just built, which is not yet on SupportState.
 */
function buildStabiliserSamples(stabiliserState: StabiliserSource, targetModelId?: string): SupportSample[] {
    return buildSupportSamples(stabiliserState as SupportState, targetModelId);
}

function resolveAnchorAtZ(support: SupportSample, targetZ: number): AnchorPoint | null {
    let best: AnchorCandidate | null = null;

    for (const segment of support.segments) {
        const minZ = Math.min(segment.start.z, segment.end.z);
        const maxZ = Math.max(segment.start.z, segment.end.z);
        if (targetZ < minZ - EPS || targetZ > maxZ + EPS) continue;

        const dz = segment.end.z - segment.start.z;
        const t = Math.abs(dz) < EPS ? 0 : (targetZ - segment.start.z) / dz;
        const clampedT = THREE.MathUtils.clamp(t, 0, 1);
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

type Edge = { a: SupportSample; b: SupportSample; hDist: number; angleRad: number; diagonalFallback?: boolean };

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

// Supports closer than this are one post: two brace surfaces that overlap
// cannot be bridged, so the floor follows the brace diameter.
function autoBracingMinPairSpanMm(settings: AutoBracingSettings): number {
    return Math.max(AUTO_BRACING_HARD_RULES.minPairSpanMm, settings.braceDiameterMm);
}

function buildGroupPairs(
    group: SupportSample[],
    maxLen: number,
    gridSettings?: { enabled: boolean; spacingMm: number },
    minSpanMm = 0,
    ladderFilter?: { initialDistanceMm: number; patternIntervalMm: number; isZigZag: boolean },
): Edge[] {
    if (group.length < 2) return [];

    const maxRun = maxHorizontalRunFromBraceLen(maxLen);
    const gridCardinalOnly = Boolean(gridSettings?.enabled);
    const axisToleranceMm = Math.max(0.1, (gridSettings?.spacingMm ?? 1) * 0.05);

    // Grid-correlated plan points once per support, not once per pair: this is
    // the inner call of an O(n²) loop.
    const points = group.map((s) => getGridCorrelatedPoint(s, gridSettings));

    const cardinalEdges: Edge[] = [];
    const diagonalFallbackEdges: Edge[] = [];
    for (let i = 0; i < group.length; i++) {
        const aPoint = points[i];
        for (let j = i + 1; j < group.length; j++) {
            const bPoint = points[j];
            const dx = bPoint.x - aPoint.x;
            const dy = bPoint.y - aPoint.y;
            const isDiagonalInGrid = gridCardinalOnly && Math.abs(dx) > axisToleranceMm && Math.abs(dy) > axisToleranceMm;

            const hDist = Math.sqrt(dx * dx + dy * dy);
            // below minSpanMm the two supports are one post: bracing between
            // them is material with no stiffness to show for it
            if (hDist < Math.max(0.001, minSpanMm) || hDist > maxRun) continue;

            const overlapLow = Math.max(group[i].bottomReferenceZ, group[j].bottomReferenceZ);
            const overlapHigh = Math.min(group[i].topReferenceZ, group[j].topReferenceZ);
            const minNeededRise = Math.max(AUTO_BRACING_HARD_RULES.minZigZagRiseMm, hDist);
            if (overlapHigh - overlapLow <= minNeededRise + 0.1) continue;
            if (ladderFilter && !ladderFilter.isZigZag) {
                const interval = Math.max(EPS, ladderFilter.patternIntervalMm);
                const kMin = Math.max(0, Math.ceil((overlapLow - EPS - ladderFilter.initialDistanceMm) / interval));
                const firstTierZ = ladderFilter.initialDistanceMm + kMin * interval;
                if (firstTierZ + minNeededRise >= overlapHigh - 0.1) continue;
            }

            const edge: Edge = {
                a: group[i],
                b: group[j],
                hDist,
                angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)),
                ...(isDiagonalInGrid ? { diagonalFallback: true } : {}),
            };
            if (isDiagonalInGrid) {
                diagonalFallbackEdges.push(edge);
            } else {
                cardinalEdges.push(edge);
            }
        }
    }
    const edgeTier = (e: Edge) => (e.a.supportKind === 'trunk' && e.b.supportKind === 'trunk' ? 0 : 1);
    const compareEdges = (x: Edge, y: Edge) => (edgeTier(x) - edgeTier(y)) || (x.hDist - y.hDist);
    cardinalEdges.sort(compareEdges);
    diagonalFallbackEdges.sort(compareEdges);
    const cardinalCount = cardinalEdges.length;
    const edges: Edge[] = [...cardinalEdges, ...diagonalFallbackEdges];

    const result: Edge[] = [];
    const adjacency = new Map<string, Edge[]>();
    for (const s of group) adjacency.set(s.supportId, []);

    // Incident edges per support, in `edges` order. The two-axis pass below
    // walks one support's own edges instead of scanning the whole list per
    // support (O(n·E), and it built a sorted string key for every edge it
    // looked at) — on a few hundred supports that scan was the run's second
    // biggest cost.
    const edgesBySupport = new Map<string, number[]>();
    for (let ei = 0; ei < edges.length; ei++) {
        for (const id of [edges[ei].a.supportId, edges[ei].b.supportId]) {
            const list = edgesBySupport.get(id);
            if (list) list.push(ei);
            else edgesBySupport.set(id, [ei]);
        }
    }
    const addedEdges = new Set<number>();

    // Braced neighbours per support, rebuilt only when that support gains an
    // edge — the redundancy rule needs them for both endpoints of every
    // candidate edge.
    const neighbourCache = new Map<string, Set<string>>();
    const neighboursOf = (id: string): Set<string> => {
        let set = neighbourCache.get(id);
        if (!set) {
            set = new Set<string>();
            for (const e of adjacency.get(id) ?? []) {
                set.add(e.a.supportId === id ? e.b.supportId : e.a.supportId);
            }
            neighbourCache.set(id, set);
        }
        return set;
    };

    const link = (ei: number): void => {
        const e = edges[ei];
        result.push(e);
        addedEdges.add(ei);
        adjacency.get(e.a.supportId)!.push(e);
        adjacency.get(e.b.supportId)!.push(e);
        neighbourCache.delete(e.a.supportId);
        neighbourCache.delete(e.b.supportId);
    };

    // 1. Minimum Spanning Tree (MST)
    const parent = new Map<string, string>();
    const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
    for (const s of group) parent.set(s.supportId, s.supportId);

    for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (find(e.a.supportId) !== find(e.b.supportId)) {
            parent.set(find(e.a.supportId), find(e.b.supportId));
            link(ei);
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
        let bestCandidate = -1;
        let bestScore = -1; // Higher is better (closer to 90)

        const ownNeighbours = neighboursOf(s.supportId);
        for (const ei of edgesBySupport.get(s.supportId) ?? []) {
            if (addedEdges.has(ei)) continue;
            const e = edges[ei];
            const otherId = e.a.supportId === s.supportId ? e.b.supportId : e.a.supportId;

            // Rule: Skip if they already share a braced neighbor to reduce redundancy
            let sharesNeighbour = false;
            for (const id of neighboursOf(otherId)) {
                if (ownNeighbours.has(id)) {
                    sharesNeighbour = true;
                    break;
                }
            }
            if (sharesNeighbour) continue;

            for (const existing of axes) {
                const sep = axisSeparationDeg(existing, e.angleRad);
                if (sep >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) {
                    const score = (ei < cardinalCount ? 100 : 0) + (90 - Math.abs(90 - sep));
                    if (score > bestScore) {
                        bestScore = score;
                        bestCandidate = ei;
                    }
                }
            }
        }

        if (bestCandidate >= 0) link(bestCandidate);
    }

    return result;
}

/** Kickstand state is derived from the snapshot; a second argument could only disagree. */
export function buildAutoBracedSnapshot(
    snapshot: SupportState,
    rawSettings?: Partial<AutoBracingSettings>,
    options?: { modelId?: string },
): BuildSnapshotResult {
    const targetModelId = options?.modelId;
    const stabiliserBase: StabiliserSource = {
        kickstands: snapshot.kickstands,
        roots: snapshot.roots,
        knots: snapshot.knots,
    };
    const settings = normalizeAutoBracingSettings(rawSettings);
    const activeGridSettings = getSettings().grid;
    const maxRun = maxHorizontalRunFromBraceLen(settings.maxBraceLengthMm);

    const activePlateModelIds = new Set<string>();
    const segmentOwnerModelId = new Map<string, string>();
    for (const root of Object.values(snapshot.roots ?? {})) {
        if (root.modelId) activePlateModelIds.add(root.modelId);
    }
    for (const descriptor of SUPPORT_TYPES) {
        const collection = snapshot[descriptor.location.key as SupportCollectionKey] as unknown as Record<string, {
            modelId?: string;
            rootId?: string;
            segments?: Segment[];
        }>;
        for (const entity of Object.values(collection ?? {})) {
            const entityModelId = entity.modelId
                ?? (typeof entity.rootId === 'string' ? snapshot.roots[entity.rootId]?.modelId : undefined);
            if (entityModelId) {
                activePlateModelIds.add(entityModelId);
                if (Array.isArray(entity.segments)) {
                    for (const seg of entity.segments) {
                        segmentOwnerModelId.set(seg.id, entityModelId);
                    }
                }
            }
        }
    }
    for (const entity of Object.values(snapshot.supports ?? {})) {
        const entityWithRoot = entity as { modelId?: string; rootId?: string; segments?: Segment[] };
        const entityModelId = entityWithRoot.modelId
            ?? (typeof entityWithRoot.rootId === 'string' ? snapshot.roots?.[entityWithRoot.rootId]?.modelId : undefined);
        if (entityModelId) {
            activePlateModelIds.add(entityModelId);
            if (Array.isArray(entityWithRoot.segments)) {
                for (const seg of entityWithRoot.segments) {
                    if (!segmentOwnerModelId.has(seg.id)) {
                        segmentOwnerModelId.set(seg.id, entityModelId);
                    }
                }
            }
        }
    }
    for (const knot of Object.values(snapshot.knots ?? {})) {
        const knotModelId = (knot as { modelId?: string }).modelId;
        if (knotModelId) {
            activePlateModelIds.add(knotModelId);
        }
    }
    if (targetModelId) activePlateModelIds.add(targetModelId);

    // Every declared braceable shaft type -- trunk AND branch. This filtered on
    // the literal 'trunk', so branch samples were built and then discarded here.
    const trunkSamples = buildSupportSamples(snapshot, targetModelId).filter(s => isAutoBraceableShaftType(s.supportKind));

    const hasMandatoryTallSupport = trunkSamples.some((s) => {
        const trunkEntity = snapshot.trunks[s.supportId];
        const rootZ = trunkEntity?.rootId ? snapshot.roots[trunkEntity.rootId]?.transform.pos.z : undefined;
        const baseZ = typeof rootZ === 'number' ? Math.min(rootZ, s.bottomReferenceZ) : s.bottomReferenceZ;
        return s.topReferenceZ - baseZ >= MIN_HEIGHT_FOR_MANDATORY_BRACING_MM;
    });
    const hasInScopeExistingStabiliser = lateralStabiliserTypes().some((typeId) => {
        const descriptor = getSupportTypeDescriptor(typeId);
        const collection = (snapshot as unknown as Record<string, Record<string, Record<string, unknown>>>)[descriptor.location.key] ?? {};
        return Object.values(collection).some((entity) => {
            const entityModelId = (typeof entity.modelId === 'string' ? entity.modelId : undefined)
                ?? (typeof entity.rootId === 'string' ? snapshot.roots[entity.rootId]?.modelId : undefined)
                ?? (typeof entity.hostSegmentId === 'string' ? segmentOwnerModelId.get(entity.hostSegmentId) : undefined);
            const inScope = !targetModelId || entityModelId === targetModelId;
            if (!inScope) return false;
            return entity.generatedBy !== 'autoBracing' || settings.removeExistingBracing;
        });
    });
    const hasRemovableAutoBrace = settings.removeExistingBracing
        && Object.values(snapshot.braces ?? {}).some(
            (brace) => (!targetModelId || brace.modelId === targetModelId) && brace.generatedBy === 'autoBracing',
        );
    const hasRemovableAutoBracing = hasRemovableAutoBrace || hasInScopeExistingStabiliser;

    if (
        trunkSamples.length === 0 ||
        (trunkSamples.length < AUTO_BRACING_HARD_RULES.minGroupSize && !hasMandatoryTallSupport && !hasRemovableAutoBracing)
    ) {
        return {
            snapshot,
            generatedBraceCount: 0,
            removedBraceCount: 0,
            skippedSupportCount: trunkSamples.length,
            changed: false,
            status: 'no-eligible-supports',
        };
    }

    let stabiliserState = stabiliserBase;
    let selectedStabiliserCleared: boolean | null = null;
    const removedStabiliserRootIds = new Set<string>();
    const removedStabiliserKnotIds = new Set<string>();
    let removedAutoGeneratedCount = 0;
    {
        const nextStabilisers: StabiliserSource['kickstands'] = {};
        const nextRoots: StabiliserSource['roots'] = {};
        const nextKnots: StabiliserSource['knots'] = {};

        // Keeps every stabiliser this run did not generate, along with the
        // primitives it claims through its declared edges.
        for (const typeId of lateralStabiliserTypes()) {
            const descriptor = getSupportTypeDescriptor(typeId);
            const collection = (stabiliserState as unknown as Record<string, Record<string, Record<string, unknown>>>)[descriptor.location.key] ?? {};

            for (const [id, entity] of Object.entries(collection)) {
                const entityModelId = (typeof entity.modelId === 'string' ? entity.modelId : undefined)
                    ?? (typeof entity.rootId === 'string' ? snapshot.roots[entity.rootId]?.modelId : undefined)
                    ?? (typeof entity.hostSegmentId === 'string' ? segmentOwnerModelId.get(entity.hostSegmentId) : undefined);
                const inScope = !targetModelId || entityModelId === targetModelId;

                if (inScope && entity.generatedBy === 'autoBracing' && settings.removeExistingBracing) {
                    removedAutoGeneratedCount += 1;
                    if (typeof entity.rootId === 'string') removedStabiliserRootIds.add(entity.rootId);
                    if (typeof entity.hostKnotId === 'string') removedStabiliserKnotIds.add(entity.hostKnotId);
                    continue;
                }

                nextStabilisers[id] = entity as unknown as StabiliserSource['kickstands'][string];

                for (const edge of descriptor.edges) {
                    const linkedId = entity[edge.field];
                    if (typeof linkedId !== 'string') continue;

                    if (edge.to === 'roots') {
                        const root = stabiliserState.roots[linkedId];
                        if (root) nextRoots[root.id] = root;
                    } else if (edge.to === 'knots') {
                        const knot = stabiliserState.knots[linkedId];
                        if (knot) nextKnots[knot.id] = knot;
                    }
                }
            }
        }

        if (removedAutoGeneratedCount > 0) {
            // A selected kickstand that just got regenerated away leaves the
            // selection dangling.
            if (selectedStabiliserCleared === null && snapshot.selectedId
                && snapshot.kickstands[snapshot.selectedId] && !nextStabilisers[snapshot.selectedId]) {
                selectedStabiliserCleared = true;
            }

            stabiliserState = {
                ...stabiliserState,
                kickstands: nextStabilisers,
                roots: nextRoots,
                knots: nextKnots,
            };
        }
    }

    const trunkById = new Map(trunkSamples.map((trunk) => [trunk.supportId, trunk]));
    // seedSpacingMm / seedJitterMm are already mm — do not scale by grid spacing.
    const effectiveSeedSpacingMm = settings.seedSpacingMm;
    const effectiveSeedJitterMm = settings.seedJitterMm;

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

    // -- PRELIMINARY BRACING SNAPSHOT (To detect trunks needing generative fallback) --
    // Use the same current-run pairing logic that this invocation will apply,
    // not legacy snapshot braces that are about to be replaced. Paired
    // MODEL-WIDE (per model, distance-limited) — the Voronoi partition can
    // isolate single trunks at dense auto-grid spacings, and per-cluster
    // pairing would read them as braceless and spawn kickstands despite
    // braceable neighbors.
    const existingTrunkEdges: Array<{ a: string; b: string; angleRad: number }> = [];
    const trunksByModel = new Map<string, SupportSample[]>();
    for (const trunk of trunkSamples) {
        const list = trunksByModel.get(trunk.modelId) ?? [];
        list.push(trunk);
        trunksByModel.set(trunk.modelId, list);
    }
    const ladderFilter = {
        initialDistanceMm: settings.initialDistanceMm,
        patternIntervalMm: settings.patternIntervalMm,
        isZigZag: settings.initialPattern === 'zigZag' || settings.repeatingPattern === 'zigZag',
    };
    for (const modelTrunks of trunksByModel.values()) {
        const pairs = buildGroupPairs(
            modelTrunks,
            settings.maxBraceLengthMm,
            activeGridSettings,
            autoBracingMinPairSpanMm(settings),
            ladderFilter,
        );
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
    // A tall shaft needs two bracing axes; when no neighbour is in reach there
    // is nothing to brace against, so ask for a support that stands alone.
    const rootsForStabilisers: SupportState['roots'] = removedStabiliserRootIds.size > 0
        ? (() => {
            const referencedTrunkRootIds = new Set<string>();
            for (const trunk of Object.values(snapshot.trunks)) {
                if (trunk.rootId) referencedTrunkRootIds.add(trunk.rootId);
            }
            const filteredRoots = { ...snapshot.roots };
            for (const removedRootId of removedStabiliserRootIds) {
                if (!referencedTrunkRootIds.has(removedRootId)) {
                    delete filteredRoots[removedRootId];
                }
            }
            return filteredRoots;
        })()
        : snapshot.roots;

    const snapshotForStabilisers: SupportState = targetModelId
        ? (() => {
            const scopedTrunks: SupportState['trunks'] = {};
            for (const [id, trunk] of Object.entries(snapshot.trunks)) {
                if ((trunk.modelId ?? snapshot.roots[trunk.rootId]?.modelId) === targetModelId) {
                    scopedTrunks[id] = trunk;
                }
            }
            return { ...snapshot, trunks: scopedTrunks, roots: rootsForStabilisers };
        })()
        : (rootsForStabilisers === snapshot.roots ? snapshot : { ...snapshot, roots: rootsForStabilisers });

    const generatedStabilisers = withScopedAutoBraceModels(activePlateModelIds, () =>
        lateralStabiliserTypes().flatMap((typeId) =>
            generateLateralStabilisers(typeId, {
                snapshot: snapshotForStabilisers,
                existing: stabiliserState,
                settings,
                existingEdges: existingTrunkEdges,
                gridSettings: activeGridSettings,
            }) as KickstandBuildResult[]));
    
    let generatedStabiliserCount = 0;
    const generatedStabiliserIds = new Set<string>();
    if (generatedStabilisers.length > 0) {
        const nextStabilisers = { ...stabiliserState.kickstands };
        const nextRoots = { ...stabiliserState.roots };
        const nextKnots = { ...stabiliserState.knots };

        const occupiedSupportIds = new Set<string>(Object.keys(nextStabilisers));
        const occupiedRootIds = new Set<string>(Object.keys(nextRoots));
        const occupiedKnotIds = new Set<string>(Object.keys(nextKnots));
        const occupiedSegmentIds = new Set<string>();
        const occupiedJointIds = new Set<string>();

        const recordSegments = (segments?: Segment[]) => {
            if (!Array.isArray(segments)) return;
            for (const seg of segments) {
                occupiedSegmentIds.add(seg.id);
                if (seg.bottomJoint?.id) occupiedJointIds.add(seg.bottomJoint.id);
                if (seg.topJoint?.id) occupiedJointIds.add(seg.topJoint.id);
            }
        };

        for (const rootId of Object.keys(snapshot.roots ?? {})) {
            if (!removedStabiliserRootIds.has(rootId)) occupiedRootIds.add(rootId);
        }
        for (const knotId of Object.keys(snapshot.knots ?? {})) {
            if (!removedStabiliserKnotIds.has(knotId)) occupiedKnotIds.add(knotId);
        }
        for (const ks of Object.values(nextStabilisers)) {
            recordSegments(ks.segments);
        }
        for (const descriptor of SUPPORT_TYPES) {
            if (isLateralStabiliserType(descriptor.id)) continue;
            const collection = snapshot[descriptor.location.key as SupportCollectionKey] as unknown as Record<string, {
                id?: string;
                segments?: Segment[];
            }>;
            for (const [id, entity] of Object.entries(collection ?? {})) {
                occupiedSupportIds.add(id);
                recordSegments(entity.segments);
            }
        }
        for (const [id, entity] of Object.entries(snapshot.supports ?? {})) {
            if (snapshot.kickstands?.[id] && !nextStabilisers[id]) continue;
            occupiedSupportIds.add(id);
            recordSegments((entity as { segments?: Segment[] }).segments);
        }

        const hasStabiliserCollision = (candidate: KickstandBuildResult): boolean =>
            occupiedSupportIds.has(candidate.kickstand.id) ||
            occupiedRootIds.has(candidate.root.id) ||
            occupiedKnotIds.has(candidate.hostKnot.id) ||
            candidate.kickstand.segments.some(
                (seg) =>
                    occupiedSegmentIds.has(seg.id) ||
                    (seg.bottomJoint ? occupiedJointIds.has(seg.bottomJoint.id) : false) ||
                    (seg.topJoint ? occupiedJointIds.has(seg.topJoint.id) : false),
            );

        const rekeyStabiliserBuild = (
            raw: KickstandBuildResult,
            mapId: (id: string) => string,
        ): KickstandBuildResult => {
            const nextRootId = mapId(raw.root.id);
            const nextHostKnotId = mapId(raw.hostKnot.id);
            const nextKickstandId = mapId(raw.kickstand.id);
            const jointMap = new Map<string, Segment['topJoint']>();
            const mapJoint = (joint: Segment['topJoint']): Segment['topJoint'] => {
                if (!joint) return undefined;
                let mapped = jointMap.get(joint.id);
                if (!mapped) {
                    mapped = { ...joint, id: mapId(joint.id) };
                    jointMap.set(joint.id, mapped);
                }
                return mapped;
            };
            const nextSegments: Segment[] = raw.kickstand.segments.map((seg) => ({
                ...seg,
                id: mapId(seg.id),
                ...(seg.bottomJoint ? { bottomJoint: mapJoint(seg.bottomJoint) } : {}),
                ...(seg.topJoint ? { topJoint: mapJoint(seg.topJoint) } : {}),
            }));
            return {
                ...raw,
                root: {
                    ...raw.root,
                    id: nextRootId,
                },
                hostKnot: {
                    ...raw.hostKnot,
                    id: nextHostKnotId,
                },
                kickstand: {
                    ...raw.kickstand,
                    id: nextKickstandId,
                    rootId: nextRootId,
                    hostKnotId: nextHostKnotId,
                    segments: nextSegments,
                },
            };
        };

        for (const rawBuild of generatedStabilisers) {
            let build = rawBuild;
            if (hasStabiliserCollision(build)) {
                const scopePrefix = build.kickstand.modelId || targetModelId || 'm';
                let attempt = 1;
                do {
                    const suffix = attempt === 1 ? '' : `-${attempt}`;
                    build = rekeyStabiliserBuild(rawBuild, (id) => `${scopePrefix}-${id}${suffix}`);
                    attempt += 1;
                } while (hasStabiliserCollision(build));
            }

            build.kickstand.hostSegmentId = build.kickstand.hostSegmentId || build.hostKnot.parentShaftId;
            build.kickstand.generatedBy = 'autoBracing';
            generatedStabiliserIds.add(build.kickstand.id);
            nextStabilisers[build.kickstand.id] = build.kickstand;
            nextRoots[build.root.id] = build.root;
            nextKnots[build.hostKnot.id] = build.hostKnot;

            occupiedSupportIds.add(build.kickstand.id);
            occupiedRootIds.add(build.root.id);
            occupiedKnotIds.add(build.hostKnot.id);
            recordSegments(build.kickstand.segments);
        }

        stabiliserState = {
            ...stabiliserState,
            kickstands: nextStabilisers,
            roots: nextRoots,
            knots: nextKnots
        };

        generatedStabiliserCount = generatedStabilisers.length;
    }

    const stabiliserSamples = buildStabiliserSamples(stabiliserState, targetModelId);

    const segmentOwnerTrunkId = new Map<string, string>();
    for (const trunk of Object.values(snapshot.trunks)) {
        if (targetModelId && (trunk.modelId ?? snapshot.roots[trunk.rootId]?.modelId) !== targetModelId) continue;
        for (const seg of trunk.segments) {
            segmentOwnerTrunkId.set(seg.id, trunk.id);
        }
    }

    const assignedHostIdByStabiliserId = new Map<string, string>();
    const stabilisersByHostId = new Map<string, SupportSample[]>();

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

    for (const kickstand of stabiliserSamples) {
        const hostSegmentId = kickstand.hostSegmentId;
        const hostTrunkId = hostSegmentId ? (segmentOwnerTrunkId.get(hostSegmentId) ?? null) : null;

        const assignedTrunkId = hostTrunkId ?? findNearestTrunkId(kickstand);
        if (!assignedTrunkId) continue;

        assignedHostIdByStabiliserId.set(kickstand.supportId, assignedTrunkId);
        const list = stabilisersByHostId.get(assignedTrunkId) ?? [];
        list.push(kickstand);
        stabilisersByHostId.set(assignedTrunkId, list);
    }

    const groupedSupports: SupportSample[][] = [];
    const allowGroupPairing = trunkSamples.length >= AUTO_BRACING_HARD_RULES.minGroupSize
        || hasMandatoryTallSupport
        || stabiliserSamples.length > 0;
    if (allowGroupPairing) {
        for (const groupIds of trunkGroupIds) {
            const g = groupIds
                .map((id) => trunkById.get(id))
                .filter((trunk): trunk is SupportSample => Boolean(trunk));

            const members: SupportSample[] = [...g];
            for (const trunk of g) {
                const kickstands = stabilisersByHostId.get(trunk.supportId);
                if (kickstands && kickstands.length > 0) members.push(...kickstands);
            }
            groupedSupports.push(members);
        }
    }

    const groupedIds = new Set<string>();
    groupedSupports.forEach(g => g.forEach(s => { if (isAutoBraceableShaftType(s.supportKind)) groupedIds.add(s.supportId); }));

    // Keep braces this tool did not generate (or belonging to sibling models); `generatedBy` distinguishes them.
    const keptBraces: SupportState['braces'] = {};
    let removedBraceCountForPass = 0;
    const candidateDropKnotIds = new Set<string>(removedStabiliserKnotIds);
    for (const [id, brace] of Object.entries(snapshot.braces)) {
        const inScope = !targetModelId || brace.modelId === targetModelId;
        const isOurs = brace.generatedBy === 'autoBracing';
        if (inScope && isOurs && settings.removeExistingBracing) {
            removedBraceCountForPass += 1;
            candidateDropKnotIds.add(brace.startKnotId);
            candidateDropKnotIds.add(brace.endKnotId);
            continue;
        }
        keptBraces[id] = brace;
    }

    const resolveKnotModelId = (knot: Knot): string | undefined =>
        (knot as { modelId?: string }).modelId ?? segmentOwnerModelId.get(knot.parentShaftId);

    for (const [id, knot] of Object.entries(snapshot.knots)) {
        if ((knot as { hostedBy?: string }).hostedBy === 'autoBracing') {
            const knotModelId = resolveKnotModelId(knot);
            if (!targetModelId || knotModelId === targetModelId) {
                candidateDropKnotIds.add(id);
            }
        }
    }

    // The collection this pass rebuilds, so its kept set is read instead of the
    // snapshot's. The brace type comes from the registry rather than being
    // written as 'brace': it is the type whose knot host is a selectable span.
    const bracesKey = getSupportTypeDescriptor(spanKnotHostType()).location.key;
    const stabiliserKeys = new Set(
        lateralStabiliserTypes().map((typeId) => getSupportTypeDescriptor(typeId).location.key),
    );

    /** Knots the entities in `collection` hang from, by declared knot edges. */
    const addHostKnots = (
        descriptor: SupportTypeDescriptor,
        collection: Record<string, unknown>,
        into: Set<string>,
    ) => {
        const knotFields = descriptor.edges
            .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
            .map((edge) => edge.field);
        if (knotFields.length === 0) return;

        for (const entity of Object.values(collection ?? {})) {
            const fields = entity as Record<string, unknown>;
            for (const field of knotFields) {
                const knotId = fields[field];
                if (typeof knotId === 'string') into.add(knotId);
            }
        }
    };

    // A knot survives if anything still hanging from it needs it -- every type
    // the registry says hangs from a knot, rather than the branch and leaf this
    // replaces. Braces and lateral stabilisers read from their kept/regenerated
    // collections so entities removed in this pass do NOT hold their knots alive.
    const preservedKnotIds = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
        const collection = descriptor.location.key === bracesKey
            ? keptBraces as unknown as Record<string, unknown>
            : stabiliserKeys.has(descriptor.location.key)
                ? (stabiliserState as unknown as Record<string, unknown>)[descriptor.location.key] as Record<string, unknown>
                : snapshot[descriptor.location.key] as unknown as Record<string, unknown>;
        addHostKnots(descriptor, collection, preservedKnotIds);
    }

    const nextKnots: Record<string, Knot> = {};
    for (const [id, k] of Object.entries(snapshot.knots)) {
        if (targetModelId) {
            const knotModelId = resolveKnotModelId(k);
            if (knotModelId && knotModelId !== targetModelId) {
                nextKnots[id] = k;
                continue;
            }
        }
        if (!candidateDropKnotIds.has(id) || preservedKnotIds.has(id)) {
            nextKnots[id] = k;
        }
    }

    const selectedBraceId = snapshot.selectedId
        ? parsePrefixedSegmentId(snapshot.selectedId)?.entityId ?? snapshot.selectedId
        : undefined;
    const nextSnapshot: SupportState = {
        ...snapshot,
        braces: keptBraces,
        knots: nextKnots,
        selectedId: (selectedBraceId && snapshot.braces[selectedBraceId] && !keptBraces[selectedBraceId])
            ? null
            : snapshot.selectedId,
    };

    const braceIds = new Set<string>(Object.keys(nextSnapshot.braces));
    const knotIds = new Set<string>(Object.keys(nextSnapshot.knots));
    const createBraceId = createUniqueIdFactory('auto-brace', braceIds);
    const createKnotId = createUniqueIdFactory('auto-brace-knot', knotIds);

    const generatedBraces: Record<string, Brace> = {};
    const generatedKnots: Record<string, Knot> = {};
    const takeBraceKnot = makeBraceKnotTaker(nextSnapshot.knots, createKnotId);

    // Trunk-to-trunk brace axes actually placed by the ladder — used by the
    // post-ladder reconciliation to drop redundant kickstands.
    const bracedAxesByTrunkId = new Map<string, number[]>();

    // Model-wide pair sets, shared by every group's kickstand-edge selection
    // and the ladder. The Voronoi partition can isolate single trunks at
    // dense auto-grid spacings (a seed cell claims one node); per-group
    // pairing then finds no edges for them and they get kickstands despite
    // braceable neighbors. Distance limits (maxRun) keep the global pairing
    // local.
    const pairsByModel = new Map<string, Edge[]>();
    const pairDistanceOverrides = new Map<string, PairDistanceOverride>();
    const pairKey = (aId: string, bId: string) => [aId, bId].sort().join(':');
    const braceProfile = buildBraceProfile(settings.braceDiameterMm);

    for (let groupIndex = 0; groupIndex < groupedSupports.length; groupIndex += 1) {
        const groupMembers = groupedSupports[groupIndex];
        const groupTrunks = groupMembers.filter((s) => isAutoBraceableShaftType(s.supportKind));
        const modelId = groupTrunks[0]?.modelId;
        let pairs = modelId ? pairsByModel.get(modelId) : undefined;
        if (!pairs) {
            const modelTrunks = trunkSamples.filter((s) => s.modelId === modelId);
            pairs = buildGroupPairs(
                modelTrunks,
                settings.maxBraceLengthMm,
                activeGridSettings,
                autoBracingMinPairSpanMm(settings),
                ladderFilter,
            );
            for (const e of pairs) {
                if (e.diagonalFallback) {
                    pairDistanceOverrides.set(pairKey(e.a.supportId, e.b.supportId), {
                        ignoreMaxDistance: false,
                        allowDiagonal: true,
                    });
                }
            }
            if (modelId) pairsByModel.set(modelId, pairs);
        }
        const extra = groupMembers.filter((s) => isLateralStabiliserType(s.supportKind));
        if (extra.length > 0 && groupTrunks.length > 0) {
            const stabiliserCandidateEdges: Edge[] = [];
            for (const sb of extra) {
                const ignoreDistanceForSb = generatedStabiliserIds.has(sb.supportId);
                for (const trunk of groupTrunks) {
                    let d: { hDist: number; angleRad: number } | null = null;

                    if (activeGridSettings.enabled) {
                        const aBase = getGridCorrelatedPoint(trunk, activeGridSettings);
                        const bBase = getGridCorrelatedPoint(sb, activeGridSettings);
                        const dx = bBase.x - aBase.x;
                        const dy = bBase.y - aBase.y;
                        if (!ignoreDistanceForSb && !isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) continue;

                        const hDist = Math.sqrt(dx * dx + dy * dy);
                        if (hDist < 0.000001) {
                            if (!ignoreDistanceForSb) continue;
                            const zRef = referenceZForDistance(trunk, sb);
                            d = horizontalDistanceAtZ(trunk, sb, zRef);
                            if (!d) continue;
                        } else {
                            d = { hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) };
                        }
                    } else {
                        const zRef = referenceZForDistance(trunk, sb);
                        d = horizontalDistanceAtZ(trunk, sb, zRef);
                        if (!d) continue;
                    }

                    if (!d) continue;
                    if (d.hDist > maxRun + EPS && !ignoreDistanceForSb) continue;
                    stabiliserCandidateEdges.push({
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
                    const ignoreDistanceForPair = generatedStabiliserIds.has(sb1.supportId)
                        || generatedStabiliserIds.has(sb2.supportId);
                    let d: { hDist: number; angleRad: number } | null = null;

                    if (activeGridSettings.enabled) {
                        const aBase = getGridCorrelatedPoint(sb1, activeGridSettings);
                        const bBase = getGridCorrelatedPoint(sb2, activeGridSettings);
                        const dx = bBase.x - aBase.x;
                        const dy = bBase.y - aBase.y;
                        if (!ignoreDistanceForPair && !isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) continue;

                        const hDist = Math.sqrt(dx * dx + dy * dy);
                        if (hDist < 0.000001) {
                            if (!ignoreDistanceForPair) continue;
                            const zRef = referenceZForDistance(sb1, sb2);
                            d = horizontalDistanceAtZ(sb1, sb2, zRef);
                            if (!d) continue;
                        } else {
                            d = { hDist, angleRad: normalizeAxisAngleRad(Math.atan2(dy, dx)) };
                        }
                    } else {
                        const zRef = referenceZForDistance(sb1, sb2);
                        d = horizontalDistanceAtZ(sb1, sb2, zRef);
                        if (!d) continue;
                    }

                    if (!d) continue;
                    if (d.hDist > maxRun + EPS && !ignoreDistanceForPair) continue;
                    stabiliserCandidateEdges.push({
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
            const stabiliserEdgeCount = new Map<string, number>();

            const inc = (map: Map<string, number>, key: string) => {
                map.set(key, (map.get(key) ?? 0) + 1);
            };

            const canTake = (trunkId: string, sbId: string) => {
                const tCount = trunkEdgeCount.get(trunkId) ?? 0;
                const sbCount = stabiliserEdgeCount.get(sbId) ?? 0;
                return tCount < KICKSTAND_MAX_EDGES_PER_TRUNK && sbCount < KICKSTAND_MAX_EDGES_PER_KICKSTAND;
            };

            const addEdge = (e: Edge) => {
                pairs.push(e);
                existingEdgeIds.add(edgeId(e));
                inc(trunkEdgeCount, e.a.supportId);
                inc(stabiliserEdgeCount, e.b.supportId);
                if (generatedStabiliserIds.has(e.a.supportId) || generatedStabiliserIds.has(e.b.supportId)) {
                    pairDistanceOverrides.set(pairKey(e.a.supportId, e.b.supportId), { ignoreMaxDistance: true });
                }
            };

            for (const sb of extra) {
                const candidates = stabiliserCandidateEdges
                    .filter((e) => e.b.supportId === sb.supportId)
                    .sort((x, y) => x.hDist - y.hDist);

                let chosen: Edge | null = null;
                const assignedHostTrunkId = assignedHostIdByStabiliserId.get(sb.supportId) ?? null;
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

                for (const cand of stabiliserCandidateEdges) {
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
    }

    // ── Ladder ─────────────────────────────────────────────────────
    // Runs once per model over the model-wide pairs (shared with the
    // kickstand decisions), so a trunk's braces match what the kickstand
    // logic saw — no kickstands next to fully braced trunks.
    for (const [modelId, pairs] of pairsByModel) {
        const modelTrunks = trunkSamples.filter((s) => s.modelId === modelId);
        const maxZ = Math.max(...modelTrunks.map(s => s.topReferenceZ));

        const ladder: number[] = [settings.initialDistanceMm];
        let curr = settings.initialDistanceMm + settings.patternIntervalMm;
        while (curr <= maxZ) { ladder.push(curr); curr += settings.patternIntervalMm; }

            const place = (
                lowS: SupportSample,
                highS: SupportSample,
                section: 'initial' | 'repeating',
                atZ: number,
                minRiseMm = 0,
            ) => {
                const distanceOverride = pairDistanceOverrides.get(pairKey(lowS.supportId, highS.supportId));
                const ignoreMaxDistance = Boolean(distanceOverride?.ignoreMaxDistance);
                const allowDiagonal = Boolean(distanceOverride?.allowDiagonal);
                const lowAnchor = resolveAnchorAtZ(lowS, atZ);
                if (!lowAnchor) return;

                const sameTierAnchor = resolveAnchorAtZ(highS, atZ);
                if (!sameTierAnchor) return;

                // Solve for a 45° link (rise == horizontal span), but never
                // rise less than the caller's floor: a chain passing a floor
                // makes the link steeper instead of denser.
                let dzGuess = Math.max(minRiseMm, Math.sqrt(
                    (sameTierAnchor.pos.x - lowAnchor.pos.x) ** 2
                    + (sameTierAnchor.pos.y - lowAnchor.pos.y) ** 2,
                ));

                let highAnchor: AnchorPoint | null = null;
                for (let iter = 0; iter < 3; iter++) {
                    highAnchor = resolveAnchorAtZ(highS, atZ + dzGuess);
                    if (!highAnchor) return;
                    const hDist = Math.sqrt(
                        (highAnchor.pos.x - lowAnchor.pos.x) ** 2
                        + (highAnchor.pos.y - lowAnchor.pos.y) ** 2,
                    );
                    const nextGuess = Math.max(minRiseMm, hDist);
                    if (Math.abs(nextGuess - dzGuess) < 0.01) {
                        dzGuess = nextGuess;
                        break;
                    }
                    dzGuess = nextGuess;
                    if (dzGuess < EPS) return;
                }

                if (!ignoreMaxDistance && dzGuess > maxRun + EPS) return;

                if (atZ + dzGuess >= lowS.topReferenceZ - 0.1 || atZ + dzGuess >= highS.topReferenceZ - 0.1) return;

                highAnchor = resolveAnchorAtZ(highS, atZ + dzGuess);
                if (!highAnchor) return;
                if (braceAtZWithinCanopy(lowS, lowAnchor.pos.z) || braceAtZWithinCanopy(highS, highAnchor.pos.z)) return;

                const dx = highAnchor.pos.x - lowAnchor.pos.x;
                const dy = highAnchor.pos.y - lowAnchor.pos.y;
                const dz = highAnchor.pos.z - lowAnchor.pos.z;

                if (activeGridSettings.enabled) {
                    if (!ignoreMaxDistance && !allowDiagonal && !isCardinalDelta(dx, dy, activeGridSettings.spacingMm)) return;
                }

                const horizontalSpan = Math.sqrt(dx * dx + dy * dy);
                if (!ignoreMaxDistance && horizontalSpan > settings.maxBraceLengthMm + EPS) return;

                if (!linePassesMeshClearance(lowAnchor.pos, highAnchor.pos, lowAnchor.modelId, settings.braceDiameterMm, activePlateModelIds)) return;

                const bId = createBraceId();
                const lowBraceKnot = takeBraceKnot(lowAnchor.segmentId, lowAnchor.pos, lowAnchor.t, lowAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM);
                const highBraceKnot = takeBraceKnot(highAnchor.segmentId, highAnchor.pos, highAnchor.t, highAnchor.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM);
                generatedBraces[bId] = { id: bId, modelId: lowAnchor.modelId, startKnotId: lowBraceKnot.id, endKnotId: highBraceKnot.id, profile: braceProfile, debugSection: section, generatedBy: 'autoBracing' };

                // Only trunk↔trunk braces count toward the two-axis stability
                // contract — braces to kickstands are the kickstand's own bracing.
                if (isAutoBraceableShaftType(lowS.supportKind) && isAutoBraceableShaftType(highS.supportKind)) {
                    const angleRad = normalizeAxisAngleRad(Math.atan2(dy, dx));
                    for (const tid of [lowS.supportId, highS.supportId]) {
                        const list = bracedAxesByTrunkId.get(tid) ?? [];
                        list.push(angleRad);
                        bracedAxesByTrunkId.set(tid, list);
                    }
                }
            };
        // Zigzag runs as continuous per-edge chains (each link starts where
        // the previous ended, stepping by its own rise) rather than the
        // fixed-interval ladder — patternInterval does not apply to it.
        // The chain still climbs at least this per link; the floor is
        // independent of initialDistanceMm / patternIntervalMm, which describe
        // where tiers start, not how tight a single chain may be.
        const zigZagMinRiseMm = AUTO_BRACING_HARD_RULES.minZigZagRiseMm;
        if (settings.initialPattern === 'zigZag') {
            runZigZagChain(pairs, settings.initialDistanceMm, maxZ, 'initial', place, zigZagMinRiseMm);
        } else {
            if (settings.repeatingPattern === 'zigZag') {
                runZigZagChain(
                    pairs,
                    settings.initialDistanceMm + settings.patternIntervalMm,
                    maxZ,
                    'repeating',
                    place,
                    zigZagMinRiseMm,
                );
            }
            ladder.forEach((anchorZ, tierIndex) => {
                const isInitial = tierIndex === 0;
                const pattern = isInitial ? settings.initialPattern : settings.repeatingPattern;
                // Zigzag tiers are covered by the chains above.
                if (pattern === 'zigZag') return;
                const placeAtTier = (lowS: SupportSample, highS: SupportSample, section: 'initial' | 'repeating') =>
                    place(lowS, highS, section, anchorZ);
                if (isInitial) {
                    applyInitialPattern(pairs, pattern, placeAtTier);
                } else {
                    applyRepeatingPattern(pairs, pattern, placeAtTier);
                }
            });
        }
    }

    // ── Post-ladder reconciliation ──────────────────────────────────
    // Kickstands are generated from the PRELIMINARY pairing, before the
    // ladder places real trunk-to-trunk braces. A kickstand whose host trunk
    // ended up with two qualified trunk-trunk brace axes is redundant — drop
    // it (and its braces/knots) so the forest braces trunks together instead
    // of stacking a kickstand next to an already-stable trunk.
    if (generatedStabilisers.length > 0 && bracedAxesByTrunkId.size > 0) {
        const drops = new Set<string>();
        for (const id of generatedStabiliserIds) {
            const ks = stabiliserState.kickstands[id];
            if (!ks) continue;
            const hostTrunkId = segmentOwnerTrunkId.get(ks.hostSegmentId);
            if (!hostTrunkId) continue;
            const axes = bracedAxesByTrunkId.get(hostTrunkId) ?? [];
            if (hasQualifiedTwoAxisBracing(axes, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg)) {
                drops.add(id);
            }
        }

        if (drops.size > 0) {
            generatedStabiliserCount = Math.max(0, generatedStabilisers.length - drops.size);
            const droppedSegmentIds = new Set<string>();
            for (const id of drops) {
                const ks = stabiliserState.kickstands[id];
                if (!ks) continue;
                for (const seg of ks.segments) droppedSegmentIds.add(seg.id);
            }

            const keptStabilisers: StabiliserSource['kickstands'] = {};
            const keptRoots: StabiliserSource['roots'] = {};
            const keptKnots: StabiliserSource['knots'] = {};
            for (const [id, ks] of Object.entries(stabiliserState.kickstands)) {
                if (drops.has(id)) continue;
                keptStabilisers[id] = ks;
                const root = stabiliserState.roots[ks.rootId];
                if (root) keptRoots[root.id] = root;
                const knot = stabiliserState.knots[ks.hostKnotId];
                if (knot) keptKnots[knot.id] = knot;
            }
            stabiliserState = { ...stabiliserState, kickstands: keptStabilisers, roots: keptRoots, knots: keptKnots };

            // Drop braces + knots attached to the removed kickstands.
            for (const [bId, brace] of Object.entries(generatedBraces)) {
                const sk = generatedKnots[brace.startKnotId];
                const ek = generatedKnots[brace.endKnotId];
                const touchesDropped = (sk && droppedSegmentIds.has(sk.parentShaftId))
                    || (ek && droppedSegmentIds.has(ek.parentShaftId));
                if (touchesDropped) {
                    delete generatedBraces[bId];
                    if (sk) delete generatedKnots[brace.startKnotId];
                    if (ek) delete generatedKnots[brace.endKnotId];
                }
            }
        }
    }

    nextSnapshot.knots = { ...nextSnapshot.knots, ...generatedKnots };
    nextSnapshot.braces = { ...keptBraces, ...generatedBraces };

    const generatedBraceCount = Object.keys(generatedBraces).length;
    const removedBraceCount = removedBraceCountForPass;
    const changed =
        generatedBraceCount > 0 ||
        removedBraceCount > 0 ||
        generatedStabiliserCount > 0 ||
        removedAutoGeneratedCount > 0 ||
        removedStabiliserRootIds.size > 0;

    // Fold the kickstand result back in: nextSnapshot was spread from the input
    // and still holds the pre-regeneration kickstands.
    // Only kickstand-owned roots and knots: stabiliserState comes from the input
    // snapshot, so a wholesale merge would restore the pruned brace knots.
    const nextRootsWithStabilisers = { ...nextSnapshot.roots };
    if (removedStabiliserRootIds.size > 0) {
        const referencedTrunkRootIds = new Set<string>();
        for (const trunk of Object.values(nextSnapshot.trunks)) {
            if (trunk.rootId) referencedTrunkRootIds.add(trunk.rootId);
        }
        for (const removedRootId of removedStabiliserRootIds) {
            const existingRoot = nextRootsWithStabilisers[removedRootId];
            if (!existingRoot) continue;
            if (targetModelId && existingRoot.modelId && existingRoot.modelId !== targetModelId) continue;
            if (!referencedTrunkRootIds.has(removedRootId)) {
                delete nextRootsWithStabilisers[removedRootId];
            }
        }
    }

    const snapshotWithStabilisers: SupportState = {
        ...nextSnapshot,
        kickstands: stabiliserState.kickstands,
        roots: nextRootsWithStabilisers,
        knots: { ...nextSnapshot.knots },
        selectedId: selectedStabiliserCleared ? null : nextSnapshot.selectedId,
    };
    for (const kickstand of Object.values(stabiliserState.kickstands)) {
        const root = stabiliserState.roots[kickstand.rootId];
        if (root) snapshotWithStabilisers.roots[root.id] = root;
        const hostKnot = stabiliserState.knots[kickstand.hostKnotId];
        if (hostKnot) snapshotWithStabilisers.knots[hostKnot.id] = hostKnot;
    }

    return {
        snapshot: snapshotWithStabilisers,
        generatedBraceCount,
        removedBraceCount,
        skippedSupportCount: trunkSamples.length - groupedIds.size,
        changed,
        status: changed ? 'complete' : 'no-eligible-supports',
    };
}

export function runAutoBracing(): AutoBraceResult {
    const before = cloneSupportState(getSnapshot());
    const built = buildAutoBracedSnapshot(before, getSettings().autoBracing);
    if (!built.changed) return built;

    setSnapshot(built.snapshot);
    pushSupportHistory({
        type: SUPPORT_AUTO_BRACE_REPLACE,
        payload: {
            before,
            after: built.snapshot,
        },
    });
    return built;
}

/**
 * Removes every brace and kickstand of one model and returns how many went.
 *
 * A kickstand is a lateral stabiliser — a brace that stands on its own root
 * instead of spanning two supports — so Clear All takes both. The whole sweep
 * is one cascade, one state write, and one history entry: the payload is a
 * before/after pair, which is what makes it one undo step rather than one per
 * member. Removing member by member rebuilt the dependency graph each time, so
 * Clear All was quadratic in brace count and froze the main thread.
 */
export function clearBracesForModel(modelId: string | null | undefined): number {
    if (!modelId) return 0;

    const snapshot = getSnapshot();
    const seeds = [
        ...Object.values(snapshot.braces)
            .filter((brace) => brace.modelId === modelId)
            .map((brace) => ({ collection: 'braces' as const, id: brace.id })),
        ...Object.values(snapshot.kickstands)
            // A kickstand written before the entity carried `modelId` is owned
            // by the model of its root; the exporter reads it the same way.
            .filter((kickstand) => (kickstand.modelId ?? snapshot.roots[kickstand.rootId]?.modelId) === modelId)
            .map((kickstand) => ({ collection: 'kickstands' as const, id: kickstand.id })),
    ];
    if (seeds.length === 0) return 0;

    const before = cloneSupportState(snapshot);
    removeSupportEntities(seeds);

    pushSupportHistory({
        type: SUPPORT_AUTO_BRACE_REPLACE,
        payload: {
            before,
            after: cloneSupportState(getSnapshot()),
        },
    });
    return seeds.length;
}

type BuildSnapshotResult = AutoBraceResult & { snapshot: SupportState };

export interface StressBraceRequest {
    /** Support entity at one end (a tip's support, or the overloaded member). */
    aEntityId: string;
    /** Support entity at the other end; absent => nearest legal host to `near`. */
    bEntityId?: string;
    /** Preferred link height (mm); clamped into both supports' Z overlap. */
    atZMm: number;
    /** Plan point used to find a neighbour when `bEntityId` is absent. */
    near?: Vec3;
    /** Override for the link's own span (mm). A rocking pair may be farther
     *  apart than the auto-bracing ladder's aesthetic `maxBraceLengthMm`; the
     *  caller measures the pair and passes that span. */
    maxSpanMm?: number;
}

export interface StressBraceResult {
    snapshot: SupportState;
    added: number;
    skipped: number;
    changed: boolean;
    reasons: Partial<Record<'noEndpoints' | 'noHost' | 'noLegalLink' | 'duplicate' | 'blocked', number>>;
}

/**
 * Adds braces for solver-derived stress actions (`planStressActions`), reusing
 * the auto-brace conventions: a 45° link from a low anchor, knots on the two
 * host segments, the settings' brace diameter, and the mesh-clearance gate.
 *
 * This is the execution half of the closed loop. It does not decide what needs
 * bracing — the report already did — and it will not invent a host for an
 * overloaded member: when no second shaft is within `maxBraceLengthMm`, the
 * action is skipped and counted, so the caller can decide to promote the leaf
 * instead of silently thickening it to its cap again.
 */
export function addTargetedStressBraces(
    snapshot: SupportState,
    requests: readonly StressBraceRequest[],
    settings: AutoBracingSettings,
    allowedModelIds?: ReadonlySet<string>,
): StressBraceResult {
    const next = cloneSupportState(snapshot);
    const samples = buildSupportSamples(next);
    const sampleById = new Map(samples.map((sample) => [sample.supportId, sample]));
    const supportBySegment = new Map<string, string>();
    for (const sample of samples) {
        for (const segment of sample.segments) supportBySegment.set(segment.segmentId, sample.supportId);
    }

    const braceProfile = buildBraceProfile(settings.braceDiameterMm);
    const braceIds = new Set(Object.keys(next.braces));
    const knotIds = new Set(Object.keys(next.knots));
    const createBraceId = createUniqueIdFactory('auto-brace', braceIds);
    const createKnotId = createUniqueIdFactory('auto-brace-knot', knotIds);
    const takeBraceKnot = makeBraceKnotTaker(next.knots, createKnotId);

    /** A rocking pair is reported by contact entity: a leaf has no shaft of
     *  its own, so resolve it to the support tree that hosts it (the parent
     *  knot's owning trunk/branch). Without this a leaf pair skipped as
     *  `noEndpoints` and the report kept recommending a brace nothing could
     *  place. */
    const resolveSupportId = (entityId: string): string | undefined => {
        if (sampleById.has(entityId)) return entityId;
        const hostSupportId = (parentKnotId: string | undefined): string | undefined => {
            if (!parentKnotId) return undefined;
            const knot = next.knots?.[parentKnotId];
            if (!knot?.parentShaftId) return undefined;
            return supportBySegment.get(knot.parentShaftId)
                ?? (sampleById.has(knot.parentShaftId) ? knot.parentShaftId : undefined);
        };
        const leaf = next.leaves?.[entityId];
        if (leaf) {
            const id = hostSupportId(leaf.parentKnotId);
            if (id) return id;
        }
        const branch = next.branches?.[entityId];
        if (branch) {
            const id = hostSupportId(branch.parentKnotId);
            if (id) return id;
        }
        return undefined;
    };

    const pairKey = (aId: string, bId: string): string => [aId, bId].sort().join('|');
    /** A targeted action never stacks a second brace between the same pair at
     *  another height; one link is the action. */
    const existingPairIds = new Set<string>();
    for (const brace of Object.values(next.braces)) {
        const start = next.knots[brace.startKnotId];
        const end = next.knots[brace.endKnotId];
        if (!start || !end) continue;
        const aId = supportBySegment.get(start.parentShaftId) ?? start.parentShaftId;
        const bId = supportBySegment.get(end.parentShaftId) ?? end.parentShaftId;
        existingPairIds.add(pairKey(aId, bId));
    }

    const reasons: StressBraceResult['reasons'] = {};
    const bump = (reason: keyof NonNullable<StressBraceResult['reasons']>): void => {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    let added = 0;
    let skipped = 0;

    for (const request of requests) {
        const aId = resolveSupportId(request.aEntityId);
        const a = aId ? sampleById.get(aId) : undefined;
        if (!a) {
            bump('noEndpoints');
            skipped++;
            continue;
        }
        const maxSpanMm = request.maxSpanMm ?? settings.maxBraceLengthMm;

        const candidates: SupportSample[] = [];
        if (request.bEntityId) {
            const bId = resolveSupportId(request.bEntityId);
            const b = bId ? sampleById.get(bId) : undefined;
            if (!b) {
                bump('noEndpoints');
                skipped++;
                continue;
            }
            if (b.supportId === a.supportId) {
                bump('duplicate');
                skipped++;
                continue;
            }
            candidates.push(b);
        } else {
            const target = request.near ?? a.sortAnchor;
            const neighbours = samples
                .filter((sample) => sample.supportId !== a.supportId && sample.modelId === a.modelId)
                .map((sample) => ({
                    sample,
                    distance: Math.hypot(sample.sortAnchor.x - target.x, sample.sortAnchor.y - target.y),
                }))
                .filter((entry) => entry.distance <= maxSpanMm + EPS)
                .sort((x, y) => x.distance - y.distance || x.sample.supportId.localeCompare(y.sample.supportId))
                .slice(0, 8);
            candidates.push(...neighbours.map((entry) => entry.sample));
        }
        if (candidates.length === 0) {
            bump('noHost');
            skipped++;
            continue;
        }

        let placed = false;
        let sawDuplicate = false;
        let sawBlocked = false;
        for (const b of candidates) {
            if (b.modelId !== a.modelId) continue;
            const key = pairKey(a.supportId, b.supportId);
            const zLow = Math.max(a.bottomReferenceZ, b.bottomReferenceZ);
            const zHigh = Math.min(a.topReferenceZ, b.topReferenceZ) - BRACE_CANOPY_KEEP_OUT_MM;
            if (zHigh - zLow < 0.5) continue;
            const rungTarget = Math.round(request.atZMm / BRACE_RUNG_MM) * BRACE_RUNG_MM;
            const clampedTarget = THREE.MathUtils.clamp(rungTarget, zLow + 0.25, zHigh - 0.25);
            const attempts = [...new Set([
                Math.round(clampedTarget * 1000) / 1000,
                Math.round((zLow + 0.25) * 1000) / 1000,
                Math.round((zHigh - 0.25) * 1000) / 1000,
            ])];

            for (const atZ of attempts) {
                for (const [lowS, highS] of [[a, b], [b, a]] as const) {
                    const low = resolveAnchorAtZ(lowS, atZ);
                    if (!low) continue;
                    // A lateral tie is horizontal at the layer: a rocking pair
                    // spanning the part cannot climb a 45° ladder into supports
                    // that end at that height. Try the tie first, then the
                    // auto-brace 45° link as the fallback.
                    const linkModes: Array<() => AnchorPoint | null> = [
                        () => resolveAnchorAtZ(highS, atZ),
                        () => {
                            const sameTier = resolveAnchorAtZ(highS, atZ);
                            if (!sameTier) return null;
                            const hDist = Math.hypot(
                                sameTier.pos.x - low.pos.x,
                                sameTier.pos.y - low.pos.y,
                            );
                            if (hDist < 1e-3 || hDist > maxSpanMm + EPS) return null;
                            if (atZ + hDist >= lowS.topReferenceZ - 0.1 || atZ + hDist >= highS.topReferenceZ - 0.1) {
                                return null;
                            }
                            return resolveAnchorAtZ(highS, atZ + hDist);
                        },
                    ];
                    for (const resolveHigh of linkModes) {
                        const high = resolveHigh();
                        if (!high) continue;
                        if (braceAtZWithinCanopy(lowS, low.pos.z) || braceAtZWithinCanopy(highS, high.pos.z)) continue;
                        const span = Math.hypot(
                            high.pos.x - low.pos.x,
                            high.pos.y - low.pos.y,
                            high.pos.z - low.pos.z,
                        );
                        if (span < 1e-3 || span > maxSpanMm + EPS) continue;
                        if (existingPairIds.has(key)) {
                            sawDuplicate = true;
                            continue;
                        }
                        const allowed = allowedModelIds ?? new Set([a.modelId]);
                        if (!linePassesMeshClearance(low.pos, high.pos, a.modelId, settings.braceDiameterMm, allowed)) {
                            sawBlocked = true;
                            continue;
                        }

                        const braceId = createBraceId();
                        const startKnot = takeBraceKnot(low.segmentId, low.pos, low.t, low.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM);
                        const endKnot = takeBraceKnot(high.segmentId, high.pos, high.t, high.hostDiameterMm + JOINT_DIAMETER_OFFSET_MM);
                        next.braces[braceId] = {
                            id: braceId,
                            modelId: a.modelId,
                            startKnotId: startKnot.id,
                            endKnotId: endKnot.id,
                            profile: braceProfile,
                            debugSection: 'repeating',
                            generatedBy: 'autoBracing',
                        };
                        existingPairIds.add(key);
                        added++;
                        placed = true;
                        break;
                    }
                    if (placed) break;
                }
                if (placed) break;
            }
            if (placed) break;
        }

        if (!placed) {
            skipped++;
            if (sawDuplicate && !sawBlocked) bump('duplicate');
            else if (sawBlocked) bump('blocked');
            else bump('noLegalLink');
        }
    }

    return { snapshot: next, added, skipped, changed: added > 0, reasons };
}
