import { SupportState, SupportEntityAny, DragonfruitImportFormat, Trunk, Roots, Segment, BezierSegment, StraightSegment, Branch, BraceCurve, Joint, Knot, Vec3, Leaf, Brace } from './types';
import { calculateBezierControlPoints, getBezierPointAtT, toVector3, toVec3 } from './Curves/BezierUtils';
import { calculateKnotPositionOnSegmentFromT } from './SupportPrimitives/Knot/knotUtils';
import type { SupportSelectionCategory } from './supportTypeRegistry';
import {
    parseInlineRootId,
    typesDeclaringOwnHistoryEntryWithoutUpdate,
    typesMissingContactOverride,
    typesMissingHostPromotion, removalShapeFor, type SupportRemovalResult } from './supportTypeRegistry';
import { collectCascade, groupByCollection, isReferencedOutside } from './supportCascade';
import { pushSupportHistory } from './history/supportHistory';
import { supportSettleFor } from './settle/seam';
import { hasSupportUpdater, hostKnotFieldsFor, typeIdForCollection, updateSupportEntity, JOINT_REMOVAL_TYPES, MODEL_ID_COLLECTION_KEYS, bundledSupportTypeId, parseKnotHostId, parsePrefixedSegmentId, isKnotHostId, isConeKnotHost, isSpanKnotHost, knotHostId, CONE_KNOT_HOST_TYPES, SPAN_KNOT_HOST_TYPES, SUPPORT_COLLECTION_KEYS, contactEndpointsFor, EDITABLE_SUPPORT_TYPES, hasSettingsInference, inferSupportSettings, isEditableSupportType, registerCollectionRestore, collectionsMissingRestore, registerSettingsInference, transformExtrasFor, type SupportTypeDescriptor, createEmptySupportCollections, getSupportTypeDescriptor, registerKnotDiameterRule, registerSupportUpdater, registerSupportTypeResolver, resolveKnotDiameter, resolveSupportTypeIdOf, type SupportEntityFor, SUPPORT_STATE_COLLECTIONS, SUPPORT_TYPES, type SupportTypeId, type JointRemovalTypeId } from './supportTypeRegistry';
import { typesMissingExportGroupBuilder } from './exportGeometry/seam';
import { migrateLegacySupportPayload } from './importMigrations';
import type { SupportCollectionKey } from './supportTypeRegistry';
import type { SupportTipProfile } from './SupportPrimitives/ContactCone/types';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { resolveSegmentEndpoints, type ShaftEntity } from './SupportPrimitives/Knot/segmentEndpoints';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { emitSupportInteractionReset } from './interaction/supportInteractionReset';
import { getJointDiameter, JOINT_DIAMETER_OFFSET_MM } from './constants';
import { mapImportPayloadEntities, mapSupportEntities } from './supportCollections';
import type { Kickstand, KickstandBuildResult } from './SupportTypes/Kickstand/types';
import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { v4 as uuidv4 } from 'uuid';
import { applyImportDefaultsToSupportPayload, getSavedImportDefaultsSettings } from '@/features/scene/importDefaultsPreferences';
import { mergeSettingsWithDefaults, type SupportSettings } from './Settings/types';
import { createDefaultSettings } from './Settings/types';
import { decodeSupportSettingsHex, encodeSupportSettingsHex } from './Settings/supportSettingsCodec';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from './SupportTypes/Twig/twigTaper';

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

/** Settings hex per entity, bucketed by type. Only editable types have one. */
type SupportSettingsHexCache = Record<EditableSupportKind, Record<string, string>>;

/** An empty bucket per editable type, so a new one needs no change here. */
function createEmptySettingsHexCache(): SupportSettingsHexCache {
    const cache = {} as SupportSettingsHexCache;
    for (const descriptor of EDITABLE_SUPPORT_TYPES) {
        cache[descriptor.id] = {};
    }
    return cache;
}

// Entity collections come from the registry; only interaction state is listed here.
const initialState: SupportState = {
    ...createEmptySupportCollections(),
    selectedId: null,
    hoveredId: null,
    selectedCategory: null,
    hoveredCategory: 'none',
    interactionWarning: null,
};

let state: SupportState = { ...initialState };

let supportSettingsHexCache: SupportSettingsHexCache = createEmptySettingsHexCache();

type SelectionCategory = SupportSelectionCategory | null;

/**
 * Primitive ids (joints, segments, contact disks) reachable from support
 * entities, so selection can resolve an id to its category without re-walking
 * every collection on every click.
 *
 * `sources` holds the collection objects the sets were built from; identity
 * comparison against them is the invalidation check.
 */
interface SelectionLookupCache {
    sources: Partial<Record<SupportCollectionKey, unknown>>;
    jointIds: Set<string>;
    segmentIds: Set<string>;
    contactDiskIds: Set<string>;
}

let selectionLookupCache: SelectionLookupCache | null = null;

/**
 * Types that put ids into the cache: anything with segments (joints, segment
 * ids) or contact fields (contact disk ids).
 *
 * Deliberately not every collection -- braces have neither, so watching them
 * would rebuild the cache on brace edits that cannot change its contents.
 */
const SELECTION_LOOKUP_TYPES = SUPPORT_TYPES.filter(
    (descriptor) => descriptor.hasSegments || descriptor.contactFields.length > 0,
);

function getSelectionLookupCache(): SelectionLookupCache {
    if (selectionLookupCache) {
        let stale = false;
        for (const descriptor of SELECTION_LOOKUP_TYPES) {
            if (selectionLookupCache.sources[descriptor.location.key] !== state[descriptor.location.key]) {
                stale = true;
                break;
            }
        }
        if (!stale) return selectionLookupCache;
    }

    const jointIds = new Set<string>();
    const segmentIds = new Set<string>();
    const contactDiskIds = new Set<string>();
    const sources: Partial<Record<SupportCollectionKey, unknown>> = {};

    for (const descriptor of SELECTION_LOOKUP_TYPES) {
        const key = descriptor.location.key;
        sources[key] = state[key];

        for (const entity of Object.values(state[key])) {
            if (descriptor.hasSegments) {
                const segments = (entity as { segments?: Segment[] }).segments ?? [];
                for (const segment of segments) {
                    segmentIds.add(segment.id);
                    if (segment.topJoint?.id) jointIds.add(segment.topJoint.id);
                    if (segment.bottomJoint?.id) jointIds.add(segment.bottomJoint.id);
                }
            }
            const fields = entity as unknown as Record<string, { id?: string } | undefined>;
            for (const field of descriptor.contactFields) {
                const contact = fields[field];
                if (contact?.id) contactDiskIds.add(contact.id);
            }
        }
    }

    selectionLookupCache = { sources, jointIds, segmentIds, contactDiskIds };
    return selectionLookupCache;
}

function resolveSelectionCategory(id: string): SelectionCategory {
    if (!id) return null;
    if (parsePrefixedSegmentId(id)) return 'segment';
    // Entity collections resolve from the registry, in its order.
    for (const { key, selectionCategory } of SUPPORT_STATE_COLLECTIONS) {
        if (state[key][id]) return selectionCategory;
    }

    const lookup = getSelectionLookupCache();
    if (state.knots[id]) return 'knot';
    if (lookup.jointIds.has(id)) return 'joint';
    if (lookup.segmentIds.has(id)) return 'segment';
    if (lookup.contactDiskIds.has(id)) return 'contactDisk';

    return null;
}

function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Remove a support entity and everything the declared graph says depends on it.
 * The return type derives from SUPPORT_REMOVAL_SHAPES, so a field renamed in
 * the registry is a compile error at every consumer.
 *
 * Two forms, told apart by the argument count: `removeSupportEntity(id)` reads
 * the type off the entity and returns the wide union; `(typeId, id)` keeps the
 * result narrow.
 */
export function removeSupportEntity(id: string): SupportRemovalResult<SupportTypeId> | null;
export function removeSupportEntity<T extends SupportTypeId>(
    typeId: T,
    id: string,
): SupportRemovalResult<T> | null;
export function removeSupportEntity<T extends SupportTypeId>(
    typeIdOrId: T | string,
    maybeId?: string,
): SupportRemovalResult<T> | SupportRemovalResult<SupportTypeId> | null {
    const typeId = maybeId === undefined
        ? getSupportTypeOf(typeIdOrId)
        : typeIdOrId as T;
    const id = maybeId ?? typeIdOrId;
    if (!typeId) return null;

    return removeSupportEntityCascading(typeId, id) as SupportRemovalResult<T> | null;
}

/*
 * Per-type wrappers below are DEBT, not API. Each exists only because its call
 * sites are not converted yet; they bind a type id and nothing else. Adding
 * logic to one turns a marker into a second source of truth. Remove them as the
 * callers move to the generic entry points -- see plans/registry-adoption-map.md.
 */

/**
 * Remove an entity and everything the declared graph says depends on it.
 * `collectCascade` finds the doomed set from the registry's edges;
 * `removalShape` names each piece so history payloads keep their field names.
 */
function removeSupportEntityCascading(
    typeId: SupportTypeId,
    id: string,
): Record<string, unknown> | null {
    const descriptor = getSupportTypeDescriptor(typeId);
    const shape = removalShapeFor(typeId);
    const collection = descriptor.location.key;
    const existing = state[collection][id] as { id: string } | undefined;
    if (!existing) return null;

    const doomed = collectCascade(state, [{ collection, id }]);
    const byCollection = groupByCollection(doomed);

    // Snapshot before deleting: the shape is what undo replays from.
    const result: Record<string, unknown> = { [shape.self]: deepClone(existing) };
    const plural = (field: string) => field.endsWith('s');

    for (const [key, field] of Object.entries(shape.cascade as Record<string, string | readonly string[]>)) {
        // The seed is included when its own collection is listed in `cascade`.
        // removeBranch reports every doomed branch, itself among them, because
        // undo replays the list wholesale; removeTrunk names the trunk
        // separately via `self` and does not list `trunks` here.
        const ids = [...(byCollection.get(key as SupportCollectionKey) ?? [])];
        const node = SUPPORT_TYPES.find((d) => d.location.key === key);
        const entities = ids
            .map((entityId) => state[key as SupportCollectionKey][entityId])
            .filter(Boolean)
            .map((entity) => deepClone(entity));

        if (typeof field === 'string') {
            result[field] = plural(field) ? entities : (entities[0] ?? null);
        } else {
            // Positional slots: fill in declared order, pad with null.
            field.forEach((slot, index) => { result[slot] = entities[index] ?? null; });
        }
    }

    // Apply: one state write, one notify.
    const next: Record<string, unknown> = { ...state };
    for (const [key, ids] of byCollection) {
        const record = { ...state[key] } as Record<string, unknown>;
        for (const entityId of ids) delete record[entityId];
        next[key] = record;
    }

    const selectionDoomed = state.selectedId !== null
        && [...byCollection.values()].some((ids) => ids.has(state.selectedId as string));
    if (selectionDoomed) {
        next.selectedId = null;
        next.selectedCategory = null;
    }

    setState(next as unknown as SupportState);

    for (const [key, ids] of byCollection) {
        const node = SUPPORT_TYPES.find((d) => d.location.key === key);
        if (!node?.hasEditableSettings) continue;
        for (const entityId of ids) {
            deleteCachedSupportSettingsHex(node.id, entityId);
        }
    }

    notify();
    return result;
}

function resolveLowerSegmentIndex(segments: Segment[], jointId: string) {
    const byTop = segments.findIndex((seg) => seg.topJoint?.id === jointId);
    if (byTop !== -1) return byTop;
    const upper = segments.findIndex((seg) => seg.bottomJoint?.id === jointId);
    if (upper <= 0) return -1;
    return upper - 1;
}

export function recomputeLeafContactConeAxisAndLength(
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

export function recomputeKnotDependentGeometry(
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

export function recomputeConeHostKnotGeometry(
    leaves: Record<string, Leaf>,
    knots: Record<string, Knot>
): { knots: Record<string, Knot>; changed: boolean } {
    let changed = false;
    let nextKnots = knots;

    for (const knot of Object.values(knots)) {
        const host = parseKnotHostId(knot.parentShaftId);
        if (!host || !isConeKnotHost(host.typeId)) continue;
        const leaf = leaves[host.entityId];
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

function normalizeLoadedKnotAndLeafGeometry(snapshot: Pick<SupportState, SupportCollectionKey>): {
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

    // Twig hosts: a leaf/brace knot can attach to a twig segment (LYS import, PR #156).
    // Without this map the knot's host segment is unresolved during normalization, so
    // its diameter degenerates to the renderer default (oversized) and its position is
    // never reconciled to the twig. Twig segment endpoints are the segment's two joints
    // (same contract useKnotInteraction.resolveEndpoints uses for twig hosts).

    // Segment -> its owning entity and type, so a host can be asked how it sizes
    // knots without this function knowing which types answer.
    const shaftHostBySegmentId = new Map<string, { typeId: SupportTypeId; entity: unknown }>();
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;
        const record = snapshot[descriptor.location.key as SupportCollectionKey] as Record<string, { segments: Segment[] }> | undefined;
        if (!record) continue;
        for (const entity of Object.values(record)) {
            for (const segment of entity.segments) {
                shaftHostBySegmentId.set(segment.id, { typeId: descriptor.id, entity });
            }
        }
    }

    // Track branch parent knots that currently host descendants.
    // If a branch parent knot is hosting descendants, keep it projected to ensure
    // downstream branch/leaf attachments stay segment-legal and connected.
    const branchHostKnotIdsWithChildren = new Set<string>();
    for (const knot of Object.values(snapshot.knots)) {
        const hostBranchRef = branchSegmentMap.get(knot.parentShaftId);
        if (!hostBranchRef) continue;
        branchHostKnotIdsWithChildren.add(hostBranchRef.branch.parentKnotId);
    }

    const branchParentKnotIds = new Set<string>();
    for (const branch of Object.values(snapshot.branches)) {
        branchParentKnotIds.add(branch.parentKnotId);
    }

    const leafParentKnotIds = new Set<string>();
    for (const leaf of Object.values(snapshot.leaves)) {
        leafParentKnotIds.add(leaf.parentKnotId);
    }

    const braceHostKnotIds = new Set<string>();
    const targetHostKnotIds = new Set<string>();
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
    const authoredKnotPosById = new Map<string, Vec3>();
    for (const [knotId, authoredKnot] of Object.entries(snapshot.knots)) {
        authoredKnotPosById.set(knotId, authoredKnot.pos);
    }
    const changedHostPosById: Record<string, Vec3> = {};
    const unresolvedBraceHostWarned = new Set<string>();

    const maxPasses = 4;
    for (let pass = 0; pass < maxPasses; pass++) {
        let changedThisPass = false;

        for (const knotId of targetHostKnotIds) {
            const knot = nextKnots[knotId];
            if (!knot) continue;
            if (isKnotHostId(knot.parentShaftId)) continue;

            let segment: Segment | null = null;
            let endpoints: { start: Vec3; end: Vec3 } | null = null;

            // One walker for every shafted type; the hosts come from the
            // declared endpoints rather than a per-type fallback chain.
            const host = shaftHostBySegmentId.get(knot.parentShaftId);
            if (host) {
                const owner = host.entity as ShaftEntity & { rootId?: string; parentKnotId?: string; hostKnotId?: string };
                const index = owner.segments.findIndex((seg) => seg.id === knot.parentShaftId);
                if (index !== -1) {
                    const descriptor = getSupportTypeDescriptor(host.typeId);
                    const knotField = descriptor.edges.find(
                        (edge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
                    )?.field as keyof typeof owner | undefined;
                    const hostKnotId = knotField ? owner[knotField] : undefined;

                    const resolved = resolveSegmentEndpoints(owner, owner.segments[index], index, {
                        root: owner.rootId ? snapshot.roots[owner.rootId] : undefined,
                        hostKnot: typeof hostKnotId === 'string'
                            ? nextKnots[hostKnotId] ?? snapshot.knots[hostKnotId]
                            : undefined,
                    });
                    if (resolved) {
                        segment = owner.segments[index];
                        endpoints = resolved;
                    }
                }
            }

            if (!segment || !endpoints) {
                if (braceHostKnotIds.has(knot.id) && !unresolvedBraceHostWarned.has(knot.id)) {
                    unresolvedBraceHostWarned.add(knot.id);
                    console.warn('[SupportStore][normalizeLoadedKnotAndLeafGeometry] unresolved brace host knot segment', {
                        knotId: knot.id,
                        parentShaftId: knot.parentShaftId,
                        knotPos: knot.pos,
                    });
                }
                continue;
            }

            const authoredPos = authoredKnotPosById.get(knot.id) ?? knot.pos;
            let activeSegment = segment;
            let activeEndpoints = endpoints;
            let nextParentShaftId = knot.parentShaftId;

            if (braceHostKnotIds.has(knot.id)) {
                const scoreBinding = (
                    targetSegment: Segment,
                    targetEndpoints: { start: Vec3; end: Vec3 },
                    segmentIndex: number,
                    segmentCount: number,
                    axisStart: Vec3,
                    axisEnd: Vec3,
                ): { score: number; t: number; pos: Vec3; distance: number; isEndpoint: boolean } => {
                    const tVal = computeClosestTOnSegmentFromPoint(authoredPos, targetEndpoints.start, targetEndpoints.end, targetSegment);
                    const posVal = calculateKnotPositionOnSegmentFromT(targetEndpoints.start, targetEndpoints.end, targetSegment, tVal);

                    const dxVal = posVal.x - authoredPos.x;
                    const dyVal = posVal.y - authoredPos.y;
                    const dzVal = posVal.z - authoredPos.z;
                    const distanceVal = Math.sqrt(dxVal * dxVal + dyVal * dyVal + dzVal * dzVal);
                    const isEndpointVal = tVal <= 0.02 || tVal >= 0.98;

                    const axisStartVec = new THREE.Vector3(axisStart.x, axisStart.y, axisStart.z);
                    const axisEndVec = new THREE.Vector3(axisEnd.x, axisEnd.y, axisEnd.z);
                    const authoredVec = new THREE.Vector3(authoredPos.x, authoredPos.y, authoredPos.z);
                    const axis = axisEndVec.clone().sub(axisStartVec);
                    const axisLenSq = axis.lengthSq();
                    const axisAlpha = axisLenSq > 1e-8
                        ? THREE.MathUtils.clamp(authoredVec.clone().sub(axisStartVec).dot(axis) / axisLenSq, 0, 1)
                        : 0;
                    const desiredIndex = axisAlpha * Math.max(0, segmentCount - 1);

                    const endpointPenalty = isEndpointVal
                        ? Math.max(0, distanceVal - 0.35) * 4.0 + 0.75
                        : 0;
                    const indexPenalty = Math.abs(segmentIndex - desiredIndex) * 0.25;
                    const score = distanceVal + endpointPenalty + indexPenalty;

                    return {
                        score,
                        t: tVal,
                        pos: posVal,
                        distance: distanceVal,
                        isEndpoint: isEndpointVal,
                    };
                };

                const trunkRef = trunkSegmentMap.get(knot.parentShaftId);
                if (trunkRef?.root) {
                    const segments = trunkRef.trunk.segments;
                    const firstSeg = segments[0];
                    const lastSeg = segments[segments.length - 1];
                    const firstEndpoints = firstSeg
                        ? resolveSegmentEndpoints(trunkRef.trunk, firstSeg, 0, { root: trunkRef.root })
                        : null;
                    const lastEndpoints = lastSeg
                        ? resolveSegmentEndpoints(trunkRef.trunk, lastSeg, segments.length - 1, { root: trunkRef.root })
                        : null;

                    if (segments.length > 0 && firstEndpoints && lastEndpoints) {
                        const currentIndex = Math.max(0, segments.findIndex((seg) => seg.id === knot.parentShaftId));
                        let best = scoreBinding(activeSegment, activeEndpoints, currentIndex, segments.length, firstEndpoints.start, lastEndpoints.end);
                        let bestSegment = activeSegment;
                        let bestEndpoints = activeEndpoints;

                        for (let idx = 0; idx < segments.length; idx++) {
                            const candidateSeg = segments[idx];
                            const candidateEndpoints = resolveSegmentEndpoints(trunkRef.trunk, candidateSeg, idx, { root: trunkRef.root });
                            if (!candidateEndpoints) continue;

                            const candidate = scoreBinding(candidateSeg, candidateEndpoints, idx, segments.length, firstEndpoints.start, lastEndpoints.end);
                            if (candidate.score + 0.05 < best.score) {
                                best = candidate;
                                bestSegment = candidateSeg;
                                bestEndpoints = candidateEndpoints;
                            }
                        }

                        if (bestSegment.id !== knot.parentShaftId) {
                            activeSegment = bestSegment;
                            activeEndpoints = bestEndpoints;
                            nextParentShaftId = bestSegment.id;
                        }
                    }
                } else {
                    const branchRef = branchSegmentMap.get(knot.parentShaftId);
                    if (branchRef) {
                        const parentKnot = nextKnots[branchRef.branch.parentKnotId] ?? snapshot.knots[branchRef.branch.parentKnotId];
                        if (parentKnot) {
                            const segments = branchRef.branch.segments;
                            const firstSeg = segments[0];
                            const lastSeg = segments[segments.length - 1];
                            const firstEndpoints = firstSeg
                                ? resolveSegmentEndpoints(branchRef.branch, firstSeg, 0, { hostKnot: parentKnot })
                                : null;
                            const lastEndpoints = lastSeg
                                ? resolveSegmentEndpoints(branchRef.branch, lastSeg, segments.length - 1, { hostKnot: parentKnot })
                                : null;

                            if (segments.length > 0 && firstEndpoints && lastEndpoints) {
                                const currentIndex = Math.max(0, segments.findIndex((seg) => seg.id === knot.parentShaftId));
                                let best = scoreBinding(activeSegment, activeEndpoints, currentIndex, segments.length, firstEndpoints.start, lastEndpoints.end);
                                let bestSegment = activeSegment;
                                let bestEndpoints = activeEndpoints;

                                for (let idx = 0; idx < segments.length; idx++) {
                                    const candidateSeg = segments[idx];
                                    const candidateEndpoints = resolveSegmentEndpoints(branchRef.branch, candidateSeg, idx, { hostKnot: parentKnot });
                                    if (!candidateEndpoints) continue;

                                    const candidate = scoreBinding(candidateSeg, candidateEndpoints, idx, segments.length, firstEndpoints.start, lastEndpoints.end);
                                    if (candidate.score + 0.05 < best.score) {
                                        best = candidate;
                                        bestSegment = candidateSeg;
                                        bestEndpoints = candidateEndpoints;
                                    }
                                }

                                if (bestSegment.id !== knot.parentShaftId) {
                                    activeSegment = bestSegment;
                                    activeEndpoints = bestEndpoints;
                                    nextParentShaftId = bestSegment.id;
                                }
                            }
                        }
                    }
                }
            }

            const t = computeClosestTOnSegmentFromPoint(authoredPos, activeEndpoints.start, activeEndpoints.end, activeSegment);
            const computedPos = calculateKnotPositionOnSegmentFromT(activeEndpoints.start, activeEndpoints.end, activeSegment, t);
            const effectiveNormalizationHint = knot.normalizationHint ?? knot._importHint;

            const preserveImportedBraceUniformDiameter =
                braceHostKnotIds.has(knot.id)
                && effectiveNormalizationHint === 'braceImported'
                && Number.isFinite(knot.diameter as number);
            // A host type may size knots its own way -- twigs follow their taper
            // rather than the generic segment-diameter rule below.
            const shaftHost = shaftHostBySegmentId.get(nextParentShaftId);
            const twigKnotDiameter = shaftHost
                ? resolveKnotDiameter(shaftHost.typeId, shaftHost.entity, nextParentShaftId, t)
                : null;
            const computedDiameter = preserveImportedBraceUniformDiameter
                ? (knot.diameter as number)
                : twigKnotDiameter !== null
                    ? twigKnotDiameter
                    : activeSegment.diameter + JOINT_DIAMETER_OFFSET_MM;
            const parentShaftChanged = nextParentShaftId !== knot.parentShaftId;

            const dx = computedPos.x - authoredPos.x;
            const dy = computedPos.y - authoredPos.y;
            const dz = computedPos.z - authoredPos.z;
            const reprojectionDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const isEndpointProjection = t <= 1e-4 || t >= 1 - 1e-4;
            const isBaseEndpointProjection = t <= 1e-4;
            const isTipEndpointProjection = t >= 1 - 1e-4;
            const reprojectionDeltaZ = Math.abs(computedPos.z - authoredPos.z);

            // Import-hint fast path: converter has already determined preserve/project intent.
            // This takes priority over all derived preserve rules to avoid the two systems
            // making conflicting decisions (e.g. leaf s85 vs back leaves both look identical
            // to heuristic rules but require opposite treatment).
            const importHint = effectiveNormalizationHint;
            if (importHint === 'project') {
                const posChanged =
                    computedPos.x !== knot.pos.x ||
                    computedPos.y !== knot.pos.y ||
                    computedPos.z !== knot.pos.z;
                const tChanged = knot.t !== t;
                const diameterChanged = knot.diameter !== computedDiameter;
                if (posChanged || tChanged || diameterChanged || parentShaftChanged) {
                    nextKnots[knot.id] = { ...knot, parentShaftId: nextParentShaftId, t, pos: computedPos, diameter: computedDiameter };
                    if (posChanged) changedHostPosById[knot.id] = computedPos;
                    changedThisPass = true;
                }
                continue;
            }
            if (importHint === 'preserve') {
                const posChanged =
                    authoredPos.x !== knot.pos.x ||
                    authoredPos.y !== knot.pos.y ||
                    authoredPos.z !== knot.pos.z;
                const tChanged = knot.t !== t;
                const diameterChanged = knot.diameter !== computedDiameter;
                if (posChanged || tChanged || diameterChanged || parentShaftChanged) {
                    nextKnots[knot.id] = { ...knot, parentShaftId: nextParentShaftId, t, pos: authoredPos, diameter: computedDiameter };
                    if (posChanged) changedHostPosById[knot.id] = authoredPos;
                    changedThisPass = true;
                }
                continue;
            }

            // Imported formats (including LYS) may intentionally place brace endpoints beyond
            // host shaft bounds for visual span fidelity. For non-brace host knots, always project
            // to host geometry to keep imported branch/leaf linkage connected on load.
            const preserveAuthoredBracePos =
                braceHostKnotIds.has(knot.id) &&
                isEndpointProjection &&
                reprojectionDistance > 0.5;

            const isDescendantHostKnot = branchHostKnotIdsWithChildren.has(knot.id);
            const preserveAuthoredTerminalBranchHostPos =
                !braceHostKnotIds.has(knot.id) &&
                branchParentKnotIds.has(knot.id) &&
                !leafParentKnotIds.has(knot.id) &&
                !isDescendantHostKnot &&
                isEndpointProjection &&
                reprojectionDistance > 1.0;

            const preserveAuthoredTerminalLeafHostPos =
                !braceHostKnotIds.has(knot.id) &&
                leafParentKnotIds.has(knot.id) &&
                !branchParentKnotIds.has(knot.id) &&
                isEndpointProjection &&
                (
                    reprojectionDistance <= 0.5
                    || (isTipEndpointProjection && reprojectionDistance > 1.0)
                    || (isBaseEndpointProjection && reprojectionDeltaZ <= 0.5)
                );

            const preserveAuthoredEndpointPos =
                preserveAuthoredBracePos
                || preserveAuthoredTerminalBranchHostPos
                || preserveAuthoredTerminalLeafHostPos;

            if (preserveAuthoredEndpointPos) {
                const authoredPosChanged =
                    authoredPos.x !== knot.pos.x
                    || authoredPos.y !== knot.pos.y
                    || authoredPos.z !== knot.pos.z;
                const tChanged = knot.t !== t;
                const diameterChanged = knot.diameter !== computedDiameter;

                if (authoredPosChanged || tChanged || diameterChanged || parentShaftChanged) {
                    nextKnots[knot.id] = {
                        ...knot,
                        parentShaftId: nextParentShaftId,
                        t,
                        pos: authoredPos,
                        diameter: computedDiameter,
                    };
                    if (authoredPosChanged) {
                        changedHostPosById[knot.id] = authoredPos;
                    }
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
            if (!posChanged && !tChanged && !diameterChanged && !parentShaftChanged) continue;

            nextKnots[knot.id] = {
                ...knot,
                parentShaftId: nextParentShaftId,
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

    const settled = settleKnotDependentGeometry(snapshot.braces, nextLeaves, nextKnots);
    nextLeaves = settled.leaves;
    let finalKnots = settled.knots;

    // Strip transient import hints from final runtime output, but persist the resolved
    // normalization intent so VOXL save/load roundtrips can replay the same behavior.
    const hasAnyTransientImportHints = Object.values(finalKnots).some(k => k._importHint !== undefined);
    if (hasAnyTransientImportHints) {
        const stripped: Record<string, Knot> = {};
        for (const [id, k] of Object.entries(finalKnots)) {
            if (k._importHint !== undefined) {
                const { _importHint: transientImportHint, ...rest } = k;
                stripped[id] = {
                    ...rest,
                    normalizationHint: rest.normalizationHint ?? transientImportHint,
                };
            } else {
                stripped[id] = k;
            }
        }
        finalKnots = stripped;
    }

    return { knots: finalKnots, leaves: nextLeaves };
}

export function getChangedKnotPositions(prev: Record<string, Knot>, next: Record<string, Knot>): Record<string, Vec3> {
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

export function recomputeSpanHostKnotGeometry(
    braces: Record<string, Brace>,
    knots: Record<string, Knot>
): { knots: Record<string, Knot>; changed: boolean } {
    let changed = false;
    let nextKnots = knots;

    for (const knot of Object.values(knots)) {
        const host = parseKnotHostId(knot.parentShaftId);
        if (!host || !isSpanKnotHost(host.typeId)) continue;
        const brace = braces[host.entityId];
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

/**
 * Settle the geometry hanging off knots after something moved them.
 *
 * Three things chain: a moved knot reshapes its leaves, a reshaped leaf cone
 * moves the knots riding it, and a moved knot moves the knots on a brace
 * spanning it. The second pass runs only when the brace step moved something.
 */
function settleKnotDependentGeometry(
    braces: Record<string, Brace>,
    leaves: Record<string, Leaf>,
    knots: Record<string, Knot>,
): { knots: Record<string, Knot>; leaves: Record<string, Leaf> } {
    let nextLeaves = leaves;

    const coneHost1 = recomputeConeHostKnotGeometry(nextLeaves, knots);
    const spanHost1 = recomputeSpanHostKnotGeometry(braces, coneHost1.knots);

    const changedByBrace = getChangedKnotPositions(coneHost1.knots, spanHost1.knots);
    if (Object.keys(changedByBrace).length === 0) {
        return { knots: spanHost1.knots, leaves: nextLeaves };
    }

    nextLeaves = recomputeKnotDependentGeometry(nextLeaves, changedByBrace);
    const coneHost2 = recomputeConeHostKnotGeometry(nextLeaves, spanHost1.knots);
    const spanHost2 = recomputeSpanHostKnotGeometry(braces, coneHost2.knots);

    return { knots: spanHost2.knots, leaves: nextLeaves };
}


/** Remove one joint from a shafted entity, merging the segments it split. */
function removeShaftJoint<T extends SupportTypeId>(
    typeId: T,
    entityId: string,
    jointId: string,
): { before: SupportEntityFor<T>; after: SupportEntityFor<T> } | null {
    const entity = getSupportEntity(typeId, entityId) as { id: string; segments: Segment[]; contactCone?: { socketJointId?: string } } | null;
    if (!entity) return null;

    // Prevent deletion of the top joint that connects to the contact cone
    if (entity.contactCone?.socketJointId && entity.contactCone.socketJointId === jointId) {
        console.warn('Cannot delete the top joint that connects to the contact cone');
        return null;
    }

    const lowerIndex = resolveLowerSegmentIndex(entity.segments, jointId);
    if (lowerIndex === -1) return null;

    const before = deepClone(entity);
    const after = deepClone(entity);

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
        // The lower end the type declares: its own root, or a host knot.
        const hosts = resolveDeclaredHosts(typeId, entity as unknown as Record<string, unknown>);
        const anchored = hosts.root ?? hosts.hostKnot;
        const mergedSegmentId = after.segments[lowerIndex]?.id;
        const mergedSegment = after.segments[lowerIndex];

        if (anchored && mergedSegmentId && mergedSegment) {
            const endpoints = resolveSegmentEndpoints(after, mergedSegment, lowerIndex, hosts);
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
                    setState({ ...state, knots: updatedKnots });
                }
            }
        }
    }

    // Route through the generic update so ALL knots attached to this shaft stay connected after joint removal.
    applySupportEntityUpdate(after);

    return {
        before: before as SupportEntityFor<T>,
        after: deepClone(after) as SupportEntityFor<T>,
    };
}


/**
 * Which support lost a joint, and its before/after for the undo payload.
 *
 * One variant per type in `JOINT_REMOVAL_BY_TYPE`.
 */
export type RemoveJointByIdResult = {
    [T in JointRemovalTypeId]: {
        typeId: T;
        id: string;
        before: SupportEntityFor<T>;
        after: SupportEntityFor<T>;
    };
}[JointRemovalTypeId];

export function removeJointById(jointId: string): RemoveJointByIdResult | null {
    // Every type declaring joint removal, in registry order.
    for (const typeId of JOINT_REMOVAL_TYPES) {
        const collection = state[getSupportTypeDescriptor(typeId).location.key] as unknown as
            Record<string, { segments: Segment[] }>;
        for (const [entityId, entity] of Object.entries(collection ?? {})) {
            const hasJoint = entity.segments.some(
                (seg) => seg.topJoint?.id === jointId || seg.bottomJoint?.id === jointId,
            );
            if (!hasJoint) continue;
            const result = removeShaftJoint(typeId, entityId, jointId);
            if (result) return { typeId, id: entityId, ...result } as RemoveJointByIdResult;
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
    const next = createEmptySettingsHexCache();

    for (const descriptor of EDITABLE_SUPPORT_TYPES) {
        const bucket = next[descriptor.id];
        for (const entity of Object.values(state[descriptor.location.key])) {
            const { id, settingsCodeHex } = entity as { id: string; settingsCodeHex?: string };
            if (settingsCodeHex) bucket[id] = settingsCodeHex;
        }
    }

    supportSettingsHexCache = next;
}

function clearSupportSettingsHexCache() {
    supportSettingsHexCache = createEmptySettingsHexCache();
}

function getCachedSupportSettingsHex(kind: EditableSupportKind, id: string, entityHex?: string): string | null {
    const cached = supportSettingsHexCache[kind][id];
    if (cached) return cached;
    if (entityHex) {
        supportSettingsHexCache[kind][id] = entityHex;
        return entityHex;
    }
    return null;
}

function setCachedSupportSettingsHex(kind: EditableSupportKind, id: string, hex: string) {
    supportSettingsHexCache[kind][id] = hex;
}

function deleteCachedSupportSettingsHex(kind: EditableSupportKind, id: string) {
    delete supportSettingsHexCache[kind][id];
}

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSnapshot() {
    return state;
}

/**
 * Deep-copy a whole support state. Use this rather than `structuredClone`,
 * which drops the collection views because they are getters, not data.
 */
export function cloneSupportState(source: SupportState): SupportState {
    return normaliseSupportState(structuredClone({
        ...source,
        supports: source.supports ?? {},
    }) as SupportState);
}

/** Every support entity by id, whatever its type. */
export function getSupports(): Record<string, SupportEntityAny> {
    return state.supports ?? {};
}

export function reassignAllSupportModelIds(modelId: string): boolean {
    if (!modelId) return false;

    // Driven from SUPPORT_ENTITY_COLLECTIONS so a new type cannot be missed.
    const { collections, changed } = mapSupportEntities(state, (entity) => (
        entity.modelId === modelId ? entity : { ...entity, modelId }
    ));

    if (changed) {
        setState({ ...state, ...collections });
        notify();
    }

    const kickstandChanged = reassignAllKickstandModelIdsInState(modelId);
    return changed || kickstandChanged;
}


/**
 * Install each collection name as a view over `state.supports`. Enumerable, so
 * `{ ...state }` yields a snapshot rather than a live view.
 */
function installCollectionViews(next: SupportState): SupportState {
    for (const descriptor of SUPPORT_TYPES) {
        let cache: { from: Record<string, SupportEntityAny>; view: Record<string, SupportEntityAny> } | null = null;

        Object.defineProperty(next, descriptor.location.key, {
            configurable: true,
            enumerable: true,
            get(this: SupportState) {
                const all = this.supports ?? {};
                if (cache && cache.from === all) return cache.view;

                const view: Record<string, SupportEntityAny> = {};
                for (const id in all) {
                    if ((all[id] as { typeId?: SupportTypeId }).typeId === descriptor.id) view[id] = all[id];
                }

                cache = { from: all, view };
                return view;
            },
        });
    }
    return next;
}

/**
 * Normalise a state object into the stored shape: one `supports` map with the
 * eight names derived from it. Accepts either shape.
 */
function normaliseSupportState(next: SupportState): SupportState {
    const raw = next as unknown as Record<string, unknown>;

    // An own collection key means a writer set one explicitly, so it wins for
    // that type. Types without one keep whatever `supports` already held.
    const overrides = SUPPORT_TYPES.filter((d) => Object.prototype.hasOwnProperty.call(raw, d.location.key));

    // A write that only touched interaction state carries the previous views
    // unchanged, so `supports` is already correct. Rebuilding it would hand
    // every reader new collection objects and invalidate their memos.
    if (next.supports && overrides.length === SUPPORT_TYPES.length
        && overrides.every((d) => (raw[d.location.key] as object) === state?.[d.location.key])) {
        const carried: Record<string, unknown> = { ...raw };
        for (const descriptor of SUPPORT_TYPES) delete carried[descriptor.location.key];
        const kept = { ...carried, supports: next.supports } as unknown as SupportState;

        // Reuse the resolved views, so a reader memoised on `state.trunks`
        // does not rebuild for a hover.
        for (const descriptor of SUPPORT_TYPES) {
            Object.defineProperty(kept, descriptor.location.key, {
                configurable: true,
                enumerable: true,
                value: state[descriptor.location.key],
                writable: true,
            });
        }
        return kept;
    }

    const supports: Record<string, SupportEntityAny> = {};
    for (const [id, entity] of Object.entries(next.supports ?? {})) {
        const typeId = (entity as { typeId?: SupportTypeId }).typeId;
        if (overrides.some((d) => d.id === typeId)) continue;
        supports[id] = entity;
    }

    for (const descriptor of overrides) {
        for (const [id, entity] of Object.entries(raw[descriptor.location.key] as Record<string, SupportEntityAny>)) {
            // Already stamped entities pass through by reference; copying every
            // one on every write is what made a geometry write cost a frame.
            supports[id] = (entity as { typeId?: SupportTypeId }).typeId === descriptor.id
                ? entity
                : { ...entity, typeId: descriptor.id } as SupportEntityAny;
        }
    }

    const rest: Record<string, unknown> = { ...raw };
    for (const descriptor of SUPPORT_TYPES) delete rest[descriptor.location.key];

    return installCollectionViews({ ...rest, supports } as unknown as SupportState);
}

/** The only place `state` is assigned, so the derived views cannot be lost. */
function setState(next: SupportState): void {
    state = normaliseSupportState(next);
}

export function setSnapshot(next: SupportState) {
    state = normaliseSupportState(next);
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

/* --- Kickstands: a SupportState collection; their root and host knot live in
 * the shared `roots`/`knots`. --- */

/** Kickstand plus the root and host knot it owns, as callers still expect it. */
function buildKickstandResult(kickstand: Kickstand): KickstandBuildResult | null {
    const root = state.roots[kickstand.rootId];
    const hostKnot = state.knots[kickstand.hostKnotId];
    if (!root || !hostKnot) return null;
    return { kickstand, root, hostKnot };
}

function removeKickstandFromState(id: string): KickstandBuildResult | null {
    const kickstand = state.kickstands[id];
    if (!kickstand) return null;

    const result = buildKickstandResult(kickstand);
    if (!result) return null;

    const kickstands = { ...state.kickstands };
    delete kickstands[kickstand.id];
    const roots = { ...state.roots };
    delete roots[result.root.id];
    const knots = { ...state.knots };
    delete knots[result.hostKnot.id];

    setState({
        ...state,
        kickstands,
        roots,
        knots,
        selectedId: state.selectedId === id ? null : state.selectedId,
    });
    notify();

    return result;
}

export function resetKickstandsInState() {
    if (Object.keys(state.kickstands).length === 0) return;
    setState({ ...state, kickstands: {} });
    notify();
}

/**
 * Transform kickstands owned by `modelId`, plus any connected to a touched
 * entity: a kickstand can be grafted onto another model's support, and moving
 * that support has to carry the kickstand with it.
 */
/**
 * Transform kickstand SHAFTS only -- a kickstand grafted onto another model's
 * support moves with it. Roots and host knots are left to the main walk, which
 * already moves them; doing it here too applied the delta twice.
 */
function transformKickstandsForModelInState(
    modelId: string,
    deltaMatrix: THREE.Matrix4,
    touchedRootIds?: Set<string>,
    touchedKnotIds?: Set<string>,
    touchedSegmentIds?: Set<string>,
): boolean {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(deltaMatrix);

    let changed = false;
    let nextKickstands = state.kickstands;

    for (const kickstand of Object.values(state.kickstands)) {
        const isConnectedToTouchedGraph = !!(
            (touchedRootIds && touchedRootIds.has(kickstand.rootId))
            || (touchedKnotIds && touchedKnotIds.has(kickstand.hostKnotId))
            || (touchedSegmentIds && kickstand.segments.some((segment) => touchedSegmentIds.has(segment.id)))
        );

        if (kickstand.modelId !== modelId && !isConnectedToTouchedGraph) continue;

        if (!changed) {
            nextKickstands = { ...state.kickstands };
            changed = true;
        }

        nextKickstands[kickstand.id] = {
            ...kickstand,
            segments: kickstand.segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix)),
        };
    }

    if (!changed) return false;

    setState({ ...state, kickstands: nextKickstands });
    notify();
    return true;
}

function reassignAllKickstandModelIdsInState(modelId: string): boolean {
    if (!modelId) return false;

    let changed = false;
    let nextKickstands = state.kickstands;
    let nextRoots = state.roots;

    for (const kickstand of Object.values(state.kickstands)) {
        if (kickstand.modelId === modelId) continue;

        if (!changed) {
            nextKickstands = { ...state.kickstands };
            nextRoots = { ...state.roots };
            changed = true;
        }

        nextKickstands[kickstand.id] = { ...kickstand, modelId };

        const root = state.roots[kickstand.rootId];
        if (root && root.modelId !== modelId) {
            nextRoots[root.id] = { ...root, modelId };
        }
    }

    if (!changed) return false;

    setState({ ...state, kickstands: nextKickstands, roots: nextRoots });
    notify();
    return true;
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
    // Only the three collections computed here; the rest come from `nextByCollection`.
    let nextRoots = state.roots;
    let nextTrunks = state.trunks;
    let nextKnots = state.knots;

    const touchedRootIds = new Set<string>();
    const touchedSegmentIds = new Set<string>();
    const touchedJointIds = new Set<string>();
    const touchedKnotIds = new Set<string>();
    // Touched hosts of the pseudo-shafts a knot can ride, keyed by the prefix
    // each type declares.
    const touchedKnotHostIdsByPrefix = new Map<string, Set<string>>();
    for (const descriptor of SUPPORT_TYPES) {
        if (descriptor.knotHostPrefix) touchedKnotHostIdsByPrefix.set(descriptor.knotHostPrefix, new Set());
    }

    const segmentModelIdById = new Map<string, string | undefined>();
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;
        const collection = state[descriptor.location.key] as Record<string, { modelId: string; segments?: Segment[] }>;
        for (const entity of Object.values(collection)) {
            for (const segment of entity.segments ?? []) segmentModelIdById.set(segment.id, entity.modelId);
        }
    }

    const resolveModelIdFromParentShaft = (parentShaftId: string, visitedBraceIds?: Set<string>): string | undefined => {
        // A cone reaches its model through its host knot, a span through either
        // end, so the two kinds stay separate arms.
        const host = parseKnotHostId(parentShaftId);

        if (host && isConeKnotHost(host.typeId)) {
            const leaf = state.leaves[host.entityId];
            if (!leaf) return undefined;
            return leaf.modelId ?? resolveModelIdFromKnot(leaf.parentKnotId, visitedBraceIds);
        }

        if (host && isSpanKnotHost(host.typeId)) {
            const braceId = host.entityId;
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

    // Which entities the transform reaches. Two declared rules cover every
    // type: a knot-hosted type follows its host knot or that knot's shaft; a
    // self-contained one follows a joint it shares with a moved segment.
    const affectedByType = new Map<SupportTypeId, Set<string>>(
        SUPPORT_TYPES.map((descriptor) => [descriptor.id, new Set<string>()]),
    );

    /** Marks a shaft's segments and joints as moved, if the type propagates. */
    const claimShaft = (descriptor: SupportTypeDescriptor, entity: Record<string, unknown>) => {
        if (descriptor.hasSegments && descriptor.transformPropagatesToShaft) {
            for (const segment of (entity.segments ?? []) as Segment[]) {
                touchedSegmentIds.add(segment.id);
                if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
                if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
            }
        }
        for (const { field } of contactEndpointsFor(descriptor.id)) {
            const contact = entity[field] as { socketJointId?: string } | undefined;
            if (contact?.socketJointId) touchedJointIds.add(contact.socketJointId);
        }
    };

    let expandedGraph = true;
    while (expandedGraph) {
        expandedGraph = false;

        for (const descriptor of SUPPORT_TYPES) {
            // Trunks are seeded above; roots carry them.
            if (descriptor.ownsRoot) continue;

            const affected = affectedByType.get(descriptor.id)!;
            const knotFields = descriptor.edges
                .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
                .map((edge) => edge.field);

            const collection = state[descriptor.location.key] as unknown as Record<string, Record<string, unknown>>;
            for (const entity of Object.values(collection)) {
                const id = entity.id as string;
                if (affected.has(id)) continue;

                let connected = false;

                // Knot-hosted: the host knot, or the shaft that knot sits on.
                for (const field of knotFields) {
                    const knotId = entity[field];
                    if (typeof knotId !== 'string') continue;
                    if (touchedKnotIds.has(knotId)) { connected = true; break; }
                    const hostShaftId = state.knots[knotId]?.parentShaftId;
                    if (hostShaftId && touchedSegmentIds.has(hostShaftId)) { connected = true; break; }
                }

                // Self-contained: a joint shared with something already moved.
                if (!connected && knotFields.length === 0 && descriptor.hasSegments) {
                    connected = ((entity.segments ?? []) as Segment[]).some((segment) => (
                        (!!segment.bottomJoint?.id && touchedJointIds.has(segment.bottomJoint.id))
                        || (!!segment.topJoint?.id && touchedJointIds.has(segment.topJoint.id))
                    ));
                }

                const ownModelId = (entity.modelId as string | undefined)
                    ?? knotFields.reduce<string | undefined>(
                        (found, field) => found ?? (typeof entity[field] === 'string'
                            ? resolveModelIdFromKnot(entity[field] as string)
                            : undefined),
                        undefined,
                    );

                if (ownModelId !== modelId && !connected) continue;

                affected.add(id);
                for (const field of knotFields) {
                    const knotId = entity[field];
                    if (typeof knotId === 'string') touchedKnotIds.add(knotId);
                }
                if (descriptor.knotHostPrefix) {
                    touchedKnotHostIdsByPrefix.get(descriptor.knotHostPrefix)!.add(id);
                    // A brace's span is itself addressed as a segment; a leaf's
                    // cone is not, so only a shaftless host claims one.
                    if (!descriptor.hasSegments && descriptor.segmentSelectionPrefix) {
                        touchedSegmentIds.add(`${descriptor.segmentSelectionPrefix}${id}`);
                    }
                }
                claimShaft(descriptor, entity);
                expandedGraph = true;
            }
        }
    }

    // What moves is declared: segments and contactFields, plus whatever
    // SUPPORT_TRANSFORM_EXTRAS names (a brace curve, a stump's own root).
    const nextByCollection: Partial<Record<SupportCollectionKey, Record<string, unknown>>> = {};

    for (const descriptor of SUPPORT_TYPES) {
        // A root-owning type is transformed above, alongside the root it owns.
        if (descriptor.ownsRoot) continue;

        const collection = descriptor.location.key;
        const source = state[collection] as unknown as Record<string, Record<string, unknown>>;
        const ids = affectedByType.get(descriptor.id) ?? new Set<string>();

        for (const id of ids) {
            const entity = source[id];
            if (!entity) continue;

            if (!changed) changed = true;
            const target = nextByCollection[collection] ?? { ...source };
            nextByCollection[collection] = target;

            const next: Record<string, unknown> = { ...entity };


            if (descriptor.hasSegments) {
                const segments = (entity.segments ?? []) as Segment[];
                if (descriptor.transformPropagatesToShaft) {
                    for (const segment of segments) {
                        touchedSegmentIds.add(segment.id);
                        if (segment.bottomJoint?.id) touchedJointIds.add(segment.bottomJoint.id);
                        if (segment.topJoint?.id) touchedJointIds.add(segment.topJoint.id);
                    }
                }
                next.segments = segments.map((segment) => transformSegment(segment, deltaMatrix, normalMatrix));
            }

            for (const { kind, field } of contactEndpointsFor(descriptor.id)) {
                const contact = entity[field] as { socketJointId?: string } | undefined;
                if (!contact) continue;
                if (contact.socketJointId) touchedJointIds.add(contact.socketJointId);
                next[field] = kind === 'disk'
                    ? transformContactDisk(contact as never, deltaMatrix, normalMatrix)
                    : transformContactCone(contact as never, deltaMatrix, normalMatrix);
            }

            for (const field of transformExtrasFor(descriptor.id)) {
                const value = entity[field];
                if (!value) continue;
                next[field] = field === 'curve'
                    ? {
                        ...(value as BraceCurve),
                        controlPoint1: transformVec3((value as BraceCurve).controlPoint1, deltaMatrix),
                        controlPoint2: transformVec3((value as BraceCurve).controlPoint2, deltaMatrix),
                        startTangent: transformDirection((value as BraceCurve).startTangent, normalMatrix),
                        endTangent: transformDirection((value as BraceCurve).endTangent, normalMatrix),
                    }
                    : field === 'joint'
                        ? { ...(value as Joint), pos: transformVec3((value as Joint).pos, deltaMatrix) }
                        : transformVec3(value as Vec3, deltaMatrix);
            }

            target[id] = next;
        }
    }


    for (const knot of Object.values(state.knots)) {
        const parentShaftId = knot.parentShaftId;
        let ridesTouchedHost = false;
        for (const [prefix, touchedHostIds] of touchedKnotHostIdsByPrefix) {
            if (!parentShaftId.startsWith(prefix)) continue;
            ridesTouchedHost = touchedHostIds.has(parentShaftId.slice(prefix.length));
            break;
        }
        const shouldTransform = touchedKnotIds.has(knot.id)
            || touchedSegmentIds.has(parentShaftId)
            || ridesTouchedHost;

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
        // One entry per collection the loop touched; the rest carry through.
        const nextCollections: Record<string, unknown> = {};
        for (const descriptor of SUPPORT_TYPES) {
            const key = descriptor.location.key;
            nextCollections[key] = nextByCollection[key] ?? state[key];
        }
        // The three this function computes itself win over the generic pass.
        nextCollections.roots = nextRoots;
        nextCollections.trunks = nextTrunks;
        nextCollections.knots = nextKnots;

        setState({ ...state, ...nextCollections } as SupportState);
        notify();
    }

    const kickstandsChanged = transformKickstandsForModelInState(
        modelId,
        deltaMatrix,
        touchedRootIds,
        touchedKnotIds,
        touchedSegmentIds,
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

    // One walk over SUPPORT_ENTITY_COLLECTIONS: a shaft if the type has one,
    // each declared contact, plus whatever `transformExtrasFor` names. `roots`
    // stays its own arm, being no support type, and keeps its Z on a translation.
    const { collections: transformed } = mapSupportEntities(state, (entity, collection) => {
        if (collection === 'roots') {
            const root = entity as unknown as Roots;
            return {
                ...root,
                transform: {
                    ...root.transform,
                    pos: preserveRootZ
                        ? transformVec3PreserveZ(root.transform.pos, deltaMatrix)
                        : transformVec3(root.transform.pos, deltaMatrix),
                },
            } as unknown as typeof entity;
        }

        const typeId = typeIdForCollection(collection);
        const descriptor = getSupportTypeDescriptor(typeId);
        const record = entity as unknown as Record<string, unknown>;
        let next: Record<string, unknown> | null = null;

        if (descriptor.hasSegments) {
            next = { ...record };
            next.segments = ((record.segments ?? []) as Segment[])
                .map((segment) => transformSegment(segment, deltaMatrix, normalMatrix));
        }

        for (const { kind, field } of contactEndpointsFor(typeId)) {
            const contact = record[field];
            if (!contact) continue;
            if (!next) next = { ...record };
            next[field] = kind === 'disk'
                ? transformContactDisk(contact as never, deltaMatrix, normalMatrix)
                : transformContactCone(contact as never, deltaMatrix, normalMatrix);
        }

        for (const field of transformExtrasFor(typeId)) {
            const value = record[field];
            if (!value) continue;
            if (!next) next = { ...record };
            next[field] = field === 'curve'
                ? {
                    ...(value as BraceCurve),
                    controlPoint1: transformVec3((value as BraceCurve).controlPoint1, deltaMatrix),
                    controlPoint2: transformVec3((value as BraceCurve).controlPoint2, deltaMatrix),
                    startTangent: transformDirection((value as BraceCurve).startTangent, normalMatrix),
                    endTangent: transformDirection((value as BraceCurve).endTangent, normalMatrix),
                }
                : field === 'joint'
                    ? { ...(value as Joint), pos: transformVec3((value as Joint).pos, deltaMatrix) }
                    : transformVec3(value as Vec3, deltaMatrix);
        }

        // An entity no declared field reaches is returned as-is, minting no copy.
        return (next ?? record) as unknown as typeof entity;
    });

    const nextKnots: Record<string, Knot> = {};
    for (const knot of Object.values(state.knots)) {
        nextKnots[knot.id] = {
            ...knot,
            pos: transformVec3(knot.pos, deltaMatrix),
        };
    }

    // Read before `setState` replaces `state`.
    const kickstandsChanged = transformed.kickstands !== state.kickstands;

    setState({
        ...state,
        ...transformed,
        knots: nextKnots,
    });
    notify();

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

    setState({
        ...state,
        roots: nextRoots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    });
    notify();
    return deepClone(root);
}

// --- Actions ---

export function toggleSegmentCurve(segmentId: string) {
    // A span-hosted knot has no segments: its span's ends are the declared knots.
    const span = parsePrefixedSegmentId(segmentId);
    if (span) {
        const spanDescriptor = getSupportTypeDescriptor(span.typeId);
        const spans = state[spanDescriptor.location.key] as unknown as
            Record<string, Record<string, unknown> & { curve?: BraceCurve } | undefined>;
        const spanEntity = spans[span.entityId];
        if (!spanEntity) return;

        const [startField, endField] = hostKnotFieldsFor(span.typeId);
        const startKnot = state.knots[spanEntity[startField] as string];
        const endKnot = state.knots[spanEntity[endField] as string];
        if (!startKnot || !endKnot) return;

        const newSpan = deepClone(spanEntity);
        if (newSpan.curve?.type === 'bezier') {
            delete newSpan.curve;
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

            newSpan.curve = {
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

        updateSupportEntity(span.typeId, newSpan);
        return;
    }

    // `findShaftOwnerOfSegment` walks every type declaring segments.
    const owner = findShaftOwnerOfSegment(segmentId);
    if (!owner) return;
    const entity = getSupportEntity(owner.typeId, owner.id) as unknown as ShaftEntity | null;
    if (!entity?.segments) return;

    const segmentIndex = entity.segments.findIndex((candidate) => candidate.id === segmentId);
    if (segmentIndex === -1) return;

    const next = deepClone(entity);
    const segment = next.segments[segmentIndex];

    if (segment.type === 'bezier') {
        // Convert to straight: identical for every type.
        const straight: StraightSegment = {
            id: segment.id,
            diameter: segment.diameter,
            topJoint: segment.topJoint,
            bottomJoint: segment.bottomJoint,
            type: 'straight',
        };
        next.segments[segmentIndex] = straight;
    } else {
        // The shaft's ends, from the type's declared lower and upper endpoints.
        const endpoints = resolveSegmentEndpoints(
            entity,
            segment,
            segmentIndex,
            resolveDeclaredHosts(owner.typeId, entity as unknown as Record<string, unknown>),
        );
        if (!endpoints) return;

        const dir = toVector3(endpoints.end).sub(toVector3(endpoints.start)).normalize();
        if (dir.lengthSq() === 0) dir.set(0, 0, 1);

        const startTangent = toVec3(dir);
        const endTangent = toVec3(dir);
        const [cp1, cp2] = calculateBezierControlPoints(
            endpoints.start,
            endpoints.end,
            startTangent,
            endTangent,
            0.5,
        );

        const bezier: BezierSegment = {
            id: segment.id,
            diameter: segment.diameter,
            topJoint: segment.topJoint,
            bottomJoint: segment.bottomJoint,
            type: 'bezier',
            controlPoint1: cp1,
            controlPoint2: cp2,
            startTangent,
            endTangent,
            tension: 0.5,
            bias: 0.5,
            resolution: 16,
        };
        next.segments[segmentIndex] = bezier;
    }

    updateSupportEntity(owner.typeId, next);
}

export function resetStore() {
    setState({ ...initialState });
    clearSupportSettingsHexCache();
    emitSupportInteractionReset('resetStore');
    notify();
}

/**
 * Loads support data from the DragonFruit import format into the support store,
 * replacing all existing support data.
 */
/** Carry the pre-`generatedBy` flag across on read, for older scenes. */
function migrateLegacyGeneratedBy(kickstand: Kickstand): Kickstand {
    if (kickstand.generatedBy || !kickstand.autoBracingGenerated) return kickstand;
    return { ...kickstand, generatedBy: 'autoBracing' };
}

export function loadFromImportFormat(data: DragonfruitImportFormat) {
    const importDefaults = getSavedImportDefaultsSettings();
    const effectiveData = applyImportDefaultsToSupportPayload(migrateLegacySupportPayload(data), importDefaults);

    const newState: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        selectedCategory: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };

    // Populate Roots
    effectiveData.roots.forEach(r => {
        newState.roots[r.id] = r;
    });

    // Every declared type, from the array its collection is named after.
    // `typeId` is stamped here: a file written before the field existed has it
    // derived from the array it came out of, which is the only place that
    // information survives in an older payload.
    for (const descriptor of SUPPORT_TYPES) {
        const key = descriptor.location.key;
        // A bundled type is written as { entity, root, hostKnot } under this
        // same key rather than as a bare entity, so it is unwrapped below.
        if (descriptor.serialisedAsBundle) continue;
        const incoming = (effectiveData as unknown as Record<string, { id: string }[] | undefined>)[key];
        for (const entity of incoming ?? []) {
            (newState[key] as Record<string, unknown>)[entity.id] = { ...entity, typeId: descriptor.id };
        }
    }

    // Populate Knots
    if (effectiveData.knots) {
        effectiveData.knots.forEach(k => {
            newState.knots[k.id] = k;
        });
    }

    // Written into newState directly rather than via addKickstand: kickstands are
    // a SupportState collection now, and addKickstand would mutate `state` only
    // for `state = newState` below to discard it.
    for (const build of effectiveData.kickstands ?? []) {
        newState.kickstands[build.kickstand.id] = { ...migrateLegacyGeneratedBy(build.kickstand), typeId: bundledSupportTypeId() };
        newState.roots[build.root.id] = build.root;
        newState.knots[build.hostKnot.id] = build.hostKnot;
    }

    const normalized = normalizeLoadedKnotAndLeafGeometry(newState);
    newState.knots = normalized.knots;
    newState.leaves = normalized.leaves;

    setState(newState);
    rebuildSupportSettingsHexCacheFromState();
    emitSupportInteractionReset('loadFromImportFormat');
    console.log('[SupportStore] Loaded from LYS:', Object.fromEntries(
        SUPPORT_COLLECTION_KEYS.map((key) => [key, Object.keys(state[key] ?? {}).length]),
    ));
    notify();
}

function getOrCreateMappedId(sourceId: string, idMap: Map<string, string>): string {
    const mapped = idMap.get(sourceId);
    if (mapped) return mapped;
    const created = uuidv4();
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

    // A knot's parentShaftId names either a pseudo-shaft (prefix + entity id)
    // or a real segment; both follow from the host type.
    const hostIdMapByType = new Map<SupportTypeId, Map<string, string>>();
    for (const typeId of CONE_KNOT_HOST_TYPES) hostIdMapByType.set(typeId, leafIdMap);
    for (const typeId of SPAN_KNOT_HOST_TYPES) hostIdMapByType.set(typeId, braceIdMap);

    const remapParentShaftId = (parentShaftId: string): string => {
        const host = parseKnotHostId(parentShaftId);
        const hostIdMap = host && hostIdMapByType.get(host.typeId);
        if (!host || !hostIdMap) return getOrCreateMappedId(parentShaftId, segmentIdMap);
        return knotHostId(host.typeId, getOrCreateMappedId(host.entityId, hostIdMap));
    };

    const kickstandRootIdMap = new Map<string, string>();
    const kickstandKnotIdMap = new Map<string, string>();

    cloned.knots.forEach((knot) => {
        knotIdMap.set(knot.id, uuidv4());
    });

    cloned.roots = cloned.roots.map((root) => {
        const nextId = uuidv4();
        rootIdMap.set(root.id, nextId);
        return {
            ...root,
            id: nextId,
        };
    });

    cloned.trunks = cloned.trunks.map((trunk) => {
        const nextSegments = trunk.segments.map((segment) => {
            const nextSegmentId = uuidv4();
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
            id: uuidv4(),
            rootId: getOrCreateMappedId(trunk.rootId, rootIdMap),
            segments: nextSegments,
            contactCone: trunk.contactCone
                ? {
                    ...trunk.contactCone,
                    id: uuidv4(),
                    socketJointId: trunk.contactCone.socketJointId
                        ? getOrCreateMappedId(trunk.contactCone.socketJointId, jointIdMap)
                        : trunk.contactCone.socketJointId,
                }
                : trunk.contactCone,
        };
    });

    cloned.branches = cloned.branches.map((branch) => {
        const nextSegments = branch.segments.map((segment) => {
            const nextSegmentId = uuidv4();
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
            id: uuidv4(),
            parentKnotId: getOrCreateMappedId(branch.parentKnotId, knotIdMap),
            segments: nextSegments,
            contactCone: branch.contactCone
                ? {
                    ...branch.contactCone,
                    id: uuidv4(),
                    socketJointId: branch.contactCone.socketJointId
                        ? getOrCreateMappedId(branch.contactCone.socketJointId, jointIdMap)
                        : branch.contactCone.socketJointId,
                }
                : branch.contactCone,
        };
    });

    cloned.leaves = cloned.leaves.map((leaf) => {
        const nextId = uuidv4();
        leafIdMap.set(leaf.id, nextId);
        return {
            ...leaf,
            id: nextId,
            parentKnotId: getOrCreateMappedId(leaf.parentKnotId, knotIdMap),
            contactCone: {
                ...leaf.contactCone,
                id: uuidv4(),
                socketJointId: leaf.contactCone.socketJointId
                    ? getOrCreateMappedId(leaf.contactCone.socketJointId, jointIdMap)
                    : leaf.contactCone.socketJointId,
            },
        };
    });

    cloned.twigs = (cloned.twigs ?? []).map((twig) => {
        const nextSegments = twig.segments.map((segment) => {
            const nextSegmentId = uuidv4();
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
            id: uuidv4(),
            segments: nextSegments,
            contactDiskA: {
                ...twig.contactDiskA,
                id: uuidv4(),
            },
            contactDiskB: {
                ...twig.contactDiskB,
                id: uuidv4(),
            },
        };
    });

    cloned.sticks = (cloned.sticks ?? []).map((stick) => {
        const nextSegments = stick.segments.map((segment) => {
            const nextSegmentId = uuidv4();
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
            id: uuidv4(),
            segments: nextSegments,
            contactConeA: {
                ...stick.contactConeA,
                id: uuidv4(),
                socketJointId: stick.contactConeA.socketJointId
                    ? getOrCreateMappedId(stick.contactConeA.socketJointId, jointIdMap)
                    : stick.contactConeA.socketJointId,
            },
            contactConeB: {
                ...stick.contactConeB,
                id: uuidv4(),
                socketJointId: stick.contactConeB.socketJointId
                    ? getOrCreateMappedId(stick.contactConeB.socketJointId, jointIdMap)
                    : stick.contactConeB.socketJointId,
            },
        };
    });

    cloned.braces = cloned.braces.map((brace) => {
        const nextId = uuidv4();
        braceIdMap.set(brace.id, nextId);
        return {
            ...brace,
            id: nextId,
            startKnotId: getOrCreateMappedId(brace.startKnotId, knotIdMap),
            endKnotId: getOrCreateMappedId(brace.endKnotId, knotIdMap),
        };
    });

    // Kickstands are remapped before knots: a knot hosted on a kickstand segment
    // resolves its parentShaftId through segmentIdMap, and getOrCreateMappedId
    // mints a fresh id for anything not yet registered. Remapping knots first
    // left those knots pointing at ids nothing else would ever use.
    cloned.kickstands = (cloned.kickstands ?? []).map((build) => {
        const nextRootId = uuidv4();
        kickstandRootIdMap.set(build.root.id, nextRootId);

        const nextHostKnotId = uuidv4();
        kickstandKnotIdMap.set(build.hostKnot.id, nextHostKnotId);

        const nextKickstandSegments = build.kickstand.segments.map((segment) => {
            const nextSegmentId = uuidv4();
            segmentIdMap.set(segment.id, nextSegmentId);
            return {
                ...segment,
                id: nextSegmentId,
                topJoint: remapSupportJoint(segment.topJoint, jointIdMap),
                bottomJoint: remapSupportJoint(segment.bottomJoint, jointIdMap),
            };
        });

        const hostParentShaftId = remapParentShaftId(build.hostKnot.parentShaftId);

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
                id: uuidv4(),
                rootId: getOrCreateMappedId(build.kickstand.rootId, kickstandRootIdMap),
                hostKnotId: getOrCreateMappedId(build.kickstand.hostKnotId, kickstandKnotIdMap),
                hostSegmentId: getOrCreateMappedId(build.kickstand.hostSegmentId, segmentIdMap),
                segments: nextKickstandSegments,
            },
        } as KickstandBuildResult;
    });

    cloned.knots = cloned.knots.map((knot) => {
        const parentShaftId = remapParentShaftId(knot.parentShaftId);

        return {
            ...knot,
            id: getOrCreateMappedId(knot.id, knotIdMap),
            parentShaftId,
        };
    });

    return cloned;
}

/**
 * Merges support data from the DragonFruit import format into the existing scene state,
 * preserving supports for all models already in the scene.
 * Use this when importing an additional scene file into an already-populated scene.
 */
/**
 * Stamp `modelId` onto every support entity in an imported payload.
 *
 * Kickstands carry theirs on the nested build result, so every collection is
 * walked; a type missed here stays bound to whatever the plugin wrote.
 */
function reconcileSupportModelIds(
    data: DragonfruitImportFormat,
    ownerModelId: string,
): DragonfruitImportFormat {
    const mismatched = new Set<string>();
    const stamp = <T extends { modelId?: string }>(entity: T): T => {
        if (entity.modelId && entity.modelId !== ownerModelId) mismatched.add(entity.modelId);
        return entity.modelId === ownerModelId ? entity : { ...entity, modelId: ownerModelId };
    };
    // Kickstands are nested (kickstands[].kickstand / .root) rather than a flat
    // collection, so they are stamped separately from the descriptor-driven walk.
    const next: DragonfruitImportFormat = {
        ...mapImportPayloadEntities(data, stamp),
        kickstands: data.kickstands?.map((build) => ({
            ...build,
            kickstand: stamp(build.kickstand),
            root: stamp(build.root),
        })),
    };

    if (mismatched.size > 0) {
        console.warn(
            '[SupportStore] Imported supports carried a modelId that does not match the model '
            + 'they were imported with; reconciling to the host model id. This indicates a plugin '
            + 'returning a payload modelId that differs from the id stamped on its supports.',
            { ownerModelId, foundModelIds: [...mismatched] },
        );
    }

    return next;
}

/**
 * Merge an imported support payload into the store.
 *
 * `ownerModelId` binds every support in `data` to that model, so the
 * association comes from the host rather than whatever the plugin stamped.
 * Mismatches are logged rather than accepted, surfacing a plugin bug.
 */
export function mergeFromImportFormat(data: DragonfruitImportFormat, ownerModelId?: string) {
    const importDefaults = getSavedImportDefaultsSettings();
    const reconciled = ownerModelId ? reconcileSupportModelIds(data, ownerModelId) : data;
    const effectiveData = applyImportDefaultsToSupportPayload(migrateLegacySupportPayload(reconciled), importDefaults);
    const isolated = isolateImportedSupportPayload(effectiveData);

    // A copy-on-write shell of every declared collection.
    const merged: SupportState = {
        ...state,
        ...Object.fromEntries(SUPPORT_COLLECTION_KEYS.map((key) => [key, { ...state[key] }])),
    } as SupportState;

    isolated.roots.forEach(r => { merged.roots[r.id] = r; });
    if (isolated.knots) { isolated.knots.forEach(k => { merged.knots[k.id] = k; }); }

    // Every declared type, stamped with `typeId` as loadFromImportFormat does.
    // The geometry pass below reads these arrays before the derived views stamp them.
    for (const descriptor of SUPPORT_TYPES) {
        const key = descriptor.location.key;
        const collection = merged[key] as unknown as Record<string, unknown>;

        if (descriptor.serialisedAsBundle) {
            // Into `merged` directly: `state = merged` below would discard other writes.
            const bundles = (isolated[key] ?? []) as unknown as KickstandBuildResult[];
            for (const build of bundles) {
                collection[build.kickstand.id] = { ...migrateLegacyGeneratedBy(build.kickstand), typeId: descriptor.id };
                merged.roots[build.root.id] = build.root;
                merged.knots[build.hostKnot.id] = build.hostKnot;
            }
            continue;
        }

        const incoming = (isolated as unknown as Record<string, { id: string }[] | undefined>)[key];
        for (const entity of incoming ?? []) {
            collection[entity.id] = { ...entity, typeId: descriptor.id };
        }
    }

    const normalized = normalizeLoadedKnotAndLeafGeometry(merged);
    merged.knots = normalized.knots;
    merged.leaves = normalized.leaves;

    setState(merged);
    rebuildSupportSettingsHexCacheFromState();
    emitSupportInteractionReset('mergeFromImportFormat');
    console.log('[SupportStore] Merged from LYS:', Object.fromEntries(
        SUPPORT_COLLECTION_KEYS.map((key) => [key, Object.keys(merged[key]).length]),
    ));
    notify();
}

export function setSelectedId(id: string | null) {
    if (state.selectedId === id) return;
    const category: SelectionCategory = id ? resolveSelectionCategory(id) : null;

    setState({ ...state, selectedId: id, selectedCategory: category });
    notify();
}


export function setHoveredState(
    category: 'model' | 'support' | 'contactDisk' | 'segment' | 'joint' | 'knot' | 'raft' | 'gizmo' | 'none',
    id: string | null,
) {
    if (state.hoveredCategory === category && state.hoveredId === id) return;
    setState({ ...state, hoveredCategory: category, hoveredId: id });
    notify();
}

export function setInteractionWarning(warning: import('./types').WarningCode | null) {
    if (state.interactionWarning === warning) return;
    setState({ ...state, interactionWarning: warning });
    notify();
}

export function addRoot(root: Roots) {
    setState({
        ...state,
        roots: { ...state.roots, [root.id]: root }
    });
    notify();
}

/**
 * Write an entity into its collection, evicting nothing and cascading nothing.
 *
 * The per-type `addX` functions below are thin wrappers: identical apart from
 * which collection they write and whether the type caches a settings hex, both
 * of which the registry declares.
 */
/**
 * Add one entity to the collection its type declares.
 *
 * Two forms: `addSupportEntity(entity)` reads the type off the entity and is
 * preferred; `(typeId, entity)` is for a caller with no stamped entity yet.
 * Roots and host knots are added as ordinary entities, not bundled.
 */
export function addSupportEntity<E extends { typeId?: SupportTypeId; id: string; settingsCodeHex?: string }>(entity: E): void;
export function addSupportEntity<E extends { id: string; settingsCodeHex?: string }>(typeId: SupportTypeId, entity: E): void;
export function addSupportEntity(
    typeIdOrEntity: SupportTypeId | { typeId?: SupportTypeId; id: string; settingsCodeHex?: string },
    maybeEntity?: { id: string; settingsCodeHex?: string },
): void {
    const entity = typeof typeIdOrEntity === 'string' ? maybeEntity : typeIdOrEntity;
    const typeId = typeof typeIdOrEntity === 'string'
        ? typeIdOrEntity
        : resolveSupportTypeIdOf(typeIdOrEntity);
    if (!typeId || !entity) {
        throw new Error(`addSupportEntity: entity ${entity?.id ?? '?'} carries no type and none was given`);
    }

    const descriptor = getSupportTypeDescriptor(typeId);
    if (descriptor.hasEditableSettings && entity.settingsCodeHex) {
        setCachedSupportSettingsHex(typeId, entity.id, entity.settingsCodeHex);
    }

    const key = descriptor.location.key;
    setState({
        ...state,
        [key]: { ...state[key], [entity.id]: { ...entity, typeId } },
    });
    notify();
}

/**
 * Adds an entity and records its undo entry, both keyed on the type: the
 * descriptor names the adder, the action and the payload key.
 *
 * `extras` carries the repair an add has to record so undo can put the scene
 * back: the knot a member hangs from, and the re-solved host the placement
 * changed. Those field names are the same ones every type's add payload already
 * declares, so a caller supplies them without naming the type.
 */
export function addSupportEntityWithHistory(
    typeId: SupportTypeId,
    entity: { id: string; settingsCodeHex?: string },
    extras?: Record<string, unknown>,
) {
    addSupportEntity(typeId, entity);
    // The declared `self` field is the key that type's add payload carries,
    // but it is computed here, so the compiler cannot match it to the union.
    pushSupportHistory({
        type: getSupportTypeDescriptor(typeId).historyAdd,
        payload: { [removalShapeFor(typeId).self]: entity, ...extras },
    } as unknown as Parameters<typeof pushSupportHistory>[0]);
}

/**
 * Where a knot sitting on this entity's shaft belongs after the entity moved.
 *
 * The one part of an update that genuinely differs per type, and it follows the
 * declared lower endpoint: a `plateRoot` type resolves segment ends against its
 * root, a `knot` type against its host knot, and a self-contained shaft reads
 * the joints straight off the segment.
 *
 * Returns null to leave the knot alone.
 */
type KnotPlacementOnShaft = (
    entity: { id: string; segments?: Segment[] },
    knot: Knot,
    segment: Segment,
    segmentIndex: number,
) => { pos: Vec3; diameter?: number } | null;

/** Renders the knot at the joint diameter; the legacy 0.1 sat inside the shaft. */
const KNOT_JOINT_DIAMETER_BUMP_MM = 0.125;

const KNOT_PLACEMENT_BY_TYPE = new Map<SupportTypeId, KnotPlacementOnShaft>();

/** The rule placing a knot on this type's shaft, if it registers one. */
export function getKnotPlacementOnShaft(typeId: SupportTypeId): KnotPlacementOnShaft | null {
    return KNOT_PLACEMENT_BY_TYPE.get(typeId) ?? null;
}

/**
 * Apply an entity to its collection, then reposition the knots riding its
 * shafts and recompute the geometry those knots carry.
 */
function applySupportEntityUpdate(entity: { id: string; typeId?: SupportTypeId; settingsCodeHex?: string; segments?: Segment[] }): void;
function applySupportEntityUpdate(
    typeId: SupportTypeId,
    entity: { id: string; settingsCodeHex?: string; segments?: Segment[] },
): void;
function applySupportEntityUpdate(
    typeIdOrEntity: SupportTypeId | { id: string; typeId?: SupportTypeId; settingsCodeHex?: string; segments?: Segment[] },
    maybeEntity?: { id: string; settingsCodeHex?: string; segments?: Segment[] },
): void {
    const typeId = typeof typeIdOrEntity === 'string'
        ? typeIdOrEntity
        : resolveSupportTypeIdOf(typeIdOrEntity);
    const entity = (typeof typeIdOrEntity === 'string' ? maybeEntity : typeIdOrEntity)!;
    if (!typeId) return;
    const descriptor = getSupportTypeDescriptor(typeId);
    const key = descriptor.location.key;

    if (!state[key][entity.id]) return;

    let next = entity;
    if (descriptor.hasEditableSettings) {
        const cachedHex = getCachedSupportSettingsHex(typeId, entity.id, entity.settingsCodeHex ?? undefined);
        if (!entity.settingsCodeHex && cachedHex) next = { ...entity, settingsCodeHex: cachedHex };
        if (next.settingsCodeHex) setCachedSupportSettingsHex(typeId, next.id, next.settingsCodeHex);
    }

    const nextCollection = { ...state[key], [next.id]: { ...next, typeId } };

    const place = KNOT_PLACEMENT_BY_TYPE.get(typeId);
    let nextKnots = state.knots;
    let nextLeaves = state.leaves;

    if (place && next.segments) {
        const updatedKnots: Record<string, Knot> = { ...state.knots };
        const movedKnotPosById: Record<string, Vec3> = {};
        let knotsChanged = false;

        for (const knot of Object.values(state.knots)) {
            const segmentIndex = next.segments.findIndex((s) => s.id === knot.parentShaftId);
            if (segmentIndex === -1) continue;

            const placed = place(next, knot, next.segments[segmentIndex], segmentIndex);
            if (!placed) continue;

            const posChanged = placed.pos.x !== knot.pos.x
                || placed.pos.y !== knot.pos.y
                || placed.pos.z !== knot.pos.z;
            const diameterChanged = placed.diameter !== undefined && placed.diameter !== knot.diameter;
            if (!posChanged && !diameterChanged) continue;

            updatedKnots[knot.id] = {
                ...knot,
                pos: posChanged ? placed.pos : knot.pos,
                ...(placed.diameter !== undefined ? { diameter: placed.diameter } : {}),
            };
            knotsChanged = true;
            if (posChanged) movedKnotPosById[knot.id] = placed.pos;
        }

        if (knotsChanged) {
            nextLeaves = recomputeKnotDependentGeometry(state.leaves, movedKnotPosById);
            const coneHost = recomputeConeHostKnotGeometry(nextLeaves, updatedKnots);
            const spanHost = recomputeSpanHostKnotGeometry(state.braces, coneHost.knots);
            nextKnots = spanHost.knots;
        }
    }

    // What else this type touches, in the order it needs. A type with no
    // registered cascade settles to nothing.
    const settle = supportSettleFor(typeId);
    const settled = settle ? settle({
        next: { ...state, [key]: nextCollection, knots: nextKnots, leaves: nextLeaves },
    }) : null;

    setState({
        ...state,
        // Defaults first, then the entity's own collection, so a type whose
        // collection is one of the defaults writes the post-write one.
        knots: nextKnots,
        leaves: nextLeaves,
        [key]: nextCollection,
        ...(settled ?? {}),
    });
    notify();
}

/**
 * Overwrite an existing entity in place, no-op if the id is unknown.
 *
 * Only for a plain write. A shafted type goes through `applySupportEntityUpdate`
 * instead, which also repositions the knots riding its segments. The settings
 * applier wants exactly this: it has moved the root already, and the knot pass
 * would settle the geometry twice.
 */
function replaceSupportEntity(
    typeId: SupportTypeId,
    entity: { id: string },
): boolean {
    const key = getSupportTypeDescriptor(typeId).location.key;
    if (!state[key][entity.id]) return false;

    setState({
        ...state,
        [key]: { ...state[key], [entity.id]: { ...entity, typeId } },
    });
    notify();
    return true;
}

/**
 * Where a knot rides a shaft: interpolate along the segment its `t` names.
 *
 * The ends come from the declared endpoints, so a plate-rooted shaft measures
 * from its root and a knot-hosted one from its host without either being named
 * here. Two rules stay per type, both trunk's:
 *
 * - the knot renders at the joint diameter, not the shaft's, or it is invisible;
 * - a knot carrying no `t` (auto merge and fan knots do not) is projected onto
 *   the possibly-moved segment, so a leaf follows the shaft on a joint drag.
 */
for (const descriptor of SUPPORT_TYPES) {
    if (!descriptor.hasSegments) continue;

    KNOT_PLACEMENT_BY_TYPE.set(descriptor.id, (entity, knot, segment, segmentIndex) => {
        // Both hosts come off the declared edges: a kickstand's knot is at its
        // upper end, so `lower.kind` would find none.
        const hosts = resolveDeclaredHosts(descriptor.id, entity as Record<string, unknown>);

        // A type declaring a host it was handed none of cannot place anything.
        if (descriptor.lower.kind === 'plateRoot' && !hosts.root) return null;
        if (descriptor.lower.kind === 'knot' && !hosts.hostKnot) return null;

        const diameter = descriptor.knotTakesJointDiameter
            ? segment.diameter + KNOT_JOINT_DIAMETER_BUMP_MM
            : undefined;

        const endpoints = resolveSegmentEndpoints(entity as ShaftEntity, segment, segmentIndex, hosts);
        if (!endpoints) return diameter === undefined ? null : { pos: knot.pos, diameter };

        const t = knot.t !== undefined
            ? knot.t
            : (descriptor.projectsUnparameterisedKnots
                ? computeClosestTOnSegmentFromPoint(knot.pos, endpoints.start, endpoints.end, segment)
                : undefined);
        if (t === undefined) return null;

        const pos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, t);
        return diameter === undefined ? { pos } : { pos, diameter };
    });
}


/**
 * @deprecated for removal -- prefer `updateSupportEntity('branch', entity)`.
 * Kept for `SupportTypes/Branch/`, which may name its own type, and for tests.
 */

export function addKnot(knot: Knot) {
    setState({
        ...state,
        knots: { ...state.knots, [knot.id]: knot }
    });
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

    setState({
        ...state,
        knots: nextKnots,
        selectedId: nextSelectedId,
        selectedCategory: nextSelectedCategory,
    });
    notify();
    return deepClone(knot);
}

export function updateKnot(knot: Knot, options?: { skipDependentGeometry?: boolean }) {
    const skipDependentGeometry = options?.skipDependentGeometry === true;
    const existing = state.knots[knot.id];
    if (!existing) return;

    const baseKnots = { ...state.knots, [knot.id]: knot };

    if (skipDependentGeometry) {
        // Drag-time fast path: keep knot + brace-segment knots responsive while
        // deferring expensive leaf-dependent geometry recomputes until commit.
        const spanHost = recomputeSpanHostKnotGeometry(state.braces, baseKnots);
        setState({ ...state, knots: spanHost.knots });
        notify();
        return;
    }

    const settled = settleKnotDependentGeometry(
        state.braces,
        recomputeKnotDependentGeometry(state.leaves, { [knot.id]: knot.pos }),
        baseKnots,
    );

    setState({ ...state, knots: settled.knots, leaves: settled.leaves });
    notify();
}


// --- Selectors / Hooks Helpers ---


/**
 * The root and host knot an entity's declared endpoints resolve from. Absent
 * when it has no edge of that kind, or the id it names is not in the store.
 */
export function resolveDeclaredHosts(
    typeId: SupportTypeId,
    entity: Record<string, unknown>,
): { root?: Roots; hostKnot?: Knot } {
    const descriptor = getSupportTypeDescriptor(typeId);
    const fieldOf = (to: 'roots' | 'knots', ownership: 'owns' | 'hostedBy') =>
        descriptor.edges.find((edge) => edge.to === to && edge.ownership === ownership)?.field;
    const rootId = entity[fieldOf('roots', 'owns') ?? ''];
    const knotId = entity[fieldOf('knots', 'hostedBy') ?? ''];

    return {
        root: typeof rootId === 'string' ? state.roots[rootId] : undefined,
        hostKnot: typeof knotId === 'string' ? state.knots[knotId] : undefined,
    };
}

/** Every entity of one type. */
export function getSupportEntities<T = unknown>(typeId: SupportTypeId): T[] {
    const { key } = getSupportTypeDescriptor(typeId).location;
    return Object.values(state[key]) as T[];
}


/**
 * The primitives a type's entities reference, keyed by id.
 *
 * Which fields point where is declared as the type's `edges`, so a caller asks
 * for "the roots kickstands own" without knowing the field name. For a consumer
 * that needs one type's primitives apart from every other type's -- note that
 * they are NOT a separate collection, so a caller already walking `roots` has
 * them and must not add them again.
 */
export function getOwnedPrimitives<T = unknown>(
    typeId: SupportTypeId,
    collection: SupportCollectionKey,
): Record<string, T> {
    const descriptor = getSupportTypeDescriptor(typeId);
    const fields = descriptor.edges
        .filter((edge) => edge.to === collection)
        .map((edge) => edge.field);
    if (fields.length === 0) return {};

    const source = state[collection] as unknown as Record<string, T>;
    const owned: Record<string, T> = {};
    for (const entity of Object.values(state[descriptor.location.key]) as Record<string, unknown>[]) {
        for (const field of fields) {
            const id = entity[field];
            if (typeof id !== 'string') continue;
            const found = source[id];
            if (found !== undefined) owned[id] = found;
        }
    }
    return owned;
}

/**
 * Owned-primitive views, cached by snapshot identity.
 *
 * `useSyncExternalStore` compares by reference, so returning a fresh object per
 * call would re-render forever. Rebuilt only when the snapshot changes.
 */
const ownedPrimitiveCache = new Map<string, { source: SupportState; view: Record<string, unknown> }>();

function cachedOwnedPrimitives<T>(
    typeId: SupportTypeId,
    collection: SupportCollectionKey,
): Record<string, T> {
    const key = `${typeId}:${collection}`;
    const hit = ownedPrimitiveCache.get(key);
    if (hit && hit.source === state) return hit.view as Record<string, T>;
    const view = getOwnedPrimitives<T>(typeId, collection);
    ownedPrimitiveCache.set(key, { source: state, view: view as Record<string, unknown> });
    return view;
}

/** The roots kickstands own. */
export function getKickstandRoots(): Record<string, Roots> {
    return cachedOwnedPrimitives<Roots>(bundledSupportTypeId(), 'roots');
}

/** The knots kickstands host. */
export function getKickstandKnots(): Record<string, Knot> {
    return cachedOwnedPrimitives<Knot>(bundledSupportTypeId(), 'knots');
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

    const span = parsePrefixedSegmentId(id);
    if (span) {
        return (state.braces[span.entityId] as { modelId?: string } | undefined)?.modelId ?? null;
    }

    const modelIdOf = (entity: unknown) => (entity as { modelId?: string } | undefined)?.modelId ?? null;

    // Direct hit on any modelId-bearing collection.
    for (const key of MODEL_ID_COLLECTION_KEYS) {
        const entity = state[key][id];
        if (entity) return modelIdOf(entity);
    }

    // One pass over every support, asking each what it is. Segments and edges
    // are matched in the same pass because they take disjoint id kinds -- a
    // segment or joint id, versus
    // the knot id an edge points at -- so no id can satisfy both.
    for (const entity of Object.values(getSupports())) {
        const typeId = (entity as { typeId?: SupportTypeId }).typeId;
        if (!typeId) continue;
        const descriptor = getSupportTypeDescriptor(typeId);

        // A primitive on a shaft: segment, or either of its joints.
        if (descriptor.hasSegments) {
            const segments = (entity as { segments?: Segment[] }).segments ?? [];
            if (segments.some((segment) =>
                segment.id === id || segment.topJoint?.id === id || segment.bottomJoint?.id === id)) {
                return modelIdOf(entity);
            }
        }

        // Or the entity points at the id through one of its declared edges.
        const fields = entity as unknown as Record<string, unknown>;
        if (descriptor.edges.some((edge) => edge.to === 'knots' && fields[edge.field] === id)) {
            return modelIdOf(entity);
        }
    }

    // A knot resolves from its host shaft.
    const knot = state.knots[id];
    if (knot?.parentShaftId) return getModelIdForSupportEntityId(knot.parentShaftId);

    return null;
}

/**
 * One entity by id. `getSupportEntity(id)` resolves the type from the store and
 * is preferred; `(typeId, id)` is generic on the id, so it comes back narrowed
 * with no cast. Null for an unknown id, or one whose type cannot be resolved.
 */
export function getSupportEntity(id: string): SupportEntityAny | null;
export function getSupportEntity<T extends SupportTypeId>(typeId: T, id: string): SupportEntityFor<T> | null;
export function getSupportEntity(
    // `string`, not `SupportTypeId`: the one-argument form takes any entity id.
    typeIdOrId: string,
    maybeId?: string,
): SupportEntityAny | null {
    // One argument means the id alone.
    if (maybeId === undefined) {
        const resolved = getSupportTypeOf(typeIdOrId);
        if (!resolved) return null;
        return getSupportEntity(resolved, typeIdOrId);
    }
    const { key } = getSupportTypeDescriptor(typeIdOrId as SupportTypeId).location;
    // The store's value type is the union of every entity; the overloads narrow it.
    return (state[key] as Record<string, SupportEntityAny>)[maybeId] ?? null;
}

/**
 * What type of support an id names, or null if it names none.
 *
 * Reads the entity's own `typeId` rather than asking which collection holds it.
 */
export function getSupportTypeOf(id: string): SupportTypeId | null {
    if (!id) return null;

    const entity = getSupports()[id] as { typeId?: SupportTypeId } | undefined;
    if (entity?.typeId) return entity.typeId;
    if (!entity) return null;

    // In the store but unstamped: a whole-store payload restored through
    // `setSnapshot` bypasses the writers that stamp. Fall back to the
    // collection holding it.
    for (const descriptor of SUPPORT_TYPES) {
        if ((state[descriptor.location.key] as Record<string, unknown>)[id]) return descriptor.id;
    }
    return null;
}


/** Which support owns a shaft segment, searching every shafted type. */
export function findShaftOwnerOfSegment(
    segmentId: string,
): { typeId: SupportTypeId; id: string } | null {
    // A type whose segments are selected under a prefix names its owner in the
    // id itself, so there is nothing to scan for.
    const prefixed = parsePrefixedSegmentId(segmentId);
    if (prefixed) {
        return getSupportEntity(prefixed.typeId, prefixed.entityId)
            ? { typeId: prefixed.typeId, id: prefixed.entityId }
            : null;
    }

    for (const entity of Object.values(getSupports()) as { id: string; segments?: Segment[] }[]) {
        if (entity.segments?.some((segment) => segment.id === segmentId)) {
            const typeId = getSupportTypeOf(entity.id);
            if (typeId) return { typeId, id: entity.id };
        }
    }
    return null;
}

/** Where a joint sits within a segment list, or null if it is not there. */
export function jointPosIn(segments: readonly Segment[], jointId: string): Vec3 | null {
    for (const segment of segments) {
        if (segment.topJoint?.id === jointId) return segment.topJoint.pos;
        if (segment.bottomJoint?.id === jointId) return segment.bottomJoint.pos;
    }
    return null;
}

/** Which support owns a joint, searching every shafted type. */
export function findShaftOwnerOfJoint(
    jointId: string,
): { typeId: SupportTypeId; id: string; pos: Vec3 } | null {
    for (const entity of Object.values(getSupports()) as { id: string; segments?: Segment[] }[]) {
        const pos = jointPosIn(entity.segments ?? [], jointId);
        if (!pos) continue;
        const typeId = getSupportTypeOf(entity.id);
        if (typeId) return { typeId, id: entity.id, pos };
    }
    return null;
}

export function getRootById(rootId: string) {
    return state.roots[rootId] ?? null;
}

/**
 * A type whose entities have editable settings.
 *
 * Widened to SupportTypeId rather than listing the three: which types are
 * editable is `hasEditableSettings`, and the runtime already reads it. Narrowing
 * this by hand would be a second source of truth.
 */
export type EditableSupportKind = SupportTypeId;

export type EditableSupportTarget = {
    kind: EditableSupportKind;
    id: string;
};

/**
 * Settings read back off an entity using only what its descriptor declares:
 * the first `contactFields` cone for the tip, the owned root for the roots, and
 * segment 0 for the shaft. Each half is skipped when the type declares nothing.
 */
function inferSettingsFromDescriptor(
    descriptor: SupportTypeDescriptor,
    entity: SupportEntityAny,
    base?: SupportSettings,
): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const record = entity as unknown as Record<string, unknown>;

    const cone = descriptor.contactFields
        .map((field) => record[field] as { profile?: SupportTipProfile } | undefined)
        .find(Boolean);
    const coneProfile = cone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;

    const segments = (record.segments as Segment[] | undefined) ?? [];
    const shaftDiameter = (record.baseDiameterMm as number | undefined)
        ?? segments[0]?.diameter
        ?? merged.shaft.diameterMm;

    const root = descriptor.ownsRoot
        ? state.roots[(record.rootId as string | undefined) ?? ''] ?? null
        : null;

    return {
        ...merged,
        tip: coneProfile
            ? {
                ...merged.tip,
                contactDiameterMm: coneProfile.contactDiameterMm ?? merged.tip.contactDiameterMm,
                bodyDiameterMm: coneProfile.bodyDiameterMm ?? merged.tip.bodyDiameterMm,
                lengthMm: coneProfile.lengthMm ?? merged.tip.lengthMm,
                penetrationMm: coneProfile.penetrationMm ?? merged.tip.penetrationMm,
                diskThicknessMm: diskConeProfile?.diskThicknessMm ?? merged.tip.diskThicknessMm,
                maxStandoffMm: diskConeProfile?.maxStandoffMm ?? merged.tip.maxStandoffMm,
                standoffAngleThreshold: diskConeProfile?.standoffAngleThreshold ?? merged.tip.standoffAngleThreshold,
            }
            : merged.tip,
        shaft: descriptor.hasSegments
            ? { ...merged.shaft, diameterMm: shaftDiameter, secondaryDiameterMm: shaftDiameter }
            : merged.shaft,
        roots: root
            ? {
                ...merged.roots,
                diameterMm: root.diameter ?? merged.roots.diameterMm,
                diskHeightMm: root.diskHeight ?? merged.roots.diskHeightMm,
                coneHeightMm: root.coneHeight ?? merged.roots.coneHeightMm,
            }
            : merged.roots,
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

    if (selectedCategory && isEditableSupportType(selectedCategory)) {
        return { kind: selectedCategory as EditableSupportKind, id: selectedId };
    }

    /** The editable entity owning `matches`, in registry order. */
    const findOwner = (
        matches: (entity: Record<string, unknown>, descriptor: SupportTypeDescriptor) => boolean,
    ): EditableSupportTarget | null => {
        for (const descriptor of EDITABLE_SUPPORT_TYPES) {
            for (const entity of Object.values(state[descriptor.location.key])) {
                if (matches(entity as unknown as Record<string, unknown>, descriptor)) {
                    return { kind: descriptor.id, id: (entity as { id: string }).id };
                }
            }
        }
        return null;
    };

    const segmentsOf = (entity: Record<string, unknown>) => (entity.segments as Segment[] | undefined) ?? [];
    const contactOf = (entity: Record<string, unknown>, descriptor: SupportTypeDescriptor) =>
        descriptor.contactFields
            .map((field) => entity[field] as { id?: string; socketJointId?: string } | undefined)
            .filter(Boolean);

    if (selectedCategory === 'root') {
        // A type owning a `Roots` row matches by id; one declaring an inline
        // root carries the geometry itself, so its primitive id names the entity.
        const inlineOwner = parseInlineRootId(selectedId);
        return findOwner((entity, descriptor) =>
            entity.rootId === selectedId
            || (descriptor.lower.kind === 'inlineRoot' && entity.id === inlineOwner));
    }

    if (selectedCategory === 'segment') {
        return findOwner((entity) => segmentsOf(entity).some((segment) => segment.id === selectedId));
    }

    if (selectedCategory === 'joint') {
        return findOwner((entity, descriptor) =>
            segmentsOf(entity).some((segment) =>
                segment.topJoint?.id === selectedId || segment.bottomJoint?.id === selectedId)
            || contactOf(entity, descriptor).some((contact) => contact?.socketJointId === selectedId));
    }

    if (selectedCategory === 'contactDisk') {
        return findOwner((entity, descriptor) =>
            contactOf(entity, descriptor).some((contact) => contact?.id === selectedId));
    }

    if (selectedCategory === 'knot') {
        const knot = state.knots[selectedId];
        if (!knot) return null;

        // A cone-knot host encodes its owner in the shaft id -- both the type
        // and the id -- so the collection to look in comes from it too.
        const coneHost = parseKnotHostId(knot.parentShaftId);
        if (coneHost && isConeKnotHost(coneHost.typeId)) {
            const ownerCollection = state[getSupportTypeDescriptor(coneHost.typeId).location.key] as
                Record<string, unknown> | undefined;
            if (ownerCollection?.[coneHost.entityId]) {
                return { kind: coneHost.typeId, id: coneHost.entityId };
            }
        }

        return findOwner((entity) =>
            segmentsOf(entity).some((segment) => segment.id === knot.parentShaftId)
            || entity.parentKnotId === selectedId);
    }

    return null;
}

export function getSupportSettingsForTarget(target: EditableSupportTarget, base?: SupportSettings): SupportSettings | null {
    const descriptor = getSupportTypeDescriptor(target.kind);
    const entity = state[descriptor.location.key][target.id] as { settingsCodeHex?: string } | undefined;
    if (!entity) return null;

    const encoded = getCachedSupportSettingsHex(target.kind, target.id, entity.settingsCodeHex);
    const decoded = encoded ? decodeSupportSettingsHex(encoded, base) : null;
    logSupportSettingsDebug('read target', target, {
        hasHex: Boolean(encoded),
        hexPreview: encoded?.slice(0, 18),
        decodeOk: Boolean(decoded),
        source: decoded ? 'hex' : 'inferred',
    });

    return decoded ?? inferSupportSettings<SupportSettings>(target.kind, entity, base);
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

/**
 * Write settings onto whichever support the sidebar is editing.
 *
 * One path for every editable type: a type owning a root rewrites it, a type
 * with segments resizes them, and a type without one has no shaft-to-tip
 * transition so the tip's body and length do not apply.
 */
export function applySettingsToSupportTarget(target: EditableSupportTarget, settings: SupportSettings): boolean {
    logSupportSettingsDebug('apply start', target);

    const descriptor = SUPPORT_TYPES.find((d) => d.id === target.kind);
    if (!descriptor?.hasEditableSettings) return false;

    const collection = state[descriptor.location.key] as Record<string, unknown>;
    const entity = collection[target.id] as {
        id: string;
        segments?: Segment[];
        contactCone?: Trunk['contactCone'];
        rootId?: string;
        settingsCodeHex?: string;
    } | undefined;
    if (!entity) return false;

    const root = descriptor.ownsRoot ? state.roots[entity.rootId ?? ''] : null;
    if (descriptor.ownsRoot && !root) return false;

    const nextContactCone = entity.contactCone
        ? {
            ...entity.contactCone,
            profile: applyTipSettingsToConeProfile(
                entity.contactCone.profile,
                settings.tip,
                { includeBodyAndLength: descriptor.hasSegments },
            ),
        }
        : entity.contactCone;

    const nextHex = encodeSupportSettingsHex(settings);
    const next: Record<string, unknown> = { ...entity, settingsCodeHex: nextHex, contactCone: nextContactCone };

    if (descriptor.hasSegments) {
        const socketPos = nextContactCone ? getFinalSocketPosition(nextContactCone) : undefined;
        next.segments = updateSegmentDiametersAndJoints(
            entity.segments ?? [],
            settings.shaft.diameterMm,
            nextContactCone?.socketJointId,
            socketPos,
        );
    }
    // Only a root-owning type records its shaft width on the entity.
    if (descriptor.ownsRoot) next.baseDiameterMm = settings.shaft.diameterMm;

    // An inline root is geometry on the entity, so the same settings land on the
    // fields it declares rather than on a shared `Roots` row.
    if (descriptor.lower.kind === 'inlineRoot') {
        const { radiusField, topRadiusField, heightField } = descriptor.lower;
        if (radiusField) next[radiusField] = settings.roots.diameterMm;
        if (topRadiusField) next[topRadiusField] = settings.roots.neckDiameterMm;
        if (heightField) next[heightField] = settings.roots.coneHeightMm;
    }

    setCachedSupportSettingsHex(descriptor.id, entity.id, nextHex);

    logSupportSettingsDebug(`apply ${descriptor.id} hex`, {
        target,
        prevHex: entity.settingsCodeHex?.slice(0, 18),
        nextHex: nextHex.slice(0, 18),
    });

    if (root) {
        const nextRoot: Roots = {
            ...root,
            diameter: settings.roots.diameterMm,
            diskHeight: settings.roots.diskHeightMm,
            coneHeight: settings.roots.coneHeightMm,
        };
        setState({ ...state, roots: { ...state.roots, [nextRoot.id]: nextRoot } });
    }

    replaceSupportEntity(descriptor.id, next as never);
    logSupportSettingsDebug('apply done', target);
    return true;
}


// Per-type registrations live in each type's folder; importing them here runs
// their side effects once the store exists. The list is GENERATED from those
// folders (scripts/generate-support-registrations.mjs) rather than written out,
// so a new type's registration loads because the folder exists -- and the
// export seam's completeness check in `exportGeometry/seam.ts` then finds it.
import './generatedSupportRegistrations';

/* --- Updater registration ------------------------------------------------
 * Every type updates through `applySupportEntityUpdate`. A type needing more
 * registers its own from its folder, and the pass below fills only the slots
 * left empty.
 *
 * Must run after `generatedSupportRegistrations` above, or the generic updater
 * claims every slot and the bespoke ones never take effect.
 * ---------------------------------------------------------------------- */
for (const descriptor of SUPPORT_TYPES) {
    if (hasSupportUpdater(descriptor.id)) continue;
    registerSupportUpdater(
        descriptor.id,
        (entity: { id: string }) => applySupportEntityUpdate(descriptor.id, entity),
    );
}

// The registry's `updateSupportEntity(entity)` form reads the type off the
// entity, and needs this only for one that lost it on the way in. A slot for
// the same cycle reason as the updaters above.
registerSupportTypeResolver(getSupportTypeOf);

// Generic inference for every editable type that registered none of its own.
// What it reads is declared: `contactFields` for the tip, `ownsRoot` for the
// root, and the shaft from segment 0. A type wanting more registers its own.
for (const descriptor of EDITABLE_SUPPORT_TYPES) {
    if (hasSettingsInference(descriptor.id)) continue;
    registerSettingsInference<SupportEntityAny, SupportSettings, SupportSettings>(
        descriptor.id,
        (entity, base) => inferSettingsFromDescriptor(descriptor, entity, base),
    );
}


// How each collection puts an entity back, for undo. Every type goes through
// the generic adder; only the two primitives have their own.
for (const descriptor of SUPPORT_TYPES) {
    registerCollectionRestore(descriptor.location.key, (entity) => {
        // History payloads written before kickstands were flattened still carry
        // a { kickstand, root, hostKnot } build. Unwrap it rather than break
        // undo of an entry already on the stack.
        const build = entity as Partial<KickstandBuildResult>;
        if (build.kickstand) {
            if (build.root) addRoot(build.root);
            if (build.hostKnot) addKnot(build.hostKnot);
            addSupportEntity(descriptor.id, build.kickstand);
            return;
        }
        addSupportEntity(descriptor.id, entity as { id: string });
    });
}
registerCollectionRestore('roots', (entity) => addRoot(entity as Roots));
registerCollectionRestore('knots', (entity) => addKnot(entity as Knot));

const missingRestore = collectionsMissingRestore();
if (missingRestore.length > 0) {
    throw new Error(`No restore registered for: ${missingRestore.join(', ')}`);
}

// Every type exports geometry, so a missing export group builder means a
// registration module did not load -- which would otherwise surface as a type
// silently missing from every exported mesh. Same check, same place, as the
// restore registrations above: fail at load, not at export.
const missingExportGroups = typesMissingExportGroupBuilder();
if (missingExportGroups.length > 0) {
    throw new Error(`No export group builder registered for: ${missingExportGroups.join(', ')}`);
}

// A type that declares it can be replaced by a higher candidate must register
// the code that does it. Without this the flag would be a lie that only shows up
// as a promotion silently failing mid-run -- exactly the drift that made
// SUPPORT_KINDS untrustworthy, where flags had no implementation to check.
const missingPromotions = typesMissingHostPromotion();
if (missingPromotions.length > 0) {
    throw new Error(`Declares replacedByHigherContact but registered no promotion: ${missingPromotions.join(', ')}`);
}

// The joint-drag path pushes a type's own typed history action when it owns its
// entry. A type declaring the flag without the action would push nothing, so the
// drag would leave no undo entry and no error.
const missingHistoryUpdate = typesDeclaringOwnHistoryEntryWithoutUpdate();
if (missingHistoryUpdate.length > 0) {
    throw new Error(`Declares ownsEditHistoryEntry but no historyUpdate: ${missingHistoryUpdate.join(', ')}`);
}

// Same again for the auto-placement override: a type that claims a tip-height
// band would be SELECTED by the engine, so it must be buildable. Without this
// the engine picks a type it has no way to construct.
const missingAutoPlacement = typesMissingContactOverride();
if (missingAutoPlacement.length > 0) {
    throw new Error(`Claims a tipHeight band but registered no auto-placement builder: ${missingAutoPlacement.join(', ')}`);
}
