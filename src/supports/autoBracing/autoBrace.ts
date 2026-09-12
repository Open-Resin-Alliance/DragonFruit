import * as THREE from 'three';

import { pushSupportHistory } from '@/supports/history/supportHistory';
import { getSettings } from '../Settings/state';
import {
    SUPPORT_AUTO_BRACE_REPLACE,
    type SupportReplaceStatePayload,
} from '../history/actionTypes';
import { cloneSupportState, getSnapshot, setSnapshot } from '../state';
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
import type { KickstandBuildResult } from '../SupportTypes/Kickstand/types';
import { generateLateralStabilisers, getSupportTypeDescriptor, lateralStabiliserTypes, SUPPORT_TYPES, type SupportCollectionKey, type SupportEdge, type SupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';
import { resolveSegmentEndpoints } from '../SupportPrimitives/Knot/segmentEndpoints';
import { linePassesMeshClearance } from './meshClearance';

const EPS = 0.000001;
/** The types auto-bracing samples. Derived, so a ninth type joins by declaring it. */
type SupportKind = SupportTypeId;

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

/**
 * Shaft samples for every type auto-bracing can brace.
 *
 * Endpoints now come from the shared walker, and which types take part is
 * declared as `isAutoBraceable`.
 */
function buildSupportSamples(snapshot: SupportState): SupportSample[] {
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
            const hostKnotId = knotField ? (entity as Record<string, unknown>)[knotField] : undefined;
            const hosts = {
                root: entity.rootId ? snapshot.roots[entity.rootId] : undefined,
                hostKnot: typeof hostKnotId === 'string' ? snapshot.knots[hostKnotId] : undefined,
            };

            const segments: SegmentSample[] = [];
            entity.segments.forEach((seg, idx) => {
                const ep = resolveSegmentEndpoints(descriptor.id, entity, seg, idx, hosts);
                if (ep) segments.push({ segmentId: seg.id, segment: seg, start: ep.start, end: ep.end, diameterMm: seg.diameter });
            });
            if (segments.length === 0) continue;

            supports.push({
                supportId: entity.id,
                supportKind: descriptor.id,
                modelId: entity.modelId,
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
function buildStabiliserSamples(stabiliserState: StabiliserSource): SupportSample[] {
    return buildSupportSamples(stabiliserState as SupportState);
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
            // below minSpanMm the two supports are one post: bracing between
            // them is material with no stiffness to show for it
            if (hDist < Math.max(0.001, minSpanMm) || hDist > maxRun) continue;
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

/** Kickstand state is derived from the snapshot; a second argument could only disagree. */
export function buildAutoBracedSnapshot(snapshot: SupportState, inputSettings: AutoBracingSettings): BuildSnapshotResult {
    const stabiliserBase: StabiliserSource = {
        kickstands: snapshot.kickstands,
        roots: snapshot.roots,
        knots: snapshot.knots,
    };
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
            status: 'no-eligible-supports',
        };
    }

    let stabiliserState = stabiliserBase;
    let selectedStabiliserCleared: boolean | null = null;
    {
        const nextStabilisers: StabiliserSource['kickstands'] = {};
        const nextRoots: StabiliserSource['roots'] = {};
        const nextKnots: StabiliserSource['knots'] = {};
        let removedAutoGeneratedCount = 0;

        // Keeps every stabiliser this run did not generate, along with the
        // primitives it claims through its declared edges.
        for (const typeId of lateralStabiliserTypes()) {
            const descriptor = getSupportTypeDescriptor(typeId);
            const collection = (stabiliserState as unknown as Record<string, Record<string, Record<string, unknown>>>)[descriptor.location.key] ?? {};

            for (const [id, entity] of Object.entries(collection)) {
                if (entity.generatedBy === 'autoBracing') {
                    removedAutoGeneratedCount += 1;
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
    for (const modelTrunks of trunksByModel.values()) {
        const pairs = buildGroupPairs(
            modelTrunks,
            settings.maxBraceLengthMm,
            activeGridSettings,
            autoBracingMinPairSpanMm(settings),
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
    const generatedStabilisers = lateralStabiliserTypes().flatMap((typeId) =>
        generateLateralStabilisers(typeId, {
            snapshot,
            existing: stabiliserState,
            settings,
            existingEdges: existingTrunkEdges,
            gridSettings: activeGridSettings,
        }) as KickstandBuildResult[]);
    
    let generatedStabiliserCount = 0;
    const generatedStabiliserIds = new Set<string>();
    if (generatedStabilisers.length > 0) {
        const nextStabilisers = { ...stabiliserState.kickstands };
        const nextRoots = { ...stabiliserState.roots };
        const nextKnots = { ...stabiliserState.knots };

        for (const build of generatedStabilisers) {
            build.kickstand.hostSegmentId = build.kickstand.hostSegmentId || build.hostKnot.parentShaftId;
            build.kickstand.generatedBy = 'autoBracing';
            generatedStabiliserIds.add(build.kickstand.id);
            nextStabilisers[build.kickstand.id] = build.kickstand;
            nextRoots[build.root.id] = build.root;
            nextKnots[build.hostKnot.id] = build.hostKnot;
        }

        stabiliserState = {
            ...stabiliserState,
            kickstands: nextStabilisers,
            roots: nextRoots,
            knots: nextKnots
        };

        generatedStabiliserCount = generatedStabilisers.length;
    }

    const stabiliserSamples = buildStabiliserSamples(stabiliserState);

    const segmentOwnerTrunkId = new Map<string, string>();
    for (const trunk of Object.values(snapshot.trunks)) {
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

    const groupedIds = new Set<string>();
    groupedSupports.forEach(g => g.forEach(s => { if (s.supportKind === 'trunk') groupedIds.add(s.supportId); }));

    // Keep braces this tool did not generate; `generatedBy` distinguishes them.
    const keptBraces: SupportState['braces'] = {};
    for (const [id, brace] of Object.entries(snapshot.braces)) {
        const isOurs = brace.generatedBy === 'autoBracing';
        if (isOurs && settings.removeExistingBracing) continue;
        keptBraces[id] = brace;
    }

    // The collection this pass rebuilds, so its kept set is read instead of the
    // snapshot's. Named from the registry rather than written as 'braces'.
    const bracesKey = getSupportTypeDescriptor('brace').location.key;

    const braceKnotIds = new Set<string>();
    for (const b of Object.values(snapshot.braces)) { braceKnotIds.add(b.startKnotId); braceKnotIds.add(b.endKnotId); }

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
    // replaces. Kickstand host knots were already safe by another route (the
    // stabiliser pass above re-adds them), so this changes nothing today; it is
    // the ninth type that would otherwise be missed.
    //
    // Braces read from `keptBraces` rather than the snapshot: the ones this pass
    // is removing must NOT hold their endpoints alive.
    const preservedKnotIds = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
        const collection = descriptor.location.key === bracesKey
            ? keptBraces as unknown as Record<string, unknown>
            : snapshot[descriptor.location.key] as unknown as Record<string, unknown>;
        addHostKnots(descriptor, collection, preservedKnotIds);
    }

    const nextKnots: Record<string, Knot> = {};
    for (const [id, k] of Object.entries(snapshot.knots)) { if (!braceKnotIds.has(id) || preservedKnotIds.has(id)) nextKnots[id] = k; }

    const selectedBraceId = snapshot.selectedId?.replace('braceSegment:', '');
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
        const groupTrunks = groupMembers.filter((s) => s.supportKind === 'trunk');
        const modelId = groupTrunks[0]?.modelId;
        let pairs = modelId ? pairsByModel.get(modelId) : undefined;
        if (!pairs) {
            const modelTrunks = trunkSamples.filter((s) => s.modelId === modelId);
            pairs = buildGroupPairs(
                modelTrunks,
                settings.maxBraceLengthMm,
                activeGridSettings,
                autoBracingMinPairSpanMm(settings),
            );
            if (modelId) pairsByModel.set(modelId, pairs);
        }
        const extra = groupMembers.filter((s) => s.supportKind === 'kickstand');
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
        const modelTrunks = trunkSamples.filter((s) => s.modelId === modelId && s.supportKind === 'trunk');
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
                generatedBraces[bId] = { id: bId, modelId: lowAnchor.modelId, startKnotId: sId, endKnotId: eId, profile: braceProfile, debugSection: section, generatedBy: 'autoBracing' };

                // Only trunk↔trunk braces count toward the two-axis stability
                // contract — braces to kickstands are the kickstand's own bracing.
                if (lowS.supportKind === 'trunk' && highS.supportKind === 'trunk') {
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
        } else if (settings.repeatingPattern === 'zigZag') {
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

    // ── Post-ladder reconciliation ──────────────────────────────────
    // Kickstands are generated from the PRELIMINARY pairing, before the
    // ladder places real trunk-to-trunk braces. A kickstand whose host trunk
    // ended up with two qualified trunk-trunk brace axes is redundant — drop
    // it (and its braces/knots) so the forest braces trunks together instead
    // of stacking a kickstand next to an already-stable trunk.
    if (generatedStabilisers.length > 0 && bracedAxesByTrunkId.size > 0) {
        const drops = new Set<string>();
        for (const build of generatedStabilisers) {
            const hostTrunkId = segmentOwnerTrunkId.get(build.kickstand.hostSegmentId);
            if (!hostTrunkId) continue;
            const axes = bracedAxesByTrunkId.get(hostTrunkId) ?? [];
            if (hasQualifiedTwoAxisBracing(axes, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg)) {
                drops.add(build.kickstand.id);
            }
        }

        if (drops.size > 0) {
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
    const removedBraceCount = Object.keys(snapshot.braces).length;
    const changed = generatedBraceCount > 0 || removedBraceCount > 0;

    // Fold the kickstand result back in: nextSnapshot was spread from the input
    // and still holds the pre-regeneration kickstands.
    // Only kickstand-owned roots and knots: stabiliserState comes from the input
    // snapshot, so a wholesale merge would restore the pruned brace knots.
    const snapshotWithStabilisers: SupportState = {
        ...nextSnapshot,
        kickstands: stabiliserState.kickstands,
        roots: { ...nextSnapshot.roots },
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

type BuildSnapshotResult = AutoBraceResult & { snapshot: SupportState };
