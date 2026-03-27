import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { getTrunks, getBranches, updateTrunk, updateBranch, getSelectedId, getTrunkById, getRootById, getBranchById, getKnotById, setInteractionWarning } from '../../state';
import { moveJoint } from './jointUtils';
import { getTrunkSegmentEndpoints } from '../Knot/knotUtils';
import { Vec3, Trunk, Branch, Roots } from '../../types';
import { getKickstandSnapshot, updateKickstand } from '../../SupportTypes/Kickstand/kickstandStore';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { clearJointDragPreview, emitJointDragPreview } from '../../interaction/jointDragPreview';

/**
 * Hook to handle joint interaction (dragging/moving).
 * Must be used inside a Canvas/R3F context.
 * 
 * Usage: Call this hook once in your main scene component (e.g. SupportRenderer).
 * It monitors the picking state and handles drag operations for any 'joint' object.
 */
export function useJointInteraction(enabled: boolean = true) {
    const MIN_DRAG_DELTA_SQ = 1e-8; // 0.0001mm positional epsilon (noise-only)
    const WARNING_DISTANCE_THRESHOLD = 0.05; // mm
    const WARNING_EVAL_INTERVAL_MS = 48; // ~20Hz warning updates during drag

    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer, controls } = useThree();

    const activeJointId = useRef<string | null>(null);
    const activeTrunkId = useRef<string | null>(null);
    const activeBranchId = useRef<string | null>(null);
    const activeKickstandId = useRef<string | null>(null);
    const dragPlane = useRef<THREE.Plane>(new THREE.Plane());
    const dragOffset = useRef<THREE.Vector3>(new THREE.Vector3());
    const lastDragPos = useRef<Vec3 | null>(null);
    const forceEndDragRef = useRef(false);
    const initialTrunkSnapshot = useRef<Trunk | null>(null);
    const initialEditSnapshotRef = useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const lastAppliedDragPosRef = useRef<THREE.Vector3 | null>(null);
    const liveTrunkPreviewRef = useRef<Trunk | null>(null);
    const liveBranchPreviewRef = useRef<Branch | null>(null);
    const lastWarningRef = useRef<string | null>(null);
    const lastWarningEvalAtRef = useRef(0);
    const jointParentCacheRef = useRef<Map<string, { kind: 'trunk' | 'branch' | 'kickstand'; supportId: string }>>(new Map());
    const activeConstraintRootRef = useRef<Roots | undefined>(undefined);
    const activeConstraintStartRef = useRef<Vec3 | undefined>(undefined);

    const savedControlsEnabledRef = useRef<boolean | null>(null);

    const cloneTrunk = (trunk: Trunk): Trunk => JSON.parse(JSON.stringify(trunk));

    const applyInteractionWarning = useCallback((warning: 'SHAFT_ANGLE_TOO_FLAT' | null) => {
        if (lastWarningRef.current === warning) return;
        lastWarningRef.current = warning;
        setInteractionWarning(warning);
    }, []);

    const setJointDragInteractionLock = useCallback((isDragging: boolean, postGuardMs = 180) => {
        if (typeof window === 'undefined') return;

        const w = window as any;
        w.__jointGizmoDragging = isDragging;
        w.__jointGizmoGuardUntil = isDragging ? 0 : (Date.now() + postGuardMs);

        window.dispatchEvent(new CustomEvent('joint-gizmo-interaction-lock', {
            detail: {
                active: isDragging,
                guardUntil: w.__jointGizmoGuardUntil,
            },
        }));
    }, []);

    useEffect(() => {
        return () => {
            setJointDragInteractionLock(false, 0);
        };
    }, [setJointDragInteractionLock]);

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

    // Monitor drag state
    useEffect(() => {
        if (!enabled && !activeJointId.current) return;

        // Start Drag
        if (enabled && isDragging && hit.category === 'joint' && hit.objectId && !activeJointId.current) {
            const jointId = hit.objectId;

            // Find trunk/branch and joint
            let foundTrunk: Trunk | null = null;
            let foundBranch: Branch | null = null;
            let foundKickstand: Kickstand | null = null;
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
            }

            const foundParent = foundTrunk || foundBranch || foundKickstand;
            if (foundParent && foundJointPos) {
                // Check if interaction is allowed: parent or joint itself must be selected
                const selectedId = getSelectedId();
                const isAllowed = selectedId === foundParent.id || selectedId === jointId;

                if (!isAllowed) return;

                activeJointId.current = jointId;
                setJointDragInteractionLock(true);
                lastAppliedDragPosRef.current = null;
                lastWarningRef.current = null;
                lastWarningEvalAtRef.current = 0;

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
                }

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
            && (activeTrunkId.current || activeBranchId.current || activeKickstandId.current);

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

                        const resolved = moveJoint(
                            trunk,
                            activeJointIdAtEnd,
                            lastDragPos.current,
                            undefined,
                            false,
                            root,
                            contextStart
                        );
                        const resolvedWithoutOverride: Trunk = resolved.contactCone
                            ? {
                                ...resolved,
                                contactCone: {
                                    ...resolved.contactCone,
                                    diskLengthOverride: undefined,
                                },
                            }
                            : resolved;
                        clearJointDragPreview('trunk', resolvedWithoutOverride.id);
                        updateTrunk(resolvedWithoutOverride);
                    }
                } else if (activeBranchId.current) {
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        const contextStart = activeConstraintStartRef.current ?? getKnotById(branch.parentKnotId)?.pos;
                        const resolved = moveJoint(
                            branch as any,
                            activeJointIdAtEnd,
                            lastDragPos.current,
                            undefined,
                            false,
                            undefined,
                            contextStart
                        ) as unknown as Branch;
                        const resolvedWithoutOverride: Branch = resolved.contactCone
                            ? {
                                ...resolved,
                                contactCone: {
                                    ...resolved.contactCone,
                                    diskLengthOverride: undefined,
                                },
                            }
                            : resolved;
                        clearJointDragPreview('branch', resolvedWithoutOverride.id);
                        updateBranch(resolvedWithoutOverride);
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

                        const resolved = moveJoint(
                            kickstand as unknown as Trunk,
                            activeJointIdAtEnd,
                            lastDragPos.current,
                            undefined,
                            false,
                            root,
                            contextStart,
                        ) as unknown as Kickstand;
                        updateKickstand(resolved);
                    }
                }
            }

            if (initialTrunkSnapshot.current && activeTrunkId.current) {
                const currentTrunk = getTrunkById(activeTrunkId.current);
                if (currentTrunk) {
                    pushHistory({
                        type: SUPPORT_UPDATE_TRUNK,
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
                }
            }

            activeJointId.current = null;
            activeTrunkId.current = null;
            activeBranchId.current = null;
            activeKickstandId.current = null;
            initialTrunkSnapshot.current = null;
            initialEditSnapshotRef.current = null;
            liveTrunkPreviewRef.current = null;
            liveBranchPreviewRef.current = null;
            forceEndDragRef.current = false;
            lastAppliedDragPosRef.current = null;
            lastWarningEvalAtRef.current = 0;
            activeConstraintRootRef.current = undefined;
            activeConstraintStartRef.current = undefined;
            applyInteractionWarning(null); // Clear warning on release
            lastDragPos.current = null;

            // Restore OrbitControls enabled state
            if (controls && savedControlsEnabledRef.current !== null) {
                const c: any = controls;
                c.enabled = savedControlsEnabledRef.current;
                savedControlsEnabledRef.current = null;
            }

            setJointDragInteractionLock(false);
        }
    }, [isDragging, hit, camera, pointer, raycaster, controls, setJointDragInteractionLock, applyInteractionWarning]);

    // Update loop
    useFrame(() => {
        if (activeJointId.current && (activeTrunkId.current || activeBranchId.current || activeKickstandId.current)) {
            raycaster.setFromCamera(pointer, camera);
            const intersection = new THREE.Vector3();
            const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

            if (intersected) {
                // Apply offset
                const newPos = intersection.add(dragOffset.current);
                if (lastAppliedDragPosRef.current && lastAppliedDragPosRef.current.distanceToSquared(newPos) < MIN_DRAG_DELTA_SQ) {
                    return;
                }
                const newPosVec3 = { x: newPos.x, y: newPos.y, z: newPos.z };
                lastDragPos.current = newPosVec3;
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

                        const newTrunk = moveJoint(
                            trunk,
                            activeJointId.current!,
                            newPosVec3,
                            undefined,
                            false,
                            root,
                            contextStart
                        );
                        liveTrunkPreviewRef.current = newTrunk;
                        emitJointDragPreview({ kind: 'trunk', supportId: newTrunk.id, support: newTrunk });

                        const now = performance.now();
                        if (now - lastWarningEvalAtRef.current >= WARNING_EVAL_INTERVAL_MS) {
                            lastWarningEvalAtRef.current = now;

                            // Check for Clamping Warning (throttled)
                            let foundJointPos: Vec3 | null = null;
                            for (const s of newTrunk.segments) {
                                if (s.topJoint?.id === activeJointId.current) {
                                    foundJointPos = s.topJoint.pos;
                                    break;
                                }
                                if (s.bottomJoint?.id === activeJointId.current) {
                                    foundJointPos = s.bottomJoint.pos;
                                    break;
                                }
                            }

                            if (foundJointPos) {
                                const dx = foundJointPos.x - newPos.x;
                                const dy = foundJointPos.y - newPos.y;
                                const dz = foundJointPos.z - newPos.z;
                                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                                if (dist > WARNING_DISTANCE_THRESHOLD) {
                                    applyInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
                                } else {
                                    applyInteractionWarning(null);
                                }
                            }
                        }
                    }
                } else if (activeBranchId.current) {
                    // Update branch
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        const contextStart = activeConstraintStartRef.current ?? getKnotById(branch.parentKnotId)?.pos;

                        const newBranch = moveJoint(
                            branch as any,
                            activeJointId.current!,
                            newPosVec3,
                            undefined,
                            false,
                            undefined, // No root for branch?
                            contextStart
                        ) as unknown as Branch;
                        liveBranchPreviewRef.current = newBranch;
                        emitJointDragPreview({ kind: 'branch', supportId: newBranch.id, support: newBranch });

                        const now = performance.now();
                        if (now - lastWarningEvalAtRef.current >= WARNING_EVAL_INTERVAL_MS) {
                            lastWarningEvalAtRef.current = now;

                            // Check for Clamping Warning (throttled)
                            let foundJointPos: Vec3 | null = null;
                            for (const s of newBranch.segments) {
                                if (s.topJoint?.id === activeJointId.current) {
                                    foundJointPos = s.topJoint.pos;
                                    break;
                                }
                                if (s.bottomJoint?.id === activeJointId.current) {
                                    foundJointPos = s.bottomJoint.pos;
                                    break;
                                }
                            }

                            if (foundJointPos) {
                                const dx = foundJointPos.x - newPos.x;
                                const dy = foundJointPos.y - newPos.y;
                                const dz = foundJointPos.z - newPos.z;
                                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                                if (dist > WARNING_DISTANCE_THRESHOLD) {
                                    applyInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
                                } else {
                                    applyInteractionWarning(null);
                                }
                            }
                        }
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

                        const newKickstand = moveJoint(
                            kickstand as unknown as Trunk,
                            activeJointId.current!,
                            newPosVec3,
                            undefined,
                            false,
                            root,
                            contextStart,
                        ) as unknown as Kickstand;
                        updateKickstand(newKickstand);

                        const now = performance.now();
                        if (now - lastWarningEvalAtRef.current >= WARNING_EVAL_INTERVAL_MS) {
                            lastWarningEvalAtRef.current = now;

                            let foundJointPos: Vec3 | null = null;
                            for (const s of newKickstand.segments) {
                                if (s.topJoint?.id === activeJointId.current) {
                                    foundJointPos = s.topJoint.pos;
                                    break;
                                }
                                if (s.bottomJoint?.id === activeJointId.current) {
                                    foundJointPos = s.bottomJoint.pos;
                                    break;
                                }
                            }

                            if (foundJointPos) {
                                const dx = foundJointPos.x - newPos.x;
                                const dy = foundJointPos.y - newPos.y;
                                const dz = foundJointPos.z - newPos.z;
                                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                                if (dist > WARNING_DISTANCE_THRESHOLD) {
                                    applyInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
                                } else {
                                    applyInteractionWarning(null);
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}
