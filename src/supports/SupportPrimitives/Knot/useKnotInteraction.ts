import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { findShaftOwnerOfSegment, getSnapshot, getSupportEntity, getSupportEntities, getKnotById, getRootById, setInteractionWarning, updateKnot, subscribe } from '../../state';
import { Anchor, Branch, Brace, Knot, Leaf, Roots, Segment, Trunk, Twig, Stick, Vec3 } from '../../types';
import { resolveSegmentEndpoints, type EndpointHosts } from './segmentEndpoints';
import { SUPPORT_COLLECTION_KEYS, getSupportTypeDescriptor, updateSupportEntity, type SupportEdge } from '../../supportTypeRegistry';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { projectOntoSegment, shouldStayOnCurrentSegment } from './knotUtils';
import { getSettings } from '../../Settings/state';
import { solveKnotConstraint } from '../../PlacementLogic/JointConstraintSolver';
import { ElasticChainInitialState, ElasticChainResult, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getFinalSocketPosition, getSocketPosition } from '../ContactCone';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getBezierPointAtT } from '../../Curves/BezierUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearKnotDragPreview, emitKnotDragPreview } from '../../interaction/knotDragPreview';
import { resolveTwigDiameterAtSegmentT } from '../../SupportTypes/Twig/twigTaper';
import { resolveKnotDiameter, SUPPORT_TYPES, type SupportTypeId } from '../../supportTypeRegistry';
import { shouldCommitJointDrag } from '../Joint/jointDragController';
import { knotMoveDescription, type KnotHostType } from './knotUtils';


/**
 * Whether the host carries real segments a knot slides along. A pseudo-shaft
 * host declares `knotHostPrefix` -- a leaf's cone, a brace's span -- and
 * resolves its endpoints from the entity instead.
 */
function hostsRealSegments(containerType: KnotHostType): boolean {
    if (containerType === 'leafCone') return false;
    return !getSupportTypeDescriptor(containerType).knotHostPrefix;
}

/** Whether a knot on this host takes its diameter from the shaft it rides. */
function takesShaftDiameter(containerType: KnotHostType): boolean {
    return containerType !== 'leafCone';
}

/** What a knot is riding: one entity, its type, and the hosts its ends need. */
interface ActiveHost {
    segmentId: string;
    containerType: KnotHostType;
    /** The support the knot rides. Absent only for a leaf cone. */
    entity?: { id: string; segments?: Segment[] };
    /** The root and host knot the entity's declared endpoints resolve from. */
    hosts: EndpointHosts;
    leafId?: string;
    start: THREE.Vector3;
    end: THREE.Vector3;
    // Topology Map: BranchID -> 'UP' (Knot Z < Joint Z) or 'DOWN' (Knot Z > Joint Z)
    initialTopology: Record<string, 'UP' | 'DOWN'>;
}

export type SupportGeometryToken = Record<string, unknown>;

/** Identity of every collection the host lookup and the elastic capture read. */
export function captureSupportGeometryToken(): SupportGeometryToken {
    const snapshot = getSnapshot();
    const token: SupportGeometryToken = {};
    for (const key of SUPPORT_COLLECTION_KEYS) token[key] = snapshot[key];
    return token;
}

export function isSameSupportGeometry(a: SupportGeometryToken | null, b: SupportGeometryToken): boolean {
    if (!a) return false;
    return Object.keys(b).every((key) => a[key] === b[key]);
}

export function useKnotInteraction(enabled: boolean = true) {
    const MIN_DRAG_DELTA_SQ = 1e-6; // ~0.001mm epsilon to drop high-frequency jitter churn
    const BEZIER_PROJECTION_STEPS = 36;
    const FAST_KNOT_DRAG_ELASTIC_PREVIEW = true;
    const DRAG_SNAP_MM = 0.001;

    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer } = useThree();

    const activeKnotId = useRef<string | null>(null);
    /** Where the knot sat when the drag began, to tell a drag from a click. */
    const dragStartKnotPos = useRef<Vec3 | null>(null);
    const activeHost = useRef<ActiveHost | null>(null);
    const forceEndDragRef = useRef(false);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);

    const leafClampWarningTimeout = useRef<number | null>(null);

    // Store initial state of all attached branches for elastic drag
    const elasticState = useRef<Record<string, ElasticChainInitialState>>({});
    const prewarmedKnotIdRef = useRef<string | null>(null);
    const prewarmedHostRef = useRef<ActiveHost | null>(null);
    const prewarmedElasticStateRef = useRef<Record<string, ElasticChainInitialState> | null>(null);
    // The geometry the prewarm was taken from. The prewarmed host endpoints and
    // elastic capture are a photo of support geometry: any edit in between (a tip
    // drag rebuilding a branch, an undo, a deletion) makes them stale, and
    // replaying a stale capture drags the chain back to the geometry it
    // snapshotted. Hover and selection rewrite the store too, so the token holds
    // the geometry collections rather than the whole snapshot — otherwise every
    // hover would throw the prewarm away.
    const prewarmedGeometryRef = useRef<SupportGeometryToken | null>(null);
    const lastAppliedKnotPosRef = useRef<THREE.Vector3 | null>(null);
    const previewBranchSegmentsByIdRef = useRef<Record<string, Branch['segments']>>({});
    const previewKnotRef = useRef<Knot | null>(null);
    const lastEmittedKnotPreviewPosRef = useRef<{ x: number; y: number; z: number } | null>(null);
    const lastEmittedBranchPreviewRef = useRef<Record<string, Branch['segments']> | null>(null);
    const knotDragUpdatePendingRef = useRef(false);
    const knotDragListenersAttachedRef = useRef(false);

    const setKnotDragInteractionLock = useCallback((isDragging: boolean, postGuardMs = 180) => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        w.__knotGizmoDragging = isDragging;
        w.__knotGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

        window.dispatchEvent(new CustomEvent('knot-gizmo-interaction-lock', {
            detail: {
                active: isDragging,
                guardUntil: w.__knotGizmoGuardUntil,
            },
        }));
    }, []);

    useEffect(() => {
        return () => {
            setKnotDragInteractionLock(false, 0);
            clearKnotDragPreview();
        };
    }, [setKnotDragInteractionLock]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const markForceEndDrag = () => {
            if (!activeKnotId.current) return;
            forceEndDragRef.current = true;
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                markForceEndDrag();
            }
        };

        window.addEventListener('pointerup', markForceEndDrag, true);
        window.addEventListener('pointercancel', markForceEndDrag, true);
        window.addEventListener('mouseup', markForceEndDrag, true);
        window.addEventListener('blur', markForceEndDrag);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('pointerup', markForceEndDrag, true);
            window.removeEventListener('pointercancel', markForceEndDrag, true);
            window.removeEventListener('mouseup', markForceEndDrag, true);
            window.removeEventListener('blur', markForceEndDrag);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // Segment->host lookup cache: rebuilt whenever support state changes.
    // Walks every type declaring segments, so a ninth joins by being registered.
    type SegmentHostEntry = { containerType: SupportTypeId; entityId: string };
    const segmentHostMapRef = useRef<Map<string, SegmentHostEntry>>(new Map());

    useEffect(() => {
        const buildMap = () => {
            const map = new Map<string, SegmentHostEntry>();
            const snapshot = getSnapshot() as unknown as Record<string, Record<string, { id: string; segments?: { id: string }[] }>>;

            for (const descriptor of SUPPORT_TYPES) {
                if (!descriptor.hasSegments) continue;
                for (const entity of Object.values(snapshot[descriptor.location.key] ?? {})) {
                    for (const seg of entity.segments ?? []) {
                        map.set(seg.id, { containerType: descriptor.id, entityId: entity.id });
                    }
                }
            }
            segmentHostMapRef.current = map;
        };
        buildMap();
        return subscribe(buildMap);
    }, []);

    const showLeafClampWarning = () => {
        setInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
        if (leafClampWarningTimeout.current) {
            window.clearTimeout(leafClampWarningTimeout.current);
        }
        leafClampWarningTimeout.current = window.setTimeout(() => {
            setInteractionWarning(null);
            leafClampWarningTimeout.current = null;
        }, 500);
    };

    const computeTOnHost = (pos: { x: number; y: number; z: number }, host: ActiveHost) => {
        const dir = new THREE.Vector3().subVectors(host.end, host.start);
        const lenSq = dir.lengthSq();
        if (lenSq < 0.000001) return 0;
        const v = new THREE.Vector3(pos.x - host.start.x, pos.y - host.start.y, pos.z - host.start.z);
        return THREE.MathUtils.clamp(v.dot(dir) / lenSq, 0, 1);
    };

    const markKnotDragUpdatePending = useCallback(() => {
        if (!activeKnotId.current) return;
        knotDragUpdatePendingRef.current = true;
    }, []);

    const snapVec3 = (vec: THREE.Vector3) => {
        vec.x = Math.round(vec.x / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        vec.y = Math.round(vec.y / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        vec.z = Math.round(vec.z / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        return vec;
    };

    const clampTToLeafAngleConstraints = (
        tDesired: number,
        tCurrent: number,
        host: ActiveHost,
        maxAngleDeg: number,
    ): { t: number; clamped: boolean } => {
        const leaves = getSupportEntities<Leaf>('leaf').filter(l => l.parentKnotId === activeKnotId.current);
        if (leaves.length === 0) return { t: tDesired, clamped: false };

        let low = 0;
        let high = 1;

        const dir = new THREE.Vector3().subVectors(host.end, host.start);
        const dDotD = dir.dot(dir);
        if (dDotD < 0.000001) return { t: tDesired, clamped: false };

        const cosA = Math.cos(THREE.MathUtils.degToRad(maxAngleDeg));
        const k = cosA * cosA;

        const pickIntervalContaining = (intervals: Array<[number, number]>, tRef: number): [number, number] | null => {
            const eps = 1e-6;
            for (const [a, b] of intervals) {
                if (tRef >= a - eps && tRef <= b + eps) return [a, b];
            }
            // Fallback: choose the closest interval
            let best: [number, number] | null = null;
            let bestDist = Number.POSITIVE_INFINITY;
            for (const [a, b] of intervals) {
                const dist = tRef < a ? (a - tRef) : (tRef > b ? (tRef - b) : 0);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = [a, b];
                }
            }
            return best;
        };

        const intersect = (a0: number, a1: number, b0: number, b1: number) => {
            return [Math.max(a0, b0), Math.min(a1, b1)] as [number, number];
        };

        for (const leaf of leaves) {
            if (!leaf.contactCone) continue;

            const tip = new THREE.Vector3(leaf.contactCone.pos.x, leaf.contactCone.pos.y, leaf.contactCone.pos.z);
            const w = tip.clone().sub(host.start); // W = tip - start

            const wDotW = w.dot(w);
            const wDotD = w.dot(dir);
            const wz = w.z;
            const dz = dir.z;

            // f(t) = (v_z)^2 - k*|v|^2 >= 0 where v = W - D*t
            const A = (dz * dz) - k * dDotD;
            const B = 2 * (k * wDotD - wz * dz);
            const C = (wz * wz) - k * wDotW;

            const epsA = 1e-10;
            const intervals: Array<[number, number]> = [];

            if (Math.abs(A) < epsA) {
                // Linear: B t + C >= 0
                if (Math.abs(B) < 1e-10) {
                    if (C >= 0) {
                        intervals.push([0, 1]);
                    }
                } else {
                    const t0 = -C / B;
                    if (B > 0) {
                        intervals.push([THREE.MathUtils.clamp(t0, 0, 1), 1]);
                    } else {
                        intervals.push([0, THREE.MathUtils.clamp(t0, 0, 1)]);
                    }
                }
            } else {
                const disc = B * B - 4 * A * C;
                if (disc < 0) {
                    // No real roots: either always valid or always invalid
                    if (C >= 0) {
                        intervals.push([0, 1]);
                    }
                } else {
                    const sqrtD = Math.sqrt(disc);
                    const r1 = (-B - sqrtD) / (2 * A);
                    const r2 = (-B + sqrtD) / (2 * A);
                    const loR = Math.min(r1, r2);
                    const hiR = Math.max(r1, r2);

                    if (A > 0) {
                        // Outside [loR, hiR]
                        intervals.push([0, THREE.MathUtils.clamp(loR, 0, 1)]);
                        intervals.push([THREE.MathUtils.clamp(hiR, 0, 1), 1]);
                    } else {
                        // Inside [loR, hiR]
                        intervals.push([
                            THREE.MathUtils.clamp(loR, 0, 1),
                            THREE.MathUtils.clamp(hiR, 0, 1),
                        ]);
                    }
                }
            }

            const chosen = pickIntervalContaining(intervals, tCurrent);
            if (!chosen) {
                return { t: tCurrent, clamped: true };
            }

            let [leafLow, leafHigh] = chosen;

            // Additional hard constraint: knot cannot go above the leaf tip.
            const epsilonZ = 0.0001;
            const maxKnotZ = tip.z - epsilonZ;
            if (Math.abs(dz) < 1e-10) {
                if (host.start.z > maxKnotZ) {
                    return { t: tCurrent, clamped: true };
                }
            } else {
                const tAtMaxZ = (maxKnotZ - host.start.z) / dz;
                if (dz > 0) {
                    // increasing t increases z
                    leafHigh = Math.min(leafHigh, tAtMaxZ);
                } else {
                    // increasing t decreases z
                    leafLow = Math.max(leafLow, tAtMaxZ);
                }
            }

            [leafLow, leafHigh] = intersect(leafLow, leafHigh, 0, 1);
            if (leafLow > leafHigh) {
                return { t: tCurrent, clamped: true };
            }

            [low, high] = intersect(low, high, leafLow, leafHigh);
            if (low > high) {
                return { t: tCurrent, clamped: true };
            }
        }

        const tClamped = THREE.MathUtils.clamp(tDesired, low, high);
        return { t: tClamped, clamped: Math.abs(tClamped - tDesired) > 1e-6 };
    };

    /**
     * An ActiveHost for any shafted type, with the hosts its lower and upper
     * endpoints declare. Was six near-identical branches.
     */
    const buildShaftHost = (typeId: SupportTypeId, entityId: string, segmentId: string): ActiveHost | null => {
        const descriptor = getSupportTypeDescriptor(typeId);
        if (!descriptor.hasSegments) return null;

        const entity = getSupportEntity(typeId, entityId) as
            | (Record<string, unknown> & { rootId?: string; parentKnotId?: string; hostKnotId?: string })
            | null;
        if (!entity) return null;

        // A plate-rooted type needs its root; a knot-hosted one its host knot.
        const root = descriptor.lower.kind === 'plateRoot' && entity.rootId
            ? getRootById(entity.rootId) ?? undefined
            : undefined;
        if (descriptor.lower.kind === 'plateRoot' && !root) return null;

        const knotField = descriptor.edges.find((e: SupportEdge) => e.to === 'knots' && e.ownership === 'hostedBy')?.field;
        const hostKnot = knotField && typeof entity[knotField] === 'string'
            ? getKnotById(entity[knotField] as string) ?? undefined
            : undefined;
        if (descriptor.upper.kind === 'knot' && !hostKnot) return null;

        return {
            segmentId,
            containerType: typeId,
            entity: entity as ActiveHost['entity'],
            hosts: { root, hostKnot },
            start: new THREE.Vector3(),
            end: new THREE.Vector3(),
            initialTopology: {},
        };
    };

    const findHost = (knot: Knot): ActiveHost | null => {
        let host: ActiveHost | null = null;

        // Leaf cone host (brace endpoints)
        if (knot.parentShaftId.startsWith('leafCone:')) {
            const leafId = knot.parentShaftId.slice('leafCone:'.length);
            const leaf = getSupportEntities<Leaf>('leaf').find(l => l.id === leafId);
            if (leaf?.contactCone) {
                host = {
                    segmentId: knot.parentShaftId,
                    containerType: 'leafCone',
                    hosts: {},
                    leafId,
                    start: new THREE.Vector3(),
                    end: new THREE.Vector3(),
                    initialTopology: {},
                };
                return host;
            }
        }

        if (knot.parentShaftId.startsWith('braceSegment:')) {
            const braceId = knot.parentShaftId.slice('braceSegment:'.length);
            const brace = getSupportEntities<Brace>('brace').find(b => b.id === braceId);
            if (brace) {
                host = {
                    segmentId: knot.parentShaftId,
                    containerType: 'brace',
                    entity: brace,
                    hosts: {},
                    start: new THREE.Vector3(),
                    end: new THREE.Vector3(),
                    initialTopology: {},
                };
                return host;
            }
        }
        const cacheEntry = segmentHostMapRef.current.get(knot.parentShaftId);
        if (cacheEntry) {
            host = buildShaftHost(cacheEntry.containerType as SupportTypeId, cacheEntry.entityId, knot.parentShaftId);
        }

        if (!host) {
            // Stale cache: search every shafted type rather than only sticks.
            const owner = findShaftOwnerOfSegment(knot.parentShaftId);
            if (owner) host = buildShaftHost(owner.typeId, owner.id, knot.parentShaftId);
        }

        if (host) {
            // Determine Initial Topology
            const allBranches = getSupportEntities<Branch>('branch');
            const attached = allBranches.filter(b => b.parentKnotId === knot.id);
            for (const b of attached) {
                if (b.segments.length > 0) {
                    let jointZ = 0;
                    if (b.segments[0].topJoint) jointZ = b.segments[0].topJoint.pos.z;
                    else if (b.contactCone) jointZ = b.contactCone.pos.z; // Approximate

                    // If Knot is BELOW Joint => UP branch
                    // If Knot is ABOVE Joint => DOWN branch
                    if (knot.pos.z < jointZ) {
                        host.initialTopology[b.id] = 'UP';
                    } else {
                        host.initialTopology[b.id] = 'DOWN';
                    }
                }
            }
        }

        return host;
    };

    /** The shafted entity and hosts backing this host record, if it has one. */
    const shaftOf = (host: ActiveHost): { entity: { segments: Segment[] }; hosts: EndpointHosts } | null => {
        if (!hostsRealSegments(host.containerType) || !host.entity?.segments) return null;
        return { entity: host.entity as { segments: Segment[] }, hosts: host.hosts };
    };

    const resolveEndpoints = (host: ActiveHost) => {
        // Every shafted host resolves the same way; only the two without a
        // shaft need their own maths.
        const shaft = shaftOf(host);
        if (shaft) {
            const index = shaft.entity.segments.findIndex((s) => s.id === host.segmentId);
            if (index === -1) return;
            const endpoints = resolveSegmentEndpoints(
                host.containerType as SupportTypeId,
                shaft.entity,
                shaft.entity.segments[index],
                index,
                shaft.hosts,
            );
            if (endpoints) {
                host.start.set(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                host.end.set(endpoints.end.x, endpoints.end.y, endpoints.end.z);
            }
            return;
        }

        if (host.containerType === 'leafCone' && host.leafId) {
            const leaf = getSupportEntities<Leaf>('leaf').find((l) => l.id === host.leafId);
            const cone = leaf?.contactCone;
            if (!cone) return;

            const socketPos = getFinalSocketPosition(cone);
            const axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z).normalize();
            const len = cone.profile?.lengthMm ?? 0;

            const endVec = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
            host.start.copy(endVec.clone().add(axis.multiplyScalar(-len)));
            host.end.copy(endVec);
        } else if (host.containerType === 'brace' && host.entity) {
            const brace = host.entity as unknown as Brace;
            const startKnot = getKnotById(brace.startKnotId);
            const endKnot = getKnotById(brace.endKnotId);
            if (!startKnot || !endKnot) return;
            host.start.set(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z);
            host.end.set(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z);
        }
    };

    const getHostCandidates = (host: ActiveHost): Array<{ segmentId: string; start: THREE.Vector3; end: THREE.Vector3; diameter: number; bezier?: { control1: Vec3; control2: Vec3 } }> => {
        const out: Array<{ segmentId: string; start: THREE.Vector3; end: THREE.Vector3; diameter: number; bezier?: { control1: Vec3; control2: Vec3 } }> = [];

        // Every shafted host offers its segments; a brace offers the one span
        // between its end knots.
        const shaft = shaftOf(host);
        if (shaft) {
            shaft.entity.segments.forEach((seg, idx) => {
                const endpoints = resolveSegmentEndpoints(
                    host.containerType as SupportTypeId, shaft.entity, seg, idx, shaft.hosts,
                );
                if (!endpoints) return;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z),
                    end: new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                });
            });
            return out;
        }

        if (host.containerType === 'brace' && host.entity) {
            const brace = host.entity as unknown as Brace;
            const startKnot = getKnotById(brace.startKnotId);
            const endKnot = getKnotById(brace.endKnotId);
            if (startKnot && endKnot) {
                out.push({
                    segmentId: host.segmentId,
                    start: new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z),
                    end: new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z),
                    diameter: brace.profile.diameter,
                });
            }
        }

        return out;
    };

    const projectOntoBezierCurve = (
        ray: THREE.Ray,
        start: THREE.Vector3,
        end: THREE.Vector3,
        control1: Vec3,
        control2: Vec3,
        steps: number,
    ): { t: number; point: Vec3; distSq: number } => {
        let best = Infinity;
        let bt = 0;
        let bp = new THREE.Vector3();
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const p = getBezierPointAtT(
                { x: start.x, y: start.y, z: start.z },
                control1,
                control2,
                { x: end.x, y: end.y, z: end.z },
                t,
            );
            const vP = new THREE.Vector3(p.x, p.y, p.z);
            const distSq = ray.distanceSqToPoint(vP);
            if (distSq < best) {
                best = distSq;
                bt = t;
                bp = vP;
            }
        }
        return { t: bt, point: { x: bp.x, y: bp.y, z: bp.z }, distSq: best };
    };

    // Capture the initial state of attached branches
    const captureElasticState = (knotId: string): Record<string, ElasticChainInitialState> => {
        const allBranches = getSupportEntities<Branch>('branch');
        const attached = allBranches.filter(b => b.parentKnotId === knotId);
        const state: Record<string, ElasticChainInitialState> = {};

        for (const b of attached) {
            const joints: { id: string; pos: { x: number, y: number, z: number } }[] = [];

            // Traverse segments to collect joints

            for (let i = 0; i < b.segments.length; i++) {
                const seg = b.segments[i];
                // Try to find the joint at the top of this segment
                let joint = seg.topJoint;

                // If not found, check the bottom of the NEXT segment (redundancy)
                if (!joint && i < b.segments.length - 1) {
                    joint = b.segments[i + 1].bottomJoint;
                }

                if (joint) {
                    joints.push({
                        id: joint.id,
                        pos: { ...joint.pos }
                    });
                }
            }

            const knotPos = getKnotById(knotId)?.pos || { x: 0, y: 0, z: 0 };

            state[b.id] = {
                branchId: b.id,
                knotPos: { ...knotPos },
                joints,
                // Use SOCKET position (where shaft connects), not TIP position (where cone touches model)
                contactCone: b.contactCone ? {
                    pos: getSocketPosition(b.contactCone.pos, b.contactCone.normal, b.contactCone.profile)
                } : undefined
            };
        }

        return state;
    };

    useEffect(() => {
        if (!enabled) return;
        if (isDragging) return;
        if (hit.category !== 'knot' || !hit.objectId) return;

        const knotId = hit.objectId;
        if (
            prewarmedKnotIdRef.current === knotId
            && prewarmedHostRef.current
            && prewarmedElasticStateRef.current
            && isSameSupportGeometry(prewarmedGeometryRef.current, captureSupportGeometryToken())
        ) {
            return;
        }

        const knot = getKnotById(knotId);
        if (!knot) return;

        const host = findHost(knot);
        if (!host) return;
        resolveEndpoints(host);

        prewarmedKnotIdRef.current = knotId;
        prewarmedHostRef.current = host;
        prewarmedElasticStateRef.current = captureElasticState(knotId);
        prewarmedGeometryRef.current = captureSupportGeometryToken();
    }, [enabled, isDragging, hit.category, hit.objectId]);

    useEffect(() => {
        if (!enabled && !activeKnotId.current) return;

        if (enabled && isDragging && hit.category === 'knot' && hit.objectId && !activeKnotId.current) {
            const knot = getKnotById(hit.objectId);
            if (!knot) {
                return;
            }
            const prewarmIsFresh = prewarmedKnotIdRef.current === knot.id
                && isSameSupportGeometry(prewarmedGeometryRef.current, captureSupportGeometryToken());
            const host = prewarmIsFresh && prewarmedHostRef.current
                ? prewarmedHostRef.current
                : findHost(knot);
            if (!host) {
                return;
            }
            resolveEndpoints(host);
            activeKnotId.current = knot.id;
            dragStartKnotPos.current = { x: knot.pos.x, y: knot.pos.y, z: knot.pos.z };
            activeHost.current = host;
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
            setKnotDragInteractionLock(true);
            knotDragUpdatePendingRef.current = true;
            if (!knotDragListenersAttachedRef.current) {
                window.addEventListener('pointermove', markKnotDragUpdatePending, true);
                knotDragListenersAttachedRef.current = true;
            }
            lastAppliedKnotPosRef.current = null;
            previewBranchSegmentsByIdRef.current = {};
            previewKnotRef.current = null;
            lastEmittedKnotPreviewPosRef.current = null;
            lastEmittedBranchPreviewRef.current = null;
            clearKnotDragPreview();

            // Capture/restore state
            elasticState.current = prewarmIsFresh && prewarmedElasticStateRef.current
                ? prewarmedElasticStateRef.current
                : captureElasticState(knot.id);

            prewarmedKnotIdRef.current = null;
            prewarmedHostRef.current = null;
            prewarmedElasticStateRef.current = null;
            prewarmedGeometryRef.current = null;
        }

        const shouldEndDrag = (!isDragging || forceEndDragRef.current) && !!activeKnotId.current;

        if (shouldEndDrag) {
            const activeKnotIdAtEnd = activeKnotId.current;
            const activeHostAtEnd = activeHost.current;
            const previewBranchSegmentsByIdAtEnd = { ...previewBranchSegmentsByIdRef.current };
            const previewKnotAtEnd = previewKnotRef.current;

            if (
                FAST_KNOT_DRAG_ELASTIC_PREVIEW
                && activeHostAtEnd?.containerType === 'trunk'
                && previewKnotAtEnd
                && Object.keys(elasticState.current).length > 0
            ) {
                const maxAngleDeg = getSettings().shaft.maxAngleDeg ?? 80;
                let releaseKnotPos = { ...previewKnotAtEnd.pos };

                let minAllowedZ = Number.POSITIVE_INFINITY;
                let requiresClamping = false;
                const firstPassElasticResults: Record<string, ElasticChainResult> = {};

                for (const branchId in elasticState.current) {
                    const state = elasticState.current[branchId];
                    const res = solveElasticChain(releaseKnotPos, state, maxAngleDeg);
                    firstPassElasticResults[branchId] = res;

                    if (res.isLocked) {
                        requiresClamping = true;
                        if (res.knotPos.z < minAllowedZ) {
                            minAllowedZ = res.knotPos.z;
                        }
                    }
                }

                if (requiresClamping && minAllowedZ !== Number.POSITIVE_INFINITY && releaseKnotPos.z > minAllowedZ) {
                    resolveEndpoints(activeHostAtEnd);
                    const dir = new THREE.Vector3().subVectors(activeHostAtEnd.end, activeHostAtEnd.start);
                    if (Math.abs(dir.z) > 0.001) {
                        const t = (minAllowedZ - activeHostAtEnd.start.z) / dir.z;
                        const newPos = activeHostAtEnd.start.clone().add(dir.multiplyScalar(t));
                        releaseKnotPos = { x: newPos.x, y: newPos.y, z: newPos.z };
                    } else {
                        releaseKnotPos = { ...releaseKnotPos, z: minAllowedZ };
                    }
                }

                const elasticResults: Record<string, ElasticChainResult> = {};
                if (requiresClamping && minAllowedZ !== Number.POSITIVE_INFINITY) {
                    for (const branchId in elasticState.current) {
                        const state = elasticState.current[branchId];
                        elasticResults[branchId] = solveElasticChain(releaseKnotPos, state, maxAngleDeg);
                    }
                } else {
                    Object.assign(elasticResults, firstPassElasticResults);
                }

                for (const branchId in elasticState.current) {
                    const res = elasticResults[branchId];
                    if (!res) continue;

                    const branch = getSupportEntity('branch', branchId) as Branch | null;
                    if (!branch) continue;

                    let branchChanged = false;
                    const newSegments = branch.segments.map(seg => {
                        let segChanged = false;
                        let newTopJoint = seg.topJoint;
                        let newBottomJoint = seg.bottomJoint;

                        if (seg.topJoint && res.jointPositions[seg.topJoint.id]) {
                            const newPos = res.jointPositions[seg.topJoint.id];
                            if (Math.abs(newPos.z - seg.topJoint.pos.z) > 0.0001) {
                                newTopJoint = { ...seg.topJoint, pos: newPos };
                                segChanged = true;
                            }
                        }

                        if (seg.bottomJoint && res.jointPositions[seg.bottomJoint.id]) {
                            const newPos = res.jointPositions[seg.bottomJoint.id];
                            if (Math.abs(newPos.z - seg.bottomJoint.pos.z) > 0.0001) {
                                newBottomJoint = { ...seg.bottomJoint, pos: newPos };
                                segChanged = true;
                            }
                        }

                        if (segChanged) {
                            branchChanged = true;
                            return { ...seg, topJoint: newTopJoint, bottomJoint: newBottomJoint };
                        }
                        return seg;
                    });

                    if (branchChanged) {
                        previewBranchSegmentsByIdAtEnd[branch.id] = newSegments;
                    } else {
                        delete previewBranchSegmentsByIdAtEnd[branch.id];
                    }
                }

                previewKnotRef.current = {
                    ...previewKnotAtEnd,
                    pos: releaseKnotPos,
                };
            }

            // Reconcile drag-time fast-path edits with an exact pass once on release.
            for (const [branchId, previewSegments] of Object.entries(previewBranchSegmentsByIdAtEnd)) {
                const branch = getSupportEntity('branch', branchId) as Branch | null;
                if (branch) {
                    updateSupportEntity('branch', { ...branch, segments: previewSegments });
                }
            }

            // Only write when the knot actually moved. `updateKnot` resettles
            // dependent geometry, which re-derives a hosted leaf's cone from the
            // knot -- so committing a click swings a cone nobody dragged.
            if (previewKnotAtEnd
                && previewKnotAtEnd.id === activeKnotIdAtEnd
                && shouldCommitJointDrag(dragStartKnotPos.current, previewKnotAtEnd.pos)) {
                updateKnot(previewKnotAtEnd);
            }

            // If the released knot lives on a twig, persist the leaf cone's
            // updated wide-end (bodyDiameterMm) so the cone keeps the taper
            // it visibly had during the drag preview.
            if (
                activeKnotIdAtEnd
                && activeHostAtEnd?.containerType === 'twig'
                && (activeHostAtEnd.entity as unknown as Twig)
                && previewKnotAtEnd
                && previewKnotAtEnd.t !== undefined
            ) {
                const localTwigDia = resolveTwigDiameterAtSegmentT(
                    (activeHostAtEnd.entity as unknown as Twig),
                    activeHostAtEnd.segmentId,
                    previewKnotAtEnd.t,
                );
                if (localTwigDia !== null) {
                    const attachedLeaves = getSupportEntities<Leaf>('leaf').filter(l => l.parentKnotId === activeKnotIdAtEnd);
                    for (const leaf of attachedLeaves) {
                        if (!leaf.contactCone) continue;
                        if (leaf.contactCone.profile.bodyDiameterMm === localTwigDia) continue;
                        updateSupportEntity('leaf', {
                            ...leaf,
                            contactCone: {
                                ...leaf.contactCone,
                                profile: {
                                    ...leaf.contactCone.profile,
                                    bodyDiameterMm: localTwigDia,
                                },
                            },
                        });
                    }
                }
            }

            if (activeHostAtEnd && initialEditSnapshotRef.current) {
                const description = knotMoveDescription(activeHostAtEnd.containerType);
                pushSupportEditHistory(description, initialEditSnapshotRef.current, captureSupportEditSnapshot());
            }

            activeKnotId.current = null;
            dragStartKnotPos.current = null;
            activeHost.current = null;
            elasticState.current = {};
            forceEndDragRef.current = false;
            initialEditSnapshotRef.current = null;
            setKnotDragInteractionLock(false);
            knotDragUpdatePendingRef.current = false;
            if (knotDragListenersAttachedRef.current) {
                window.removeEventListener('pointermove', markKnotDragUpdatePending, true);
                knotDragListenersAttachedRef.current = false;
            }

            if (leafClampWarningTimeout.current) {
                window.clearTimeout(leafClampWarningTimeout.current);
                leafClampWarningTimeout.current = null;
            }
            setInteractionWarning(null);

            prewarmedKnotIdRef.current = null;
            prewarmedHostRef.current = null;
            prewarmedElasticStateRef.current = null;
            lastAppliedKnotPosRef.current = null;
            previewBranchSegmentsByIdRef.current = {};
            previewKnotRef.current = null;
            lastEmittedKnotPreviewPosRef.current = null;
            lastEmittedBranchPreviewRef.current = null;
            clearKnotDragPreview();
        }
    }, [isDragging, hit, enabled, setKnotDragInteractionLock, markKnotDragUpdatePending]);

    useFrame(() => {
        if (!knotDragUpdatePendingRef.current) return;
        if (!activeKnotId.current || !activeHost.current) return;

        knotDragUpdatePendingRef.current = false;

        const knot = getKnotById(activeKnotId.current);
        if (!knot) return;

        const host = activeHost.current;
        resolveEndpoints(host);

        // Leaf-cone knots (brace endpoints) slide along the cone axis.
        if (host.containerType === 'leafCone' && host.leafId) {
            raycaster.setFromCamera(pointer, camera);
            const projected = projectOntoSegment(raycaster.ray, host.start, host.end);

            const leaf = getSupportEntities<Leaf>('leaf').find(l => l.id === host.leafId);
            const cone = leaf?.contactCone;
            if (!cone) return;

            const lenMm = cone.profile?.lengthMm ?? 0;
            const minMm = 0.25;
            const minT = lenMm > 0.0001 ? THREE.MathUtils.clamp(minMm / lenMm, 0, 0.99) : 0;
            const t = THREE.MathUtils.clamp(projected.t, minT, 1);

            const lineVec = new THREE.Vector3().subVectors(host.end, host.start);
            const finalOnLine = snapVec3(host.start.clone().add(lineVec.multiplyScalar(t)));

            const contactDia = cone.profile?.contactDiameterMm ?? 0.4;
            const bodyDia = cone.profile?.bodyDiameterMm ?? 1.2;
            const hostDia = THREE.MathUtils.lerp(contactDia, bodyDia, t);

            const finalKnot: Knot = {
                ...knot,
                pos: { x: finalOnLine.x, y: finalOnLine.y, z: finalOnLine.z },
                t,
                diameter: hostDia + 0.1,
            };

            previewKnotRef.current = finalKnot;
            const prevKnot = lastEmittedKnotPreviewPosRef.current;
            const nextKnotPos = finalKnot.pos;
            const sameKnotPos = !!prevKnot
                && Math.abs(prevKnot.x - nextKnotPos.x) < MIN_DRAG_DELTA_SQ
                && Math.abs(prevKnot.y - nextKnotPos.y) < MIN_DRAG_DELTA_SQ
                && Math.abs(prevKnot.z - nextKnotPos.z) < MIN_DRAG_DELTA_SQ;
            if (!sameKnotPos || lastEmittedBranchPreviewRef.current !== previewBranchSegmentsByIdRef.current) {
                lastEmittedKnotPreviewPosRef.current = { ...nextKnotPos };
                lastEmittedBranchPreviewRef.current = previewBranchSegmentsByIdRef.current;
                emitKnotDragPreview({
                    knotId: finalKnot.id,
                    knot: finalKnot,
                    branchSegmentsById: previewBranchSegmentsByIdRef.current,
                });
            }
            return;
        }

        raycaster.setFromCamera(pointer, camera);

        const quickProjected = projectOntoSegment(raycaster.ray, host.start, host.end);
        const quickProjectedVec = snapVec3(new THREE.Vector3(quickProjected.point.x, quickProjected.point.y, quickProjected.point.z));
        const hasLastApplied = !!lastAppliedKnotPosRef.current;
        const deltaSq = hasLastApplied
            ? lastAppliedKnotPosRef.current!.distanceToSquared(quickProjectedVec)
            : Number.POSITIVE_INFINITY;

        if (hasLastApplied && deltaSq < MIN_DRAG_DELTA_SQ) {
            return;
        }

        // Allow cross-segment dragging: choose the best segment in this trunk/branch.
        const candidates = getHostCandidates(host);
        let bestSegmentId = host.segmentId;
        let bestDiameter = 1.2;
        const projectedOnHost = projectOntoSegment(raycaster.ray, host.start, host.end);
        let bestPoint = projectedOnHost.point;
        let bestT = projectedOnHost.t;
        let bestDistSq = Number.POSITIVE_INFINITY;

        const braceHost = host.containerType === 'brace'
            ? host.entity as unknown as Brace | undefined
            : undefined;
        if (braceHost?.curve?.type === 'bezier') {
            const startKnot = getKnotById(braceHost.startKnotId);
            const endKnot = getKnotById(braceHost.endKnotId);
            if (startKnot && endKnot) {
                const STEPS = 40;
                let best = Infinity;
                let bt = 0;
                let bp = new THREE.Vector3();
                for (let i = 0; i <= STEPS; i++) {
                    const t = i / STEPS;
                    const p = getBezierPointAtT(
                        startKnot.pos,
                        braceHost.curve.controlPoint1,
                        braceHost.curve.controlPoint2,
                        endKnot.pos,
                        t
                    );
                    const vP = new THREE.Vector3(p.x, p.y, p.z);
                    const distSq = raycaster.ray.distanceSqToPoint(vP);
                    if (distSq < best) {
                        best = distSq;
                        bt = t;
                        bp = vP;
                    }
                }
                bestT = bt;
                bestPoint = { x: bp.x, y: bp.y, z: bp.z };
                bestDistSq = best;
            }
        } else {
            if (candidates.length > 0) {
                for (const c of candidates) {
                    if (c.bezier) {
                        const proj = projectOntoBezierCurve(raycaster.ray, c.start, c.end, c.bezier.control1, c.bezier.control2, BEZIER_PROJECTION_STEPS);
                        if (proj.distSq < bestDistSq) {
                            bestDistSq = proj.distSq;
                            bestSegmentId = c.segmentId;
                            bestDiameter = c.diameter;
                            bestT = proj.t;
                            bestPoint = proj.point;
                        }
                    } else {
                        const pointOnRay = new THREE.Vector3();
                        const pointOnSeg = new THREE.Vector3();
                        const distSq = raycaster.ray.distanceSqToSegment(c.start, c.end, pointOnRay, pointOnSeg);

                        if (distSq < bestDistSq) {
                            bestDistSq = distSq;
                            bestSegmentId = c.segmentId;
                            bestDiameter = c.diameter;

                            const segLen = c.start.distanceTo(c.end);
                            const t = segLen > 0 ? c.start.distanceTo(pointOnSeg) / segLen : 0;
                            bestT = THREE.MathUtils.clamp(t, 0, 1);
                            bestPoint = { x: pointOnSeg.x, y: pointOnSeg.y, z: pointOnSeg.z };
                        }
                    }
                }

                // Prefer staying on the current segment when distances are extremely
                // close, to reduce flicker mid-segment. This bias is applied ONLY while
                // the projection is interior to the current segment. Right at a joint the
                // current segment's closest point saturates at its shared endpoint, so a
                // blanket bias there would pin the knot to the joint and refuse to hand
                // off to the neighbour until it won by >5% -- that is the "knot hangs on
                // the joint" bug. At the ends we drop the bias and let closest-wins move
                // the knot across the joint as soon as the neighbour is genuinely closer.
                const CURRENT_SEGMENT_STICKINESS = 1.05;
                const INTERIOR_EPS = 1e-3;
                const current = candidates.find(c => c.segmentId === host.segmentId);
                if (current) {
                    if (current.bezier) {
                        const proj = projectOntoBezierCurve(raycaster.ray, current.start, current.end, current.bezier.control1, current.bezier.control2, BEZIER_PROJECTION_STEPS);
                        if (shouldStayOnCurrentSegment(proj.t, proj.distSq, bestDistSq, CURRENT_SEGMENT_STICKINESS, INTERIOR_EPS)) {
                            bestSegmentId = current.segmentId;
                            bestDiameter = current.diameter;
                            bestPoint = proj.point;
                            bestT = proj.t;
                        }
                    } else {
                        const pr = projectOntoSegment(raycaster.ray, current.start, current.end);
                        const pointOnRay = new THREE.Vector3();
                        const pointOnSeg = new THREE.Vector3();
                        const currentDistSq = raycaster.ray.distanceSqToSegment(current.start, current.end, pointOnRay, pointOnSeg);
                        if (shouldStayOnCurrentSegment(pr.t, currentDistSq, bestDistSq, CURRENT_SEGMENT_STICKINESS, INTERIOR_EPS)) {
                            bestSegmentId = current.segmentId;
                            bestDiameter = current.diameter;
                            bestPoint = pr.point;
                            bestT = pr.t;
                        }
                    }
                }
            }
        }

        // Update active host segment if we crossed a joint into a new segment.
        if (bestSegmentId && bestSegmentId !== host.segmentId) {
            host.segmentId = bestSegmentId;
            const chosen = candidates.find(c => c.segmentId === bestSegmentId);
            if (chosen) {
                host.start.copy(chosen.start);
                host.end.copy(chosen.end);
            }
        }

        if (bestSegmentId.startsWith('braceSegment:')) {
            const braceId = bestSegmentId.slice('braceSegment:'.length);
            const brace = getSupportEntities<Brace>('brace').find(b => b.id === braceId);
            if (brace) {
                const startKnot = getKnotById(brace.startKnotId);
                const endKnot = getKnotById(brace.endKnotId);
                if (startKnot && endKnot) {
                    const startDia = Math.max(
                        0.001,
                        (startKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                    );
                    const endDia = Math.max(
                        0.001,
                        (endKnot.diameter ?? (brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                    );
                    bestDiameter = THREE.MathUtils.lerp(startDia, endDia, bestT);
                }
            }
        }

        const result = { point: bestPoint, t: bestT };

        // Apply Shaft Angle Constraint
        const settings = getSettings();
        const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;

        // Collect IDs of branches managed by Elastic Chain
        const elasticBranchIds = Object.keys(elasticState.current);

        // 1. Initial Constraint (Shaft + Basic Angle)
        // We IGNORE elastic branches here because ElasticChainSolver will handle them properly.
        // Static constraint solver would clamp the Knot based on the OLD joint position, preventing movement.
        let constrainedPos = solveKnotConstraint(knot, snapVec3(new THREE.Vector3(result.point.x, result.point.y, result.point.z)), maxAngleDeg, host.initialTopology, elasticBranchIds);

        // 1b. Leaf Constraint (if this knot owns a Leaf)
        // Prevent dragging past the same 10° from horizontal rule that placement enforces.
        const attemptedPos = constrainedPos;
        const tDesired = computeTOnHost(constrainedPos, host);
        const tCurrent = computeTOnHost(knot.pos, host);
        const leafClamp = clampTToLeafAngleConstraints(tDesired, tCurrent, host, maxAngleDeg);
        if (leafClamp.clamped) {
            const dir = new THREE.Vector3().subVectors(host.end, host.start);
            const newPos = snapVec3(host.start.clone().add(dir.multiplyScalar(leafClamp.t)));
            constrainedPos = { x: newPos.x, y: newPos.y, z: newPos.z };

            const epsilonZ = 0.0001;
            if (attemptedPos.z > constrainedPos.z + epsilonZ) {
                showLeafClampWarning();
            }
        }

        const branchSegmentsById: Record<string, Branch['segments']> = {};

        // 2. Elastic Chain Logic
        // Fast trunk-knot preview path: skip heavy per-frame elastic solving and
        // defer exact solving to release for smoother branch/leaf visual response.
        const shouldSkipElasticPreview = FAST_KNOT_DRAG_ELASTIC_PREVIEW && host.containerType === 'trunk';
        let finalKnotPos = constrainedPos;

        if (shouldSkipElasticPreview) {
            for (const branchId of Object.keys(previewBranchSegmentsByIdRef.current)) {
                const branch = getSupportEntity('branch', branchId) as Branch | null;
                if (branch) {
                    // Explicitly mark previously preview-overridden branches for prune.
                    branchSegmentsById[branch.id] = branch.segments;
                }
            }
        } else {
            let minAllowedZ = Number.POSITIVE_INFINITY;
            let requiresClamping = false;
            const firstPassElasticResults: Record<string, ElasticChainResult> = {};

            for (const branchId in elasticState.current) {
                const state = elasticState.current[branchId];
                const res = solveElasticChain(constrainedPos, state, maxAngleDeg);
                firstPassElasticResults[branchId] = res;

                if (res.isLocked) {
                    requiresClamping = true;
                    if (res.knotPos.z < minAllowedZ) {
                        minAllowedZ = res.knotPos.z;
                    }
                }
            }

            if (requiresClamping && minAllowedZ !== Number.POSITIVE_INFINITY && constrainedPos.z > minAllowedZ) {
                const dir = new THREE.Vector3().subVectors(host.end, host.start);
                if (Math.abs(dir.z) > 0.001) {
                    const t = (minAllowedZ - host.start.z) / dir.z;
                    const newPos = snapVec3(host.start.clone().add(dir.multiplyScalar(t)));
                    constrainedPos = { x: newPos.x, y: newPos.y, z: newPos.z };
                } else {
                    constrainedPos = { ...constrainedPos, z: minAllowedZ };
                }
                finalKnotPos = constrainedPos;
            }

            const elasticResults: Record<string, ElasticChainResult> = {};
            if (requiresClamping && minAllowedZ !== Number.POSITIVE_INFINITY) {
                for (const branchId in elasticState.current) {
                    const state = elasticState.current[branchId];
                    elasticResults[branchId] = solveElasticChain(finalKnotPos, state, maxAngleDeg);
                }
            } else {
                Object.assign(elasticResults, firstPassElasticResults);
            }

            for (const branchId in elasticState.current) {
                const res = elasticResults[branchId];
                if (!res) continue;

                const branch = getSupportEntity('branch', branchId) as Branch | null;
                if (!branch) continue;

                let branchChanged = false;
                const newSegments = branch.segments.map(seg => {
                    let segChanged = false;
                    let newTopJoint = seg.topJoint;
                    let newBottomJoint = seg.bottomJoint;

                    if (seg.topJoint && res.jointPositions[seg.topJoint.id]) {
                        const newPos = res.jointPositions[seg.topJoint.id];
                        if (Math.abs(newPos.z - seg.topJoint.pos.z) > 0.0001) {
                            newTopJoint = { ...seg.topJoint, pos: newPos };
                            segChanged = true;
                        }
                    }

                    if (seg.bottomJoint && res.jointPositions[seg.bottomJoint.id]) {
                        const newPos = res.jointPositions[seg.bottomJoint.id];
                        if (Math.abs(newPos.z - seg.bottomJoint.pos.z) > 0.0001) {
                            newBottomJoint = { ...seg.bottomJoint, pos: newPos };
                            segChanged = true;
                        }
                    }

                    if (segChanged) {
                        branchChanged = true;
                        return { ...seg, topJoint: newTopJoint, bottomJoint: newBottomJoint };
                    }
                    return seg;
                });

                if (branchChanged) {
                    branchSegmentsById[branch.id] = newSegments;
                } else if (Object.prototype.hasOwnProperty.call(previewBranchSegmentsByIdRef.current, branch.id)) {
                    // Branch returned to committed geometry; keep an explicit sync entry so
                    // we can prune stale preview overrides below.
                    branchSegmentsById[branch.id] = branch.segments;
                }
            }
        }


        // Calculate T for Knot based on final position
        const lineVec = new THREE.Vector3().subVectors(host.end, host.start);
        const lenSq = lineVec.lengthSq();
        let t = 0;
        if (lenSq > 0.0001) {
            const knotVec = new THREE.Vector3().subVectors(
                new THREE.Vector3(finalKnotPos.x, finalKnotPos.y, finalKnotPos.z),
                host.start
            );
            t = knotVec.dot(lineVec) / lenSq;
            t = Math.max(0, Math.min(1, t));
        }

        let finalOnLine = snapVec3(host.start.clone().add(lineVec.clone().multiplyScalar(t)));

        // For curved braces: keep knot exactly on the curve and derive t from closest sample.
        const curvedBrace = host.containerType === 'brace'
            ? host.entity as unknown as Brace | undefined
            : undefined;
        if (curvedBrace?.curve?.type === 'bezier') {
            const startKnot = getKnotById(curvedBrace.startKnotId);
            const endKnot = getKnotById(curvedBrace.endKnotId);
            if (startKnot && endKnot) {
                const STEPS = 60;
                let best = Infinity;
                let bt = 0;
                let bp = new THREE.Vector3();
                const target = new THREE.Vector3(finalKnotPos.x, finalKnotPos.y, finalKnotPos.z);

                for (let i = 0; i <= STEPS; i++) {
                    const tt = i / STEPS;
                    const p = getBezierPointAtT(
                        startKnot.pos,
                        curvedBrace.curve.controlPoint1,
                        curvedBrace.curve.controlPoint2,
                        endKnot.pos,
                        tt
                    );
                    const vP = new THREE.Vector3(p.x, p.y, p.z);
                    const d = vP.distanceToSquared(target);
                    if (d < best) {
                        best = d;
                        bt = tt;
                        bp = vP;
                    }
                }

                t = bt;
                finalOnLine = snapVec3(bp);

                const startDia = Math.max(
                    0.001,
                    (startKnot.diameter ?? (curvedBrace!.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                );
                const endDia = Math.max(
                    0.001,
                    (endKnot.diameter ?? (curvedBrace!.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                );
                bestDiameter = THREE.MathUtils.lerp(startDia, endDia, t);
            }
        }

        // Every shafted host projects onto its own bezier segment identically.
        const shaft = shaftOf(host);
        if (shaft) {
            const seg = shaft.entity.segments.find((s: Segment) => s.id === host.segmentId);
            if (seg?.type === 'bezier') {
                const proj = projectOntoBezierCurve(
                    raycaster.ray,
                    host.start,
                    host.end,
                    seg.controlPoint1,
                    seg.controlPoint2,
                    BEZIER_PROJECTION_STEPS,
                );
                t = proj.t;
                finalOnLine = snapVec3(new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z));
                bestDiameter = seg.diameter;
            }
        }

        // Update Knot
        const finalKnot: Knot = {
            ...knot,
            parentShaftId: host.segmentId,
            pos: { x: finalOnLine.x, y: finalOnLine.y, z: finalOnLine.z },
            t: t
        };

        // Update diameter when crossing into a segment with a different diameter.
        // Every shaft host does this; a leaf cone is the one that does not.
        if (takesShaftDiameter(host.containerType)) {
            // +0.125 (not the legacy +0.1): the KnotRenderer subtracts the
            // full joint offset, so shaft + 0.125 renders at shaft + 0.025 —
            // the same diameter as a trunk's joint spheres. A moved auto
            // leaf knot otherwise shrinks to the shaft and disappears.
            finalKnot.diameter = bestDiameter + 0.125;
        }

        // A knot on a shaft with its own sizing rule live-tracks it at the exact
        // slide T. Types without a rule keep the segment diameter above.
        if (hostsRealSegments(host.containerType) && host.entity) {
            const ruled = resolveKnotDiameter(
                host.containerType as SupportTypeId, host.entity, host.segmentId, t,
            );
            if (ruled !== null) finalKnot.diameter = ruled;
        }

        if (!lastAppliedKnotPosRef.current) {
            lastAppliedKnotPosRef.current = finalOnLine.clone();
        } else {
            lastAppliedKnotPosRef.current.copy(finalOnLine);
        }

        const updatedBranchIds = Object.keys(branchSegmentsById);
        if (updatedBranchIds.length > 0) {
            const nextPreviewBranchSegmentsById = { ...previewBranchSegmentsByIdRef.current };

            for (const branchId of updatedBranchIds) {
                const nextSegments = branchSegmentsById[branchId];
                const committedBranch = getSupportEntity('branch', branchId) as Branch | null;
                if (committedBranch && committedBranch.segments === nextSegments) {
                    delete nextPreviewBranchSegmentsById[branchId];
                } else {
                    nextPreviewBranchSegmentsById[branchId] = nextSegments;
                }
            }

            previewBranchSegmentsByIdRef.current = nextPreviewBranchSegmentsById;
        }
        previewKnotRef.current = finalKnot;

        const prevKnot = lastEmittedKnotPreviewPosRef.current;
        const nextKnotPos = finalKnot.pos;
        const sameKnotPos = !!prevKnot
            && Math.abs(prevKnot.x - nextKnotPos.x) < MIN_DRAG_DELTA_SQ
            && Math.abs(prevKnot.y - nextKnotPos.y) < MIN_DRAG_DELTA_SQ
            && Math.abs(prevKnot.z - nextKnotPos.z) < MIN_DRAG_DELTA_SQ;
        if (!sameKnotPos || lastEmittedBranchPreviewRef.current !== previewBranchSegmentsByIdRef.current) {
            lastEmittedKnotPreviewPosRef.current = { ...nextKnotPos };
            lastEmittedBranchPreviewRef.current = previewBranchSegmentsByIdRef.current;
            emitKnotDragPreview({
                knotId: finalKnot.id,
                knot: finalKnot,
                branchSegmentsById: previewBranchSegmentsByIdRef.current,
            });
        }
    });
}
