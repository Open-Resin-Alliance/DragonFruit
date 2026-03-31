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
import { ElasticChainInitialState, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getFinalSocketPosition, getSocketPosition } from '../ContactCone';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getBezierPointAtT } from '../../Curves/BezierUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

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
    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer } = useThree();

    const activeKnotId = useRef<string | null>(null);
    const activeHost = useRef<ActiveHost | null>(null);
    const forceEndDragRef = useRef(false);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);

    const leafClampWarningTimeout = useRef<number | null>(null);

    // Store initial state of all attached branches for elastic drag
    const elasticState = useRef<Record<string, ElasticChainInitialState>>({});

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
    const captureElasticState = (knotId: string) => {
        const allBranches = getBranches();
        const attached = allBranches.filter(b => b.parentKnotId === knotId);
        const state: Record<string, ElasticChainInitialState> = {};

        console.log('[ElasticChain] Capturing state for knot:', knotId);
        console.log('[ElasticChain] Attached branches:', attached.length);

        for (const b of attached) {
            const joints: { id: string; pos: { x: number, y: number, z: number } }[] = [];

            // Traverse segments to collect joints
            console.log('[ElasticChain] Branch', b.id, 'has', b.segments.length, 'segments');

            for (let i = 0; i < b.segments.length; i++) {
                const seg = b.segments[i];
                // Try to find the joint at the top of this segment
                let joint = seg.topJoint;

                // If not found, check the bottom of the NEXT segment (redundancy)
                if (!joint && i < b.segments.length - 1) {
                    joint = b.segments[i + 1].bottomJoint;
                }

                if (joint) {
                    console.log('[ElasticChain] Found joint:', joint.id, 'at Z:', joint.pos.z);
                    joints.push({
                        id: joint.id,
                        pos: { ...joint.pos }
                    });
                }
            }

            const knotPos = getKnotById(knotId)?.pos || { x: 0, y: 0, z: 0 };
            console.log('[ElasticChain] Knot pos:', knotPos);
            console.log('[ElasticChain] Total joints captured:', joints.length);

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

        elasticState.current = state;
    };

    useEffect(() => {
        if (!enabled && !activeKnotId.current) return;

        if (enabled && isDragging && hit.category === 'knot' && hit.objectId && !activeKnotId.current) {
            console.log('[useKnotInteraction] Starting knot drag!');
            const knot = getKnotById(hit.objectId);
            if (!knot) {
                console.log('[useKnotInteraction] Knot not found for id:', hit.objectId);
                return;
            }
            const host = findHost(knot);
            if (!host) {
                console.log('[useKnotInteraction] Host not found for knot');
                return;
            }
            resolveEndpoints(host);
            activeKnotId.current = knot.id;
            activeHost.current = host;
            initialEditSnapshotRef.current = captureSupportEditSnapshot();
            setKnotDragInteractionLock(true);

            // Capture State
            captureElasticState(knot.id);
        }

        const shouldEndDrag = (!isDragging || forceEndDragRef.current) && !!activeKnotId.current;

        if (shouldEndDrag) {
            console.log('[useKnotInteraction] Drag ended, clearing state');

            if (activeHost.current && initialEditSnapshotRef.current) {
                const description =
                    activeHost.current.containerType === 'leafCone'
                        ? 'Move tip knot'
                        : activeHost.current.containerType === 'brace'
                            ? 'Move brace knot'
                            : activeHost.current.containerType === 'kickstand'
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

            if (leafClampWarningTimeout.current) {
                window.clearTimeout(leafClampWarningTimeout.current);
                leafClampWarningTimeout.current = null;
            }
            setInteractionWarning(null);
        }
    }, [isDragging, hit, enabled, setKnotDragInteractionLock]);

    useFrame(() => {
        if (!activeKnotId.current || !activeHost.current) return;

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
            const finalOnLine = host.start.clone().add(lineVec.multiplyScalar(t));

            const contactDia = cone.profile?.contactDiameterMm ?? 0.4;
            const bodyDia = cone.profile?.bodyDiameterMm ?? 1.2;
            const hostDia = THREE.MathUtils.lerp(contactDia, bodyDia, t);

            const finalKnot: Knot = {
                ...knot,
                pos: { x: finalOnLine.x, y: finalOnLine.y, z: finalOnLine.z },
                t,
                diameter: hostDia + 0.1,
            };

            updateKnot(finalKnot);
            return;
        }

        raycaster.setFromCamera(pointer, camera);

        // Allow cross-segment dragging: choose the best segment in this trunk/branch.
        const candidates = getHostCandidates(host);
        let bestSegmentId = host.segmentId;
        let bestDiameter = 1.2;
        let bestPoint = projectOntoSegment(raycaster.ray, host.start, host.end).point;
        let bestT = projectOntoSegment(raycaster.ray, host.start, host.end).t;
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
                        const proj = projectOntoBezierCurve(raycaster.ray, c.start, c.end, c.bezier.control1, c.bezier.control2, 60);
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
                        const proj = projectOntoBezierCurve(raycaster.ray, current.start, current.end, current.bezier.control1, current.bezier.control2, 60);
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
        let constrainedPos = solveKnotConstraint(knot, result.point, maxAngleDeg, host.initialTopology, elasticBranchIds);

        // 1b. Leaf Constraint (if this knot owns a Leaf)
        // Prevent dragging past the same 10° from horizontal rule that placement enforces.
        const attemptedPos = constrainedPos;
        const tDesired = computeTOnHost(constrainedPos, host);
        const tCurrent = computeTOnHost(knot.pos, host);
        const leafClamp = clampTToLeafAngleConstraints(tDesired, tCurrent, host, maxAngleDeg);
        if (leafClamp.clamped) {
            const dir = new THREE.Vector3().subVectors(host.end, host.start);
            const newPos = host.start.clone().add(dir.multiplyScalar(leafClamp.t));
            constrainedPos = { x: newPos.x, y: newPos.y, z: newPos.z };

            const epsilonZ = 0.0001;
            if (attemptedPos.z > constrainedPos.z + epsilonZ) {
                showLeafClampWarning();
            }
        }

        // 2. Elastic Chain Logic
        // We run the solver for ALL attached branches.
        // If any branch is 'locked' (requires clamping), we clamp the Knot position.

        let minAllowedZ = Number.POSITIVE_INFINITY;
        let requiresClamping = false;

        // First Pass: Check constraints
        for (const branchId in elasticState.current) {
            const state = elasticState.current[branchId];
            const res = solveElasticChain(constrainedPos, state, maxAngleDeg);

            if (res.isLocked) {
                requiresClamping = true;
                if (res.knotPos.z < minAllowedZ) {
                    minAllowedZ = res.knotPos.z;
                }
            }
        }

        // If we hit a limit, apply it
        if (requiresClamping && minAllowedZ !== Number.POSITIVE_INFINITY) {
            // Apply Z Clamp
            // If dragging UP (usually), we cap the Max Z.
            // NOTE: solveElasticChain returns the clamped value in res.knotPos.z
            // If the user drags 'too high', the solver says 'here is the max Z'.
            // So we take the MINIMUM of all MaxZs (most restrictive limit).
            // (Assuming dragging UP increases Z. If dragging DOWN, logic might differ but 'pulling down' usually safe)

            if (constrainedPos.z > minAllowedZ) {
                // We need to move constrainedPos to have Z = minAllowedZ while staying on shaft.
                const dir = new THREE.Vector3().subVectors(host.end, host.start);
                if (Math.abs(dir.z) > 0.001) {
                    const t = (minAllowedZ - host.start.z) / dir.z;
                    const newPos = host.start.clone().add(dir.multiplyScalar(t));
                    constrainedPos = { x: newPos.x, y: newPos.y, z: newPos.z };
                } else {
                    constrainedPos = { ...constrainedPos, z: minAllowedZ };
                }
            }
        }

        // 3. Final Pass: Apply Final Knot Pos to get Joint positions and Update Branches
        // Use the MOST RESTRICTIVE knotPos from all solvers
        let finalKnotPos = constrainedPos;

        for (const branchId in elasticState.current) {
            const state = elasticState.current[branchId];
            const res = solveElasticChain(finalKnotPos, state, maxAngleDeg);

            // If this solver clamped the knot, use the clamped position
            if (res.isLocked && res.knotPos.z < finalKnotPos.z) {
                finalKnotPos = res.knotPos;
            }

            // Update branch joints
            const branch = getBranchById(branchId);
            if (!branch) continue;

            let branchChanged = false;

            // Map segments to new joint positions
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
                console.log('[Elastic] Updating branch joints:', {
                    branchId: branchId.slice(0, 8),
                    numSegments: newSegments.length,
                    jointPositions: Object.keys(res.jointPositions).map(id => ({
                        id: id.slice(0, 8),
                        z: res.jointPositions[id].z.toFixed(2)
                    }))
                });
                updateBranch({ ...branch, segments: newSegments });
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

        let finalOnLine = host.start.clone().add(lineVec.clone().multiplyScalar(t));

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
                finalOnLine = bp;

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
                        60,
                    );
                    t = proj.t;
                    finalOnLine = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
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
                        60,
                    );
                    t = proj.t;
                    finalOnLine = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
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
                        60,
                    );
                    t = proj.t;
                    finalOnLine = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
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
                        60,
                    );
                    t = proj.t;
                    finalOnLine = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
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
                        60,
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

        updateKnot(finalKnot);
    });
}
