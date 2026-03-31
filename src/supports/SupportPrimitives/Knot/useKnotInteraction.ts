import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { getBranches, getKnotById, getLeaves, getRootById, getTrunks, getTwigs, getSticks, getBraces, setInteractionWarning, updateKnot, updateBranch, getBranchById, subscribe } from '../../state';
import { Branch, Brace, Knot, Roots, Trunk, Twig, Stick, Vec3 } from '../../types';
import { getKickstandSnapshot } from '../../SupportTypes/Kickstand/kickstandStore';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { getBranchSegmentEndpoints, getTrunkSegmentEndpoints, projectOntoSegment } from './knotUtils';
import { getSettings } from '../../Settings';
import { solveKnotConstraint } from '../../PlacementLogic/JointConstraintSolver';
import { ElasticChainInitialState, ElasticChainResult, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getFinalSocketPosition, getSocketPosition } from '../ContactCone';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getBezierPointAtT } from '../../Curves/BezierUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearKnotDragPreview, emitKnotDragPreview } from '../../interaction/knotDragPreview';

interface ActiveHost {
    segmentId: string;
    containerType: 'trunk' | 'branch' | 'twig' | 'stick' | 'leafCone' | 'brace' | 'kickstand';
    trunk?: Trunk;
    branch?: Branch;
    twig?: Twig;
    stick?: Stick;
    root?: Roots;
    parentKnot?: Knot;
    leafId?: string;
    brace?: Brace;
    kickstand?: Kickstand;
    kickstandRoot?: Roots;
    kickstandHostKnot?: Knot;
    start: THREE.Vector3;
    end: THREE.Vector3;
    // Topology Map: BranchID -> 'UP' (Knot Z < Joint Z) or 'DOWN' (Knot Z > Joint Z)
    initialTopology: Record<string, 'UP' | 'DOWN'>;
}

export function useKnotInteraction(enabled: boolean = true) {
    const MIN_DRAG_DELTA_SQ = 1e-6; // ~0.001mm epsilon to drop high-frequency jitter churn
    const BEZIER_PROJECTION_STEPS = 36;
    const FAST_KNOT_DRAG_ELASTIC_PREVIEW = true;
    const DRAG_SNAP_MM = 0.001;

    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer } = useThree();

    const activeKnotId = useRef<string | null>(null);
    const activeHost = useRef<ActiveHost | null>(null);
    const forceEndDragRef = useRef(false);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);

    const leafClampWarningTimeout = useRef<number | null>(null);

    // Store initial state of all attached branches for elastic drag
    const elasticState = useRef<Record<string, ElasticChainInitialState>>({});
    const prewarmedKnotIdRef = useRef<string | null>(null);
    const prewarmedHostRef = useRef<ActiveHost | null>(null);
    const prewarmedElasticStateRef = useRef<Record<string, ElasticChainInitialState> | null>(null);
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

    // Segment→host lookup cache: rebuilt whenever support state changes
    type SegmentHostEntry = { containerType: 'trunk'; entityId: string } | { containerType: 'branch'; entityId: string } | { containerType: 'kickstand'; entityId: string } | { containerType: 'twig'; entityId: string } | { containerType: 'stick'; entityId: string };
    const segmentHostMapRef = useRef<Map<string, SegmentHostEntry>>(new Map());

    useEffect(() => {
        const buildMap = () => {
            const map = new Map<string, SegmentHostEntry>();
            for (const trunk of getTrunks()) {
                for (const seg of trunk.segments) map.set(seg.id, { containerType: 'trunk', entityId: trunk.id });
            }
            for (const branch of getBranches()) {
                for (const seg of branch.segments) map.set(seg.id, { containerType: 'branch', entityId: branch.id });
            }
            for (const kickstand of Object.values(getKickstandSnapshot().kickstands)) {
                for (const seg of kickstand.segments) map.set(seg.id, { containerType: 'kickstand', entityId: kickstand.id });
            }
            for (const twig of getTwigs()) {
                for (const seg of twig.segments) map.set(seg.id, { containerType: 'twig', entityId: twig.id });
            }
            for (const stick of getSticks()) {
                for (const seg of stick.segments) map.set(seg.id, { containerType: 'stick', entityId: stick.id });
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
        const leaves = getLeaves().filter(l => l.parentKnotId === activeKnotId.current);
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

    const findHost = (knot: Knot): ActiveHost | null => {
        let host: ActiveHost | null = null;

        // Leaf cone host (brace endpoints)
        if (knot.parentShaftId.startsWith('leafCone:')) {
            const leafId = knot.parentShaftId.slice('leafCone:'.length);
            const leaf = getLeaves().find(l => l.id === leafId);
            if (leaf?.contactCone) {
                host = {
                    segmentId: knot.parentShaftId,
                    containerType: 'leafCone',
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
            const brace = getBraces().find(b => b.id === braceId);
            if (brace) {
                host = {
                    segmentId: knot.parentShaftId,
                    containerType: 'brace',
                    brace,
                    start: new THREE.Vector3(),
                    end: new THREE.Vector3(),
                    initialTopology: {},
                };
                return host;
            }
        }
        const cacheEntry = segmentHostMapRef.current.get(knot.parentShaftId);
        if (cacheEntry) {
            if (cacheEntry.containerType === 'trunk') {
                const trunk = getTrunks().find(t => t.id === cacheEntry.entityId);
                if (trunk) {
                    const root = getRootById(trunk.rootId) || undefined;
                    host = { segmentId: knot.parentShaftId, containerType: 'trunk', trunk, root, start: new THREE.Vector3(), end: new THREE.Vector3(), initialTopology: {} };
                }
            } else if (cacheEntry.containerType === 'branch') {
                const branch = getBranches().find(b => b.id === cacheEntry.entityId);
                if (branch) {
                    const parentKnot = getKnotById(branch.parentKnotId) || undefined;
                    host = { segmentId: knot.parentShaftId, containerType: 'branch', branch, parentKnot, start: new THREE.Vector3(), end: new THREE.Vector3(), initialTopology: {} };
                }
            } else if (cacheEntry.containerType === 'kickstand') {
                const kickstandState = getKickstandSnapshot();
                const kickstand = kickstandState.kickstands[cacheEntry.entityId];
                if (kickstand) {
                    const kickstandRoot = kickstandState.roots[kickstand.rootId];
                    const kickstandHostKnot = kickstandState.knots[kickstand.hostKnotId];
                    if (kickstandRoot && kickstandHostKnot) {
                        host = { segmentId: knot.parentShaftId, containerType: 'kickstand', kickstand, kickstandRoot, kickstandHostKnot, start: new THREE.Vector3(), end: new THREE.Vector3(), initialTopology: {} };
                    }
                }
            } else if (cacheEntry.containerType === 'twig') {
                const twig = getTwigs().find(t => t.id === cacheEntry.entityId);
                if (twig) {
                    host = { segmentId: knot.parentShaftId, containerType: 'twig', twig, start: new THREE.Vector3(), end: new THREE.Vector3(), initialTopology: {} };
                }
            } else if (cacheEntry.containerType === 'stick') {
                const stick = getSticks().find(s => s.id === cacheEntry.entityId);
                if (stick) {
                    host = { segmentId: knot.parentShaftId, containerType: 'stick', stick, start: new THREE.Vector3(), end: new THREE.Vector3(), initialTopology: {} };
                }
            }
        }

        if (!host) {
            // Fallback: stale cache — should not happen in normal use
            const sticks = getSticks();
            for (const stick of sticks) {
                const idx = stick.segments.findIndex((s) => s.id === knot.parentShaftId);
                if (idx !== -1) {
                    host = {
                        segmentId: knot.parentShaftId,
                        containerType: 'stick',
                        stick,
                        start: new THREE.Vector3(),
                        end: new THREE.Vector3(),
                        initialTopology: {}
                    };
                    break;
                }
            }
        }

        if (host) {
            // Determine Initial Topology
            const allBranches = getBranches();
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

    const resolveEndpoints = (host: ActiveHost) => {
        if (host.containerType === 'trunk' && host.trunk && host.root) {
            const idx = host.trunk.segments.findIndex((s) => s.id === host.segmentId);
            const seg = host.trunk.segments[idx];
            const endpoints = getTrunkSegmentEndpoints(host.trunk, seg, idx, host.root);
            if (endpoints) {
                host.start.set(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                host.end.set(endpoints.end.x, endpoints.end.y, endpoints.end.z);
            }
        } else if (host.containerType === 'branch' && host.branch && host.parentKnot) {
            const idx = host.branch.segments.findIndex((s) => s.id === host.segmentId);
            const seg = host.branch.segments[idx];
            const endpoints = getBranchSegmentEndpoints(host.branch, seg, idx, host.parentKnot);
            if (endpoints) {
                host.start.set(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                host.end.set(endpoints.end.x, endpoints.end.y, endpoints.end.z);
            }
        } else if (host.containerType === 'twig' && host.twig) {
            const seg = host.twig.segments.find((s) => s.id === host.segmentId);
            if (!seg?.bottomJoint || !seg?.topJoint) return;
            host.start.set(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
            host.end.set(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (host.containerType === 'stick' && host.stick) {
            const seg = host.stick.segments.find((s) => s.id === host.segmentId);
            if (!seg?.bottomJoint || !seg?.topJoint) return;
            host.start.set(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
            host.end.set(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (host.containerType === 'leafCone' && host.leafId) {
            const leaf = getLeaves().find(l => l.id === host.leafId);
            const cone = leaf?.contactCone;
            if (!cone) return;

            const socketPos = getFinalSocketPosition(cone);
            const axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z).normalize();
            const len = cone.profile?.lengthMm ?? 0;

            const endVec = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
            const startVec = endVec.clone().add(axis.multiplyScalar(-len));

            host.start.copy(startVec);
            host.end.copy(endVec);
        } else if (host.containerType === 'brace' && host.brace) {
            const startKnot = getKnotById(host.brace.startKnotId);
            const endKnot = getKnotById(host.brace.endKnotId);
            if (!startKnot || !endKnot) return;
            host.start.set(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z);
            host.end.set(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z);
        } else if (host.containerType === 'kickstand' && host.kickstand && host.kickstandRoot && host.kickstandHostKnot) {
            const segIdx = host.kickstand.segments.findIndex((s) => s.id === host.segmentId);
            if (segIdx === -1) return;

            const rootTopZ = host.kickstandRoot.transform.pos.z + host.kickstandRoot.diskHeight + host.kickstandRoot.coneHeight;

            let startPos: Vec3;
            if (segIdx === 0) {
                startPos = {
                    x: host.kickstandRoot.transform.pos.x,
                    y: host.kickstandRoot.transform.pos.y,
                    z: rootTopZ,
                };
            } else {
                const prevSeg = host.kickstand.segments[segIdx - 1];
                if (!prevSeg.topJoint) return;
                startPos = prevSeg.topJoint.pos;
            }

            const seg = host.kickstand.segments[segIdx];
            const endPos = seg.topJoint?.pos ?? host.kickstandHostKnot.pos;

            host.start.set(startPos.x, startPos.y, startPos.z);
            host.end.set(endPos.x, endPos.y, endPos.z);
        }
    };

    const getHostCandidates = (host: ActiveHost): Array<{ segmentId: string; start: THREE.Vector3; end: THREE.Vector3; diameter: number; bezier?: { control1: Vec3; control2: Vec3 } }> => {
        const out: Array<{ segmentId: string; start: THREE.Vector3; end: THREE.Vector3; diameter: number; bezier?: { control1: Vec3; control2: Vec3 } }> = [];

        if (host.containerType === 'trunk' && host.trunk && host.root) {
            for (let idx = 0; idx < host.trunk.segments.length; idx++) {
                const seg = host.trunk.segments[idx];
                const endpoints = getTrunkSegmentEndpoints(host.trunk, seg, idx, host.root);
                if (!endpoints) continue;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z),
                    end: new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                });
            }
        } else if (host.containerType === 'branch' && host.branch && host.parentKnot) {
            for (let idx = 0; idx < host.branch.segments.length; idx++) {
                const seg = host.branch.segments[idx];
                const endpoints = getBranchSegmentEndpoints(host.branch, seg, idx, host.parentKnot);
                if (!endpoints) continue;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z),
                    end: new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                });
            }
        } else if (host.containerType === 'twig' && host.twig) {
            for (let idx = 0; idx < host.twig.segments.length; idx++) {
                const seg = host.twig.segments[idx];
                if (!seg.bottomJoint || !seg.topJoint) continue;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z),
                    end: new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                });
            }
        } else if (host.containerType === 'stick' && host.stick) {
            for (let idx = 0; idx < host.stick.segments.length; idx++) {
                const seg = host.stick.segments[idx];
                if (!seg.bottomJoint || !seg.topJoint) continue;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z),
                    end: new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
                });
            }
        } else if (host.containerType === 'brace' && host.brace) {
            const startKnot = getKnotById(host.brace.startKnotId);
            const endKnot = getKnotById(host.brace.endKnotId);
            if (startKnot && endKnot) {
                out.push({
                    segmentId: host.segmentId,
                    start: new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z),
                    end: new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z),
                    diameter: host.brace.profile.diameter,
                });
            }
        } else if (host.containerType === 'kickstand' && host.kickstand && host.kickstandRoot && host.kickstandHostKnot) {
            const rootTopZ = host.kickstandRoot.transform.pos.z + host.kickstandRoot.diskHeight + host.kickstandRoot.coneHeight;

            for (let idx = 0; idx < host.kickstand.segments.length; idx++) {
                const seg = host.kickstand.segments[idx];

                let startPos: Vec3;
                if (idx === 0) {
                    startPos = {
                        x: host.kickstandRoot.transform.pos.x,
                        y: host.kickstandRoot.transform.pos.y,
                        z: rootTopZ,
                    };
                } else {
                    const prevSeg = host.kickstand.segments[idx - 1];
                    if (!prevSeg.topJoint) continue;
                    startPos = prevSeg.topJoint.pos;
                }

                const endPos = seg.topJoint?.pos ?? host.kickstandHostKnot.pos;
                out.push({
                    segmentId: seg.id,
                    start: new THREE.Vector3(startPos.x, startPos.y, startPos.z),
                    end: new THREE.Vector3(endPos.x, endPos.y, endPos.z),
                    diameter: seg.diameter,
                    bezier: seg.type === 'bezier' ? { control1: seg.controlPoint1, control2: seg.controlPoint2 } : undefined,
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
        const allBranches = getBranches();
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
        if (prewarmedKnotIdRef.current === knotId && prewarmedHostRef.current && prewarmedElasticStateRef.current) {
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
    }, [enabled, isDragging, hit.category, hit.objectId]);

    useEffect(() => {
        if (!enabled && !activeKnotId.current) return;

        if (enabled && isDragging && hit.category === 'knot' && hit.objectId && !activeKnotId.current) {
            const knot = getKnotById(hit.objectId);
            if (!knot) {
                return;
            }
            const host = prewarmedKnotIdRef.current === knot.id && prewarmedHostRef.current
                ? prewarmedHostRef.current
                : findHost(knot);
            if (!host) {
                return;
            }
            resolveEndpoints(host);
            activeKnotId.current = knot.id;
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
            elasticState.current = prewarmedKnotIdRef.current === knot.id && prewarmedElasticStateRef.current
                ? prewarmedElasticStateRef.current
                : captureElasticState(knot.id);

            prewarmedKnotIdRef.current = null;
            prewarmedHostRef.current = null;
            prewarmedElasticStateRef.current = null;
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

                    const branch = getBranchById(branchId);
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
                const branch = getBranchById(branchId);
                if (branch) {
                    updateBranch({ ...branch, segments: previewSegments });
                }
            }

            if (previewKnotAtEnd && previewKnotAtEnd.id === activeKnotIdAtEnd) {
                updateKnot(previewKnotAtEnd);
            } else if (activeKnotIdAtEnd) {
                const knotAtEnd = getKnotById(activeKnotIdAtEnd);
                if (knotAtEnd) updateKnot(knotAtEnd);
            }

            if (activeHostAtEnd && initialEditSnapshotRef.current) {
                const description =
                    activeHostAtEnd.containerType === 'leafCone'
                        ? 'Move tip knot'
                        : activeHostAtEnd.containerType === 'brace'
                            ? 'Move brace knot'
                            : activeHostAtEnd.containerType === 'kickstand'
                                ? 'Move kickstand host knot'
                                : 'Move support knot';
                pushSupportEditHistory(description, initialEditSnapshotRef.current, captureSupportEditSnapshot());
            }

            activeKnotId.current = null;
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

            const leaf = getLeaves().find(l => l.id === host.leafId);
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

        if (host.containerType === 'brace' && host.brace?.curve?.type === 'bezier') {
            const startKnot = getKnotById(host.brace.startKnotId);
            const endKnot = getKnotById(host.brace.endKnotId);
            if (startKnot && endKnot) {
                const STEPS = 40;
                let best = Infinity;
                let bt = 0;
                let bp = new THREE.Vector3();
                for (let i = 0; i <= STEPS; i++) {
                    const t = i / STEPS;
                    const p = getBezierPointAtT(
                        startKnot.pos,
                        host.brace.curve.controlPoint1,
                        host.brace.curve.controlPoint2,
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

                // Prefer staying on the current segment if distances are extremely close (reduce flicker at joints)
                const current = candidates.find(c => c.segmentId === host.segmentId);
                if (current) {
                    if (current.bezier) {
                        const proj = projectOntoBezierCurve(raycaster.ray, current.start, current.end, current.bezier.control1, current.bezier.control2, BEZIER_PROJECTION_STEPS);
                        if (proj.distSq <= bestDistSq * 1.05) {
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
                        if (currentDistSq <= bestDistSq * 1.05) {
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
            const brace = getBraces().find(b => b.id === braceId);
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
                const branch = getBranchById(branchId);
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

                const branch = getBranchById(branchId);
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
        if (host.containerType === 'brace' && host.brace?.curve?.type === 'bezier') {
            const startKnot = getKnotById(host.brace.startKnotId);
            const endKnot = getKnotById(host.brace.endKnotId);
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
                        host.brace.curve.controlPoint1,
                        host.brace.curve.controlPoint2,
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
                    (startKnot.diameter ?? (host.brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                );
                const endDia = Math.max(
                    0.001,
                    (endKnot.diameter ?? (host.brace.profile.diameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM
                );
                bestDiameter = THREE.MathUtils.lerp(startDia, endDia, t);
            }
        }

        if (host.containerType === 'trunk') {
            if (host.trunk && host.root) {
                const seg = host.trunk.segments.find(s => s.id === host.segmentId);
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
        } else if (host.containerType === 'branch') {
            if (host.branch && host.parentKnot) {
                const seg = host.branch.segments.find(s => s.id === host.segmentId);
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
        } else if (host.containerType === 'twig') {
            if (host.twig) {
                const seg = host.twig.segments.find(s => s.id === host.segmentId);
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
        } else if (host.containerType === 'stick') {
            if (host.stick) {
                const seg = host.stick.segments.find(s => s.id === host.segmentId);
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
        } else if (host.containerType === 'kickstand') {
            if (host.kickstand) {
                const seg = host.kickstand.segments.find(s => s.id === host.segmentId);
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
                    finalOnLine = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
                    bestDiameter = seg.diameter;
                }
            }
        }

        // Update Knot
        const finalKnot: Knot = {
            ...knot,
            parentShaftId: host.segmentId,
            pos: { x: finalOnLine.x, y: finalOnLine.y, z: finalOnLine.z },
            t: t
        };

        // Update diameter when crossing into a segment with a different diameter
        if (host.containerType === 'trunk' || host.containerType === 'branch' || host.containerType === 'twig' || host.containerType === 'stick' || host.containerType === 'brace' || host.containerType === 'kickstand') {
            finalKnot.diameter = bestDiameter + 0.1;
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
                const committedBranch = getBranchById(branchId);
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
