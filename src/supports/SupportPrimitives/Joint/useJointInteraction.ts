import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import {
    getTrunks,
    getBranches,
    getTwigs,
    getSticks,
    getSelectedId,
    getTrunkById,
    getRootById,
    getBranchById,
    getTwigById,
    getStickById,
    getKnotById,
    setInteractionWarning,
    updateTwig,
    updateStick,
} from '../../state';
import { getTrunkSegmentEndpoints } from '../Knot/knotUtils';
import { Vec3, Trunk, Branch, Roots, Twig, Stick, ContactDisk } from '../../types';
import { getKickstandSnapshot } from '../../SupportTypes/Kickstand/kickstandStore';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import {
    clearJointDragPositionPreview,
    clearSupportDragPreview,
    emitJointDragPositionPreview,
    emitSupportDragPreview,
    isJointInteractionLocked,
    setJointInteractionLock,
} from './jointDragRuntime';
import { commitJointDragSupport, computeJointDragSupportPreview, publishJointDragSupportPreview } from './jointDragController';
import { subscribeSupportInteractionReset } from '../../interaction/supportInteractionReset';

/**
 * Hook to handle joint interaction (dragging/moving).
 * Must be used inside a Canvas/R3F context.
 * 
 * Usage: Call this hook once in your main scene component (e.g. SupportRenderer).
 * It monitors the picking state and handles drag operations for any 'joint' object.
 */
export function useJointInteraction(enabled: boolean = true) {
    const MIN_DRAG_DELTA_SQ = 1e-6; // ~0.001mm positional epsilon to drop high-frequency jitter churn
    const MIN_PUBLISHED_CLAMPED_DELTA_SQ = 1e-8;
    const DRAG_SNAP_MM = 0.001;
    const WARNING_DISTANCE_THRESHOLD = 0.05; // mm
    const WARNING_EVAL_INTERVAL_MS = 48; // ~20Hz warning updates during drag
    const JOINT_PARENT_CACHE_MAX_ENTRIES = 12000;

    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer, controls } = useThree();

    const activeJointId = useRef<string | null>(null);
    const activeTrunkId = useRef<string | null>(null);
    const activeBranchId = useRef<string | null>(null);
    const activeKickstandId = useRef<string | null>(null);
    const activeTwigId = useRef<string | null>(null);
    const activeStickId = useRef<string | null>(null);
    const dragPlane = useRef<THREE.Plane>(new THREE.Plane());
    const dragOffset = useRef<THREE.Vector3>(new THREE.Vector3());
    const planeIntersectionRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const lastDragPos = useRef<Vec3 | null>(null);
    const forceEndDragRef = useRef(false);
    const initialTrunkSnapshot = useRef<Trunk | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const lastAppliedDragPosRef = useRef<THREE.Vector3 | null>(null);
    const liveTrunkPreviewRef = useRef<Trunk | null>(null);
    const liveBranchPreviewRef = useRef<Branch | null>(null);
    const liveTwigPreviewRef = useRef<Twig | null>(null);
    const liveStickPreviewRef = useRef<Stick | null>(null);
    const lastResolvedJointPosRef = useRef<Vec3 | null>(null);
    const lastPublishedClampedJointPosRef = useRef<Vec3 | null>(null);
    const lastWarningRef = useRef<string | null>(null);
    const lastWarningEvalAtRef = useRef(0);
    const jointParentCacheRef = useRef<Map<string, { kind: 'trunk' | 'branch' | 'twig' | 'stick' | 'kickstand'; supportId: string }>>(new Map());
    const activeJointBindingRef = useRef<{ jointId: string; segmentIndex: number; jointKey: 'topJoint' | 'bottomJoint' } | null>(null);
    const jointDragUpdatePendingRef = useRef(false);
    const jointDragListenersAttachedRef = useRef(false);
    const activeConstraintRootRef = useRef<Roots | undefined>(undefined);
    const activeConstraintStartRef = useRef<Vec3 | undefined>(undefined);
    const dragGestureSelectionAtStartRef = useRef<string | null>(null);
    const wasDraggingRef = useRef(false);
    const lastEmittedPreviewJointPosRef = useRef<Vec3 | null>(null);

    const savedControlsEnabledRef = useRef<boolean | null>(null);

    const cloneTrunk = (trunk: Trunk): Trunk => JSON.parse(JSON.stringify(trunk));

    const updateSegmentsJointPos = useCallback((segments: any[], jointId: string, pos: Vec3) => {
        return segments.map((seg) => {
            let changed = false;
            let topJoint = seg.topJoint;
            let bottomJoint = seg.bottomJoint;

            if (topJoint?.id === jointId) {
                topJoint = { ...topJoint, pos };
                changed = true;
            }
            if (bottomJoint?.id === jointId) {
                bottomJoint = { ...bottomJoint, pos };
                changed = true;
            }

            return changed ? { ...seg, topJoint, bottomJoint } : seg;
        });
    }, []);

    const recomputeConeForSocket = useCallback((cone: any, socketPos: { x: number; y: number; z: number }) => {
        const effectiveSurfaceNormal = cone.surfaceNormal || cone.normal;
        let axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
        if (axis.lengthSq() < 0.000001) axis.set(0, 0, 1);
        axis.normalize();

        let offset = 0;
        if (cone.profile?.type === 'disk') {
            if (cone.diskLengthOverride !== undefined) {
                offset = cone.diskLengthOverride;
            } else {
                offset = calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
            }
        }

        const contactPos = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
        const sn = new THREE.Vector3(effectiveSurfaceNormal.x, effectiveSurfaceNormal.y, effectiveSurfaceNormal.z);
        const socket = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);

        let startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
        for (let i = 0; i < 3; i += 1) {
            const v = socket.clone().sub(startPos);
            if (v.length() > 0.0001) {
                axis = v.clone().normalize();
            }
            if (cone.profile?.type === 'disk' && cone.diskLengthOverride === undefined) {
                offset = calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
                startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
            }
        }

        const finalStart = contactPos.clone().add(sn.clone().multiplyScalar(offset));
        const lengthMm = Math.max(0.1, socket.distanceTo(finalStart));

        return {
            ...cone,
            normal: { x: axis.x, y: axis.y, z: axis.z },
            profile: {
                ...cone.profile,
                lengthMm,
            },
        };
    }, []);

    const getTwigDiskTipCenter = useCallback((disk: ContactDisk) => {
        const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
        return {
            x: disk.pos.x + disk.surfaceNormal.x * thickness,
            y: disk.pos.y + disk.surfaceNormal.y * thickness,
            z: disk.pos.z + disk.surfaceNormal.z * thickness,
        };
    }, []);

    const recomputeTwigDiskForSocket = useCallback((
        disk: ContactDisk,
        desiredSocketPos: { x: number; y: number; z: number },
        axisHint?: THREE.Vector3,
    ) => {
        const contactPos = new THREE.Vector3(disk.pos.x, disk.pos.y, disk.pos.z);
        const desiredSocket = new THREE.Vector3(desiredSocketPos.x, desiredSocketPos.y, desiredSocketPos.z);
        const contactToDesiredSocket = desiredSocket.clone().sub(contactPos);

        let surfaceNormal = contactToDesiredSocket.clone();
        if (surfaceNormal.lengthSq() < 0.000001) {
            surfaceNormal = new THREE.Vector3(disk.surfaceNormal.x, disk.surfaceNormal.y, disk.surfaceNormal.z);
        }
        if (surfaceNormal.lengthSq() < 0.000001) {
            surfaceNormal.set(0, 0, 1);
        }
        surfaceNormal.normalize();

        let axis = axisHint?.clone() ?? contactToDesiredSocket.clone();
        if (axis.lengthSq() < 0.000001) {
            axis = new THREE.Vector3(disk.coneAxis.x, disk.coneAxis.y, disk.coneAxis.z);
        }
        if (axis.lengthSq() < 0.000001) {
            axis = surfaceNormal.clone();
        }
        axis.normalize();

        const desiredDistance = contactToDesiredSocket.length();
        const fallbackThickness = disk.diskLengthOverride ?? calculateDiskThickness(
            { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
            { x: axis.x, y: axis.y, z: axis.z },
            disk.profile,
        );
        const thickness = Number.isFinite(desiredDistance) && desiredDistance > 0.000001
            ? Math.max(0.001, desiredDistance)
            : Math.max(0.001, fallbackThickness);

        const snappedSocket = contactPos.clone().add(surfaceNormal.clone().multiplyScalar(thickness));

        return {
            disk: {
                ...disk,
                pos: {
                    x: contactPos.x,
                    y: contactPos.y,
                    z: contactPos.z,
                },
                surfaceNormal: {
                    x: surfaceNormal.x,
                    y: surfaceNormal.y,
                    z: surfaceNormal.z,
                },
                coneAxis: {
                    x: axis.x,
                    y: axis.y,
                    z: axis.z,
                },
                diskLengthOverride: thickness,
            } as ContactDisk,
            socket: {
                x: snappedSocket.x,
                y: snappedSocket.y,
                z: snappedSocket.z,
            },
        };
    }, []);

    const applyInteractionWarning = useCallback((warning: 'SHAFT_ANGLE_TOO_FLAT' | null) => {
        if (lastWarningRef.current === warning) return;
        lastWarningRef.current = warning;
        setInteractionWarning(warning);
    }, []);

    const resolveJointBinding = useCallback((
        segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>,
        targetJointId: string,
    ) => {
        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index];
            if (segment.topJoint?.id === targetJointId) {
                return { jointId: targetJointId, segmentIndex: index, jointKey: 'topJoint' as const };
            }
            if (segment.bottomJoint?.id === targetJointId) {
                return { jointId: targetJointId, segmentIndex: index, jointKey: 'bottomJoint' as const };
            }
        }
        return null;
    }, []);

    const resolveJointPosById = useCallback((
        segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>,
        jointId: string,
    ): Vec3 | null => {
        const binding = activeJointBindingRef.current;
        if (binding && binding.jointId === jointId) {
            const segment = segments[binding.segmentIndex];
            const fastJoint = segment?.[binding.jointKey];
            if (fastJoint?.id === jointId) {
                return fastJoint.pos;
            }
        }

        const nextBinding = resolveJointBinding(segments, jointId);
        if (!nextBinding) {
            activeJointBindingRef.current = null;
            return null;
        }

        activeJointBindingRef.current = nextBinding;
        const segment = segments[nextBinding.segmentIndex];
        return segment?.[nextBinding.jointKey]?.pos ?? null;
    }, [resolveJointBinding]);

    const shouldPublishForClampedPos = useCallback((clampedPos: Vec3 | null) => {
        if (!clampedPos) return true;
        const prev = lastPublishedClampedJointPosRef.current;
        if (!prev) return true;

        const dx = clampedPos.x - prev.x;
        const dy = clampedPos.y - prev.y;
        const dz = clampedPos.z - prev.z;
        return (dx * dx + dy * dy + dz * dz) >= MIN_PUBLISHED_CLAMPED_DELTA_SQ;
    }, [MIN_PUBLISHED_CLAMPED_DELTA_SQ]);

    const markPublishedClampedPos = useCallback((clampedPos: Vec3 | null) => {
        if (!clampedPos) {
            lastPublishedClampedJointPosRef.current = null;
            return;
        }
        lastPublishedClampedJointPosRef.current = { x: clampedPos.x, y: clampedPos.y, z: clampedPos.z };
    }, []);

    const markJointDragUpdatePending = useCallback(() => {
        if (!activeJointId.current) return;
        jointDragUpdatePendingRef.current = true;
    }, []);

    const applyWarningForDragDelta = useCallback((clampedPos: Vec3 | null, rawPos: Vec3) => {
        if (!clampedPos) return;
        const now = performance.now();
        if (now - lastWarningEvalAtRef.current < WARNING_EVAL_INTERVAL_MS) return;
        lastWarningEvalAtRef.current = now;

        const dx = clampedPos.x - rawPos.x;
        const dy = clampedPos.y - rawPos.y;
        const dz = clampedPos.z - rawPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > WARNING_DISTANCE_THRESHOLD) {
            applyInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
        } else {
            applyInteractionWarning(null);
        }
    }, [WARNING_DISTANCE_THRESHOLD, WARNING_EVAL_INTERVAL_MS, applyInteractionWarning]);

    const hardResetInteractionSession = useCallback(() => {
        const activeJointIdAtReset = activeJointId.current;
        if (activeJointIdAtReset) {
            clearJointDragPositionPreview(activeJointIdAtReset);
        }

        if (activeTrunkId.current) {
            clearSupportDragPreview('trunk', activeTrunkId.current);
        }
        if (activeBranchId.current) {
            clearSupportDragPreview('branch', activeBranchId.current);
        }
        if (activeKickstandId.current) {
            clearSupportDragPreview('kickstand', activeKickstandId.current);
        }
        if (activeTwigId.current) {
            clearSupportDragPreview('twig', activeTwigId.current);
        }
        if (activeStickId.current) {
            clearSupportDragPreview('stick', activeStickId.current);
        }

        activeJointId.current = null;
        activeTrunkId.current = null;
        activeBranchId.current = null;
        activeKickstandId.current = null;
        activeTwigId.current = null;
        activeStickId.current = null;
        initialTrunkSnapshot.current = null;
        initialEditSnapshotRef.current = null;
        liveTrunkPreviewRef.current = null;
        liveBranchPreviewRef.current = null;
        liveTwigPreviewRef.current = null;
        liveStickPreviewRef.current = null;
        forceEndDragRef.current = false;
        lastAppliedDragPosRef.current = null;
        lastResolvedJointPosRef.current = null;
        lastPublishedClampedJointPosRef.current = null;
        lastWarningEvalAtRef.current = 0;
        activeConstraintRootRef.current = undefined;
        activeConstraintStartRef.current = undefined;
        activeJointBindingRef.current = null;
        lastDragPos.current = null;
        lastEmittedPreviewJointPosRef.current = null;
        applyInteractionWarning(null);

        if (controls && savedControlsEnabledRef.current !== null) {
            const c: any = controls;
            c.enabled = savedControlsEnabledRef.current;
            savedControlsEnabledRef.current = null;
        }

        setJointInteractionLock(false, 0);
    }, [controls, applyInteractionWarning]);

    useEffect(() => {
        if (!enabled) return;
        if (isDragging || activeJointId.current) return;
        if (hit.category !== 'joint' || !hit.objectId) return;

        if (jointParentCacheRef.current.size > JOINT_PARENT_CACHE_MAX_ENTRIES) {
            jointParentCacheRef.current.clear();
        }

        const jointId = hit.objectId;
        if (jointParentCacheRef.current.has(jointId)) return;

        const resolveJointPosFromSegments = (segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>, targetJointId: string): Vec3 | null => {
            for (const s of segments) {
                if (s.topJoint?.id === targetJointId) return s.topJoint.pos;
                if (s.bottomJoint?.id === targetJointId) return s.bottomJoint.pos;
            }
            return null;
        };

        for (const trunk of getTrunks()) {
            if (resolveJointPosFromSegments(trunk.segments as any[], jointId)) {
                jointParentCacheRef.current.set(jointId, { kind: 'trunk', supportId: trunk.id });
                return;
            }
        }

        for (const branch of getBranches()) {
            if (resolveJointPosFromSegments(branch.segments as any[], jointId)) {
                jointParentCacheRef.current.set(jointId, { kind: 'branch', supportId: branch.id });
                return;
            }
        }

        for (const kickstand of Object.values(getKickstandSnapshot().kickstands)) {
            if (resolveJointPosFromSegments(kickstand.segments as any[], jointId)) {
                jointParentCacheRef.current.set(jointId, { kind: 'kickstand', supportId: kickstand.id });
                return;
            }
        }

        for (const twig of getTwigs()) {
            if (resolveJointPosFromSegments(twig.segments as any[], jointId)) {
                jointParentCacheRef.current.set(jointId, { kind: 'twig', supportId: twig.id });
                return;
            }
        }

        for (const stick of getSticks()) {
            if (resolveJointPosFromSegments(stick.segments as any[], jointId)) {
                jointParentCacheRef.current.set(jointId, { kind: 'stick', supportId: stick.id });
                return;
            }
        }
    }, [enabled, isDragging, hit.category, hit.objectId, JOINT_PARENT_CACHE_MAX_ENTRIES]);

    useEffect(() => {
        return () => {
            hardResetInteractionSession();
        };
    }, [hardResetInteractionSession]);

    useEffect(() => {
        return subscribeSupportInteractionReset(() => {
            jointParentCacheRef.current.clear();
            hardResetInteractionSession();
        });
    }, [hardResetInteractionSession]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const markForceEndDrag = () => {
            if (!activeJointId.current) return;
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

    useEffect(() => {
        if (isDragging && !wasDraggingRef.current) {
            // Snapshot selection at pointer-drag gesture start to avoid
            // select-and-drag races starting a joint drag in the same gesture.
            dragGestureSelectionAtStartRef.current = getSelectedId();
        } else if (!isDragging) {
            dragGestureSelectionAtStartRef.current = null;
        }

        wasDraggingRef.current = isDragging;
    }, [isDragging]);

    // Monitor drag state
    useEffect(() => {
        if (!enabled && !activeJointId.current) return;

        // Start Drag
        if (enabled && !isJointInteractionLocked() && isDragging && hit.category === 'joint' && hit.objectId && !activeJointId.current) {
            const jointId = hit.objectId;

            // Find trunk/branch and joint
            let foundTrunk: Trunk | null = null;
            let foundBranch: Branch | null = null;
            let foundKickstand: Kickstand | null = null;
            let foundTwig: Twig | null = null;
            let foundStick: Stick | null = null;
            let foundJointPos: Vec3 | null = null;

            const resolveJointPosFromSegments = (segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }>, targetJointId: string): Vec3 | null => {
                for (const s of segments) {
                    if (s.topJoint?.id === targetJointId) return s.topJoint.pos;
                    if (s.bottomJoint?.id === targetJointId) return s.bottomJoint.pos;
                }
                return null;
            };

            // Fast path: resolve via last-known parent cache.
            const cachedParent = jointParentCacheRef.current.get(jointId);
            if (cachedParent) {
                if (cachedParent.kind === 'trunk') {
                    const trunk = getTrunkById(cachedParent.supportId);
                    const pos = trunk ? resolveJointPosFromSegments(trunk.segments as any[], jointId) : null;
                    if (trunk && pos) {
                        foundTrunk = trunk;
                        foundJointPos = pos;
                    } else {
                        jointParentCacheRef.current.delete(jointId);
                    }
                } else if (cachedParent.kind === 'branch') {
                    const branch = getBranchById(cachedParent.supportId);
                    const pos = branch ? resolveJointPosFromSegments(branch.segments as any[], jointId) : null;
                    if (branch && pos) {
                        foundBranch = branch;
                        foundJointPos = pos;
                    } else {
                        jointParentCacheRef.current.delete(jointId);
                    }
                } else if (cachedParent.kind === 'twig') {
                    const twig = getTwigById(cachedParent.supportId);
                    const pos = twig ? resolveJointPosFromSegments(twig.segments as any[], jointId) : null;
                    if (twig && pos) {
                        foundTwig = twig;
                        foundJointPos = pos;
                    } else {
                        jointParentCacheRef.current.delete(jointId);
                    }
                } else if (cachedParent.kind === 'stick') {
                    const stick = getStickById(cachedParent.supportId);
                    const pos = stick ? resolveJointPosFromSegments(stick.segments as any[], jointId) : null;
                    if (stick && pos) {
                        foundStick = stick;
                        foundJointPos = pos;
                    } else {
                        jointParentCacheRef.current.delete(jointId);
                    }
                } else {
                    const kickstand = getKickstandSnapshot().kickstands[cachedParent.supportId];
                    const pos = kickstand ? resolveJointPosFromSegments(kickstand.segments as any[], jointId) : null;
                    if (kickstand && pos) {
                        foundKickstand = kickstand;
                        foundJointPos = pos;
                    } else {
                        jointParentCacheRef.current.delete(jointId);
                    }
                }
            }

            // Fallback path: full scan if cache miss.
            if (!foundJointPos) {
                const trunks = getTrunks();
                const branches = getBranches();

                // Search trunks first
                for (const t of trunks) {
                    const pos = resolveJointPosFromSegments(t.segments as any[], jointId);
                    if (pos) {
                        foundTrunk = t;
                        foundJointPos = pos;
                        jointParentCacheRef.current.set(jointId, { kind: 'trunk', supportId: t.id });
                        break;
                    }
                }

                // If not in trunk, search branches
                if (!foundTrunk) {
                    for (const b of branches) {
                        const pos = resolveJointPosFromSegments(b.segments as any[], jointId);
                        if (pos) {
                            foundBranch = b;
                            foundJointPos = pos;
                            jointParentCacheRef.current.set(jointId, { kind: 'branch', supportId: b.id });
                            break;
                        }
                    }
                }

                // If not in trunk/branch, search kickstands
                if (!foundTrunk && !foundBranch) {
                    const kickstands = Object.values(getKickstandSnapshot().kickstands);
                    for (const kickstand of kickstands) {
                        const pos = resolveJointPosFromSegments(kickstand.segments as any[], jointId);
                        if (pos) {
                            foundKickstand = kickstand;
                            foundJointPos = pos;
                            jointParentCacheRef.current.set(jointId, { kind: 'kickstand', supportId: kickstand.id });
                            break;
                        }
                    }
                }

                if (!foundTrunk && !foundBranch && !foundKickstand) {
                    const twigs = getTwigs();
                    for (const twig of twigs) {
                        const pos = resolveJointPosFromSegments(twig.segments as any[], jointId);
                        if (pos) {
                            foundTwig = twig;
                            foundJointPos = pos;
                            jointParentCacheRef.current.set(jointId, { kind: 'twig', supportId: twig.id });
                            break;
                        }
                    }
                }

                if (!foundTrunk && !foundBranch && !foundKickstand && !foundTwig) {
                    const sticks = getSticks();
                    for (const stick of sticks) {
                        const pos = resolveJointPosFromSegments(stick.segments as any[], jointId);
                        if (pos) {
                            foundStick = stick;
                            foundJointPos = pos;
                            jointParentCacheRef.current.set(jointId, { kind: 'stick', supportId: stick.id });
                            break;
                        }
                    }
                }
            }

            const foundParent = foundTrunk || foundBranch || foundKickstand || foundTwig || foundStick;
            if (foundParent && foundJointPos) {
                // Check if interaction is allowed: parent or joint itself must be selected
                const selectedId = getSelectedId();
                const isAllowed = selectedId === foundParent.id || selectedId === jointId;

                if (!isAllowed) return;

                // If this gesture began before the parent/joint was selected,
                // skip drag activation and require the next gesture.
                const selectionAtDragStart = dragGestureSelectionAtStartRef.current;
                const hadEligibleSelectionAtGestureStart = selectionAtDragStart === foundParent.id || selectionAtDragStart === jointId;
                if (!hadEligibleSelectionAtGestureStart) return;

                activeJointId.current = jointId;
                setJointInteractionLock(true);
                jointDragUpdatePendingRef.current = true;
                if (!jointDragListenersAttachedRef.current) {
                    window.addEventListener('pointermove', markJointDragUpdatePending, true);
                    jointDragListenersAttachedRef.current = true;
                }
                lastAppliedDragPosRef.current = null;
                lastResolvedJointPosRef.current = null;
                lastPublishedClampedJointPosRef.current = null;
                lastWarningRef.current = null;
                lastWarningEvalAtRef.current = 0;
                activeJointBindingRef.current = resolveJointBinding((foundParent as { segments: Array<{ topJoint?: { id: string; pos: Vec3 }; bottomJoint?: { id: string; pos: Vec3 } }> }).segments, jointId);

                // While dragging a joint, disable OrbitControls so camera movement cannot
                // influence drag math (which is computed from the camera ray).
                if (controls && savedControlsEnabledRef.current === null) {
                    const c: any = controls;
                    savedControlsEnabledRef.current = !!c.enabled;
                    c.enabled = false;
                }

                if (foundTrunk) {
                    activeTrunkId.current = foundTrunk.id;
                    // Keep a direct immutable reference; trunk updates are copy-on-write.
                    initialTrunkSnapshot.current = foundTrunk;
                    liveTrunkPreviewRef.current = foundTrunk;

                    const root = getRootById(foundTrunk.rootId) ?? undefined;
                    activeConstraintRootRef.current = root;
                    activeConstraintStartRef.current = undefined;
                    if (root) {
                        const bottomSegIndex = foundTrunk.segments.findIndex((s) => s.topJoint?.id === jointId);
                        if (bottomSegIndex !== -1) {
                            const bottomSeg = foundTrunk.segments[bottomSegIndex];
                            const endpoints = getTrunkSegmentEndpoints(foundTrunk, bottomSeg, bottomSegIndex, root);
                            activeConstraintStartRef.current = endpoints?.start;
                        }
                    }
                } else if (foundBranch) {
                    activeBranchId.current = foundBranch.id;
                    liveBranchPreviewRef.current = foundBranch;
                    activeConstraintRootRef.current = undefined;
                    activeConstraintStartRef.current = getKnotById(foundBranch.parentKnotId)?.pos;
                    initialEditSnapshotRef.current = captureSupportEditSnapshot();
                } else if (foundKickstand) {
                    activeKickstandId.current = foundKickstand.id;
                    const root = getRootById(foundKickstand.rootId) ?? undefined;
                    activeConstraintRootRef.current = root;
                    activeConstraintStartRef.current = undefined;
                    if (root) {
                        const rPos = root.transform.pos;
                        const startZ = rPos.z + root.diskHeight + root.coneHeight;
                        activeConstraintStartRef.current = { x: rPos.x, y: rPos.y, z: startZ };
                    }
                    initialEditSnapshotRef.current = captureSupportEditSnapshot();
                } else if (foundTwig) {
                    activeTwigId.current = foundTwig.id;
                    liveTwigPreviewRef.current = foundTwig;
                    activeConstraintRootRef.current = undefined;
                    activeConstraintStartRef.current = undefined;
                    initialEditSnapshotRef.current = captureSupportEditSnapshot();
                } else if (foundStick) {
                    activeStickId.current = foundStick.id;
                    liveStickPreviewRef.current = foundStick;
                    activeConstraintRootRef.current = undefined;
                    activeConstraintStartRef.current = undefined;
                    initialEditSnapshotRef.current = captureSupportEditSnapshot();
                }

                emitJointDragPositionPreview(jointId, foundJointPos);
                lastResolvedJointPosRef.current = { x: foundJointPos.x, y: foundJointPos.y, z: foundJointPos.z };

                const jointVec = new THREE.Vector3(foundJointPos.x, foundJointPos.y, foundJointPos.z);

                // Setup drag plane parallel to camera, passing through joint
                const normal = new THREE.Vector3();
                camera.getWorldDirection(normal).negate(); // Face camera
                dragPlane.current.setFromNormalAndCoplanarPoint(normal, jointVec);

                // Calculate offset (where we clicked relative to joint center)
                raycaster.setFromCamera(pointer, camera);
                const intersection = new THREE.Vector3();
                const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

                if (intersected) {
                    dragOffset.current.subVectors(jointVec, intersection);
                } else {
                    dragOffset.current.set(0, 0, 0);
                }

                // Drag started
            }
        }

        // End Drag
        const activeJointIdAtEnd = activeJointId.current;
        const shouldEndDrag = (!isDragging || forceEndDragRef.current)
            && activeJointIdAtEnd
            && (activeTrunkId.current || activeBranchId.current || activeKickstandId.current || activeTwigId.current || activeStickId.current);

        if (shouldEndDrag) {
            // Drag ended

            // On drag end, do one collision-aware recompute so diskLengthOverride only reflects
            // the final settled joint position (avoids latching max standoff mid-drag).
            if (lastDragPos.current) {
                if (activeTrunkId.current) {
                    const trunk = getTrunkById(activeTrunkId.current);
                    if (trunk) {
                        const root = activeConstraintRootRef.current ?? getRootById(trunk.rootId) ?? undefined;
                        const contextStart = activeConstraintStartRef.current;

                        const resolved = computeJointDragSupportPreview({
                            kind: 'trunk',
                            support: trunk,
                            jointId: activeJointIdAtEnd,
                            newPos: lastDragPos.current,
                            isCurveMode: false,
                            root,
                            contextStart,
                        });

                        commitJointDragSupport('trunk', resolved, { stripDiskLengthOverride: true });
                    }
                } else if (activeBranchId.current) {
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        const contextStart = activeConstraintStartRef.current ?? getKnotById(branch.parentKnotId)?.pos;
                        const resolved = computeJointDragSupportPreview({
                            kind: 'branch',
                            support: branch,
                            jointId: activeJointIdAtEnd,
                            newPos: lastDragPos.current,
                            isCurveMode: false,
                            contextStart,
                        });

                        commitJointDragSupport('branch', resolved, { stripDiskLengthOverride: true });
                    }
                } else if (activeKickstandId.current) {
                    const kickstand = getKickstandSnapshot().kickstands[activeKickstandId.current];
                    if (kickstand) {
                        const root = activeConstraintRootRef.current ?? getRootById(kickstand.rootId) ?? undefined;
                        let contextStart = activeConstraintStartRef.current;
                        if (!contextStart && root) {
                            const rPos = root.transform.pos;
                            const startZ = rPos.z + root.diskHeight + root.coneHeight;
                            contextStart = { x: rPos.x, y: rPos.y, z: startZ };
                        }

                        const resolved = computeJointDragSupportPreview({
                            kind: 'kickstand',
                            support: kickstand,
                            jointId: activeJointIdAtEnd,
                            newPos: lastDragPos.current,
                            isCurveMode: false,
                            root,
                            contextStart,
                        });
                        commitJointDragSupport('kickstand', resolved);
                    }
                } else if (activeTwigId.current) {
                    const twig = getTwigById(activeTwigId.current);
                    if (twig) {
                        const nextSegments = updateSegmentsJointPos(twig.segments as any[], activeJointIdAtEnd, lastDragPos.current) as any[];
                        const firstSegment = nextSegments[0];
                        const lastSegment = nextSegments[nextSegments.length - 1];
                        const movingBottomEndpoint = firstSegment?.bottomJoint?.id === activeJointIdAtEnd;
                        const movingTopEndpoint = lastSegment?.topJoint?.id === activeJointIdAtEnd;

                        let nextDiskA: ContactDisk = twig.contactDiskA;
                        let nextDiskB: ContactDisk = twig.contactDiskB;
                        let adjustedSegments = nextSegments;

                        if (movingBottomEndpoint && firstSegment?.bottomJoint) {
                            const otherSocket = lastSegment?.topJoint?.pos ?? getTwigDiskTipCenter(nextDiskB);
                            const desiredSocketA = firstSegment.bottomJoint.pos;
                            const axisHint = new THREE.Vector3(
                                otherSocket.x - desiredSocketA.x,
                                otherSocket.y - desiredSocketA.y,
                                otherSocket.z - desiredSocketA.z,
                            );

                            const recomputedA = recomputeTwigDiskForSocket(twig.contactDiskA, desiredSocketA, axisHint);
                            nextDiskA = recomputedA.disk;

                            adjustedSegments = adjustedSegments.map((segment: any, index: number) => {
                                if (index !== 0 || !segment.bottomJoint) return segment;
                                return {
                                    ...segment,
                                    bottomJoint: {
                                        ...segment.bottomJoint,
                                        pos: recomputedA.socket,
                                    },
                                };
                            });
                        }

                        if (movingTopEndpoint && lastSegment?.topJoint) {
                            const firstAfterAdjust = adjustedSegments[0];
                            const otherSocket = firstAfterAdjust?.bottomJoint?.pos ?? getTwigDiskTipCenter(nextDiskA);
                            const desiredSocketB = lastSegment.topJoint.pos;
                            const axisHint = new THREE.Vector3(
                                otherSocket.x - desiredSocketB.x,
                                otherSocket.y - desiredSocketB.y,
                                otherSocket.z - desiredSocketB.z,
                            );

                            const recomputedB = recomputeTwigDiskForSocket(twig.contactDiskB, desiredSocketB, axisHint);
                            nextDiskB = recomputedB.disk;

                            adjustedSegments = adjustedSegments.map((segment: any, index: number) => {
                                if (index !== adjustedSegments.length - 1 || !segment.topJoint) return segment;
                                return {
                                    ...segment,
                                    topJoint: {
                                        ...segment.topJoint,
                                        pos: recomputedB.socket,
                                    },
                                };
                            });
                        }

                        const committedTwig: Twig = {
                            ...twig,
                            segments: adjustedSegments,
                            contactDiskA: nextDiskA,
                            contactDiskB: nextDiskB,
                        };

                        updateTwig(committedTwig);
                    }
                } else if (activeStickId.current) {
                    const stick = getStickById(activeStickId.current);
                    if (stick) {
                        const nextSegments = updateSegmentsJointPos(stick.segments as any[], activeJointIdAtEnd, lastDragPos.current) as any;
                        const nextConeA = stick.contactConeA?.socketJointId === activeJointIdAtEnd
                            ? recomputeConeForSocket(stick.contactConeA as any, lastDragPos.current)
                            : stick.contactConeA;
                        const nextConeB = stick.contactConeB?.socketJointId === activeJointIdAtEnd
                            ? recomputeConeForSocket(stick.contactConeB as any, lastDragPos.current)
                            : stick.contactConeB;

                        const committedStick: Stick = {
                            ...stick,
                            segments: nextSegments,
                            contactConeA: nextConeA,
                            contactConeB: nextConeB,
                        };

                        updateStick(committedStick);
                    }
                }
            }

            if (initialTrunkSnapshot.current && activeTrunkId.current) {
                const currentTrunk = getTrunkById(activeTrunkId.current);
                if (currentTrunk) {
                    pushHistory({
                        type: SUPPORT_UPDATE_TRUNK,
                        description: 'Move trunk joint',
                        payload: {
                            before: initialTrunkSnapshot.current,
                            after: cloneTrunk(currentTrunk),
                        },
                    });
                }
            }

            if (initialEditSnapshotRef.current) {
                if (activeBranchId.current) {
                    pushSupportEditHistory('Move branch joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
                } else if (activeKickstandId.current) {
                    pushSupportEditHistory('Move kickstand joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
                } else if (activeTwigId.current) {
                    pushSupportEditHistory('Move twig joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
                } else if (activeStickId.current) {
                    pushSupportEditHistory('Move stick joint', initialEditSnapshotRef.current, captureSupportEditSnapshot());
                }
            }

            if (activeTwigId.current) {
                clearSupportDragPreview('twig', activeTwigId.current);
            }
            if (activeStickId.current) {
                clearSupportDragPreview('stick', activeStickId.current);
            }

            activeJointId.current = null;
            activeTrunkId.current = null;
            activeBranchId.current = null;
            activeKickstandId.current = null;
            activeTwigId.current = null;
            activeStickId.current = null;
            initialTrunkSnapshot.current = null;
            initialEditSnapshotRef.current = null;
            liveTrunkPreviewRef.current = null;
            liveBranchPreviewRef.current = null;
            liveTwigPreviewRef.current = null;
            liveStickPreviewRef.current = null;
            forceEndDragRef.current = false;
            lastAppliedDragPosRef.current = null;
            lastResolvedJointPosRef.current = null;
            lastPublishedClampedJointPosRef.current = null;
            lastEmittedPreviewJointPosRef.current = null;
            lastWarningEvalAtRef.current = 0;
            activeConstraintRootRef.current = undefined;
            activeConstraintStartRef.current = undefined;
            activeJointBindingRef.current = null;
            jointDragUpdatePendingRef.current = false;
            if (jointDragListenersAttachedRef.current) {
                window.removeEventListener('pointermove', markJointDragUpdatePending, true);
                jointDragListenersAttachedRef.current = false;
            }
            applyInteractionWarning(null); // Clear warning on release
            lastDragPos.current = null;
            clearJointDragPositionPreview(activeJointIdAtEnd);

            // Restore OrbitControls enabled state
            if (controls && savedControlsEnabledRef.current !== null) {
                const c: any = controls;
                c.enabled = savedControlsEnabledRef.current;
                savedControlsEnabledRef.current = null;
            }

            setJointInteractionLock(false);
        }
    }, [isDragging, hit, camera, pointer, raycaster, controls, applyInteractionWarning, resolveJointBinding, markJointDragUpdatePending]);

    const emitPreviewJointPos = (clampedPos: Vec3 | null, rawPos: Vec3) => {
        const stablePos = clampedPos ?? lastResolvedJointPosRef.current ?? rawPos;
        const prev = lastEmittedPreviewJointPosRef.current;
        if (prev
            && Math.abs(prev.x - stablePos.x) < MIN_DRAG_DELTA_SQ
            && Math.abs(prev.y - stablePos.y) < MIN_DRAG_DELTA_SQ
            && Math.abs(prev.z - stablePos.z) < MIN_DRAG_DELTA_SQ) {
            return;
        }

        lastResolvedJointPosRef.current = { x: stablePos.x, y: stablePos.y, z: stablePos.z };
        lastEmittedPreviewJointPosRef.current = { x: stablePos.x, y: stablePos.y, z: stablePos.z };
        emitJointDragPositionPreview(activeJointId.current!, stablePos);
    };

    const snapDragPos = (pos: THREE.Vector3) => {
        pos.x = Math.round(pos.x / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        pos.y = Math.round(pos.y / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        pos.z = Math.round(pos.z / DRAG_SNAP_MM) * DRAG_SNAP_MM;
        return pos;
    };

    // Update loop
    useFrame(() => {
        if (!jointDragUpdatePendingRef.current) return;
        if (!(activeJointId.current && (activeTrunkId.current || activeBranchId.current || activeKickstandId.current || activeTwigId.current || activeStickId.current))) return;

        jointDragUpdatePendingRef.current = false;

        if (activeJointId.current && (activeTrunkId.current || activeBranchId.current || activeKickstandId.current || activeTwigId.current || activeStickId.current)) {
            raycaster.setFromCamera(pointer, camera);
            const intersection = planeIntersectionRef.current;
            const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

            if (intersected) {
                // Apply offset
                const newPos = snapDragPos(intersection.add(dragOffset.current));
                const hasLastAppliedPos = !!lastAppliedDragPosRef.current;
                const deltaSq = hasLastAppliedPos
                    ? lastAppliedDragPosRef.current!.distanceToSquared(newPos)
                    : 0;

                if (hasLastAppliedPos && deltaSq < MIN_DRAG_DELTA_SQ) {
                    return;
                }
                const newPosVec3 = { x: newPos.x, y: newPos.y, z: newPos.z };
                lastDragPos.current = newPosVec3;
                // Emit once after clamped preview is calculated further below
                if (!lastAppliedDragPosRef.current) {
                    lastAppliedDragPosRef.current = newPos.clone();
                } else {
                    lastAppliedDragPosRef.current.copy(newPos);
                }

                if (activeTrunkId.current) {
                    // Update trunk
                    const trunk = getTrunkById(activeTrunkId.current);
                    if (trunk) {
                        // Resolve Context for constraints (cached from drag start)
                        const root = activeConstraintRootRef.current ?? getRootById(trunk.rootId) ?? undefined;
                        const contextStart = activeConstraintStartRef.current;

                        const newTrunk = computeJointDragSupportPreview({
                            kind: 'trunk',
                            support: trunk,
                            jointId: activeJointId.current!,
                            newPos: newPosVec3,
                            isCurveMode: false,
                            root,
                            contextStart,
                            skipContactConeSolve: true,
                        });

                        const clampedTrunkJointPos = resolveJointPosById(newTrunk.segments, activeJointId.current!);
                        const shouldPublish = shouldPublishForClampedPos(clampedTrunkJointPos);
                        if (liveTrunkPreviewRef.current !== newTrunk && shouldPublish) {
                            liveTrunkPreviewRef.current = newTrunk;
                            publishJointDragSupportPreview('trunk', newTrunk);
                            markPublishedClampedPos(clampedTrunkJointPos);
                        }

                        emitPreviewJointPos(clampedTrunkJointPos, newPosVec3);
                        applyWarningForDragDelta(clampedTrunkJointPos, newPosVec3);
                    }
                } else if (activeBranchId.current) {
                    // Update branch
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        const contextStart = activeConstraintStartRef.current ?? getKnotById(branch.parentKnotId)?.pos;

                        const newBranch = computeJointDragSupportPreview({
                            kind: 'branch',
                            support: branch,
                            jointId: activeJointId.current!,
                            newPos: newPosVec3,
                            isCurveMode: false,
                            contextStart,
                            skipContactConeSolve: true,
                        });

                        const clampedBranchJointPos = resolveJointPosById(newBranch.segments, activeJointId.current!);
                        const shouldPublish = shouldPublishForClampedPos(clampedBranchJointPos);
                        if (liveBranchPreviewRef.current !== newBranch && shouldPublish) {
                            liveBranchPreviewRef.current = newBranch;
                            publishJointDragSupportPreview('branch', newBranch);
                            markPublishedClampedPos(clampedBranchJointPos);
                        }

                        emitPreviewJointPos(clampedBranchJointPos, newPosVec3);
                        applyWarningForDragDelta(clampedBranchJointPos, newPosVec3);
                    }
                } else if (activeKickstandId.current) {
                    const kickstand = getKickstandSnapshot().kickstands[activeKickstandId.current];
                    if (kickstand) {
                        const root = activeConstraintRootRef.current ?? getRootById(kickstand.rootId) ?? undefined;
                        let contextStart = activeConstraintStartRef.current;
                        if (!contextStart && root) {
                            const rPos = root.transform.pos;
                            const startZ = rPos.z + root.diskHeight + root.coneHeight;
                            contextStart = { x: rPos.x, y: rPos.y, z: startZ };
                        }

                        const newKickstand = computeJointDragSupportPreview({
                            kind: 'kickstand',
                            support: kickstand,
                            jointId: activeJointId.current!,
                            newPos: newPosVec3,
                            isCurveMode: false,
                            root,
                            contextStart,
                            skipContactConeSolve: true,
                        });

                        const clampedKickstandJointPos = resolveJointPosById(newKickstand.segments, activeJointId.current!);
                        const shouldPublish = shouldPublishForClampedPos(clampedKickstandJointPos);
                        if (getKickstandSnapshot().kickstands[activeKickstandId.current] !== newKickstand && shouldPublish) {
                            publishJointDragSupportPreview('kickstand', newKickstand);
                            markPublishedClampedPos(clampedKickstandJointPos);
                        }

                        emitPreviewJointPos(clampedKickstandJointPos, newPosVec3);
                        applyWarningForDragDelta(clampedKickstandJointPos, newPosVec3);
                    }
                } else if (activeTwigId.current) {
                    const twig = getTwigById(activeTwigId.current);
                    if (twig) {
                        const nextSegments = updateSegmentsJointPos(twig.segments as any[], activeJointId.current!, newPosVec3) as any[];
                        const firstSegment = nextSegments[0];
                        const lastSegment = nextSegments[nextSegments.length - 1];
                        const movingBottomEndpoint = firstSegment?.bottomJoint?.id === activeJointId.current!;
                        const movingTopEndpoint = lastSegment?.topJoint?.id === activeJointId.current!;

                        let nextDiskA: ContactDisk = twig.contactDiskA;
                        let nextDiskB: ContactDisk = twig.contactDiskB;
                        let adjustedSegments = nextSegments;

                        if (movingBottomEndpoint && firstSegment?.bottomJoint) {
                            const otherSocket = lastSegment?.topJoint?.pos ?? getTwigDiskTipCenter(nextDiskB);
                            const desiredSocketA = firstSegment.bottomJoint.pos;
                            const axisHint = new THREE.Vector3(
                                otherSocket.x - desiredSocketA.x,
                                otherSocket.y - desiredSocketA.y,
                                otherSocket.z - desiredSocketA.z,
                            );

                            const recomputedA = recomputeTwigDiskForSocket(twig.contactDiskA, desiredSocketA, axisHint);
                            nextDiskA = recomputedA.disk;

                            adjustedSegments = adjustedSegments.map((segment: any, index: number) => {
                                if (index !== 0 || !segment.bottomJoint) return segment;
                                return {
                                    ...segment,
                                    bottomJoint: {
                                        ...segment.bottomJoint,
                                        pos: recomputedA.socket,
                                    },
                                };
                            });
                        }

                        if (movingTopEndpoint && lastSegment?.topJoint) {
                            const firstAfterAdjust = adjustedSegments[0];
                            const otherSocket = firstAfterAdjust?.bottomJoint?.pos ?? getTwigDiskTipCenter(nextDiskA);
                            const desiredSocketB = lastSegment.topJoint.pos;
                            const axisHint = new THREE.Vector3(
                                otherSocket.x - desiredSocketB.x,
                                otherSocket.y - desiredSocketB.y,
                                otherSocket.z - desiredSocketB.z,
                            );

                            const recomputedB = recomputeTwigDiskForSocket(twig.contactDiskB, desiredSocketB, axisHint);
                            nextDiskB = recomputedB.disk;

                            adjustedSegments = adjustedSegments.map((segment: any, index: number) => {
                                if (index !== adjustedSegments.length - 1 || !segment.topJoint) return segment;
                                return {
                                    ...segment,
                                    topJoint: {
                                        ...segment.topJoint,
                                        pos: recomputedB.socket,
                                    },
                                };
                            });
                        }

                        const newTwig: Twig = {
                            ...twig,
                            segments: adjustedSegments,
                            contactDiskA: nextDiskA,
                            contactDiskB: nextDiskB,
                        };

                        const clampedTwigJointPos = resolveJointPosById(newTwig.segments, activeJointId.current!);
                        const shouldPublish = shouldPublishForClampedPos(clampedTwigJointPos);
                        if (liveTwigPreviewRef.current !== newTwig && shouldPublish) {
                            liveTwigPreviewRef.current = newTwig;
                            emitSupportDragPreview('twig', newTwig.id, newTwig);
                            markPublishedClampedPos(clampedTwigJointPos);
                        }

                        emitPreviewJointPos(clampedTwigJointPos, newPosVec3);
                    }
                } else if (activeStickId.current) {
                    const stick = getStickById(activeStickId.current);
                    if (stick) {
                        const nextSegments = updateSegmentsJointPos(stick.segments as any[], activeJointId.current!, newPosVec3) as any;
                        const nextConeA = stick.contactConeA?.socketJointId === activeJointId.current!
                            ? recomputeConeForSocket(stick.contactConeA as any, newPosVec3)
                            : stick.contactConeA;
                        const nextConeB = stick.contactConeB?.socketJointId === activeJointId.current!
                            ? recomputeConeForSocket(stick.contactConeB as any, newPosVec3)
                            : stick.contactConeB;

                        const newStick: Stick = {
                            ...stick,
                            segments: nextSegments,
                            contactConeA: nextConeA,
                            contactConeB: nextConeB,
                        };

                        const clampedStickJointPos = resolveJointPosById(newStick.segments, activeJointId.current!);
                        const shouldPublish = shouldPublishForClampedPos(clampedStickJointPos);
                        if (liveStickPreviewRef.current !== newStick && shouldPublish) {
                            liveStickPreviewRef.current = newStick;
                            emitSupportDragPreview('stick', newStick.id, newStick);
                            markPublishedClampedPos(clampedStickJointPos);
                        }

                        emitPreviewJointPos(clampedStickJointPos, newPosVec3);
                    }
                }
            }
        }
    });
}
