import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { usePicking } from '@/components/picking';
import { getTrunks, getBranches, updateTrunk, updateBranch, getSelectedId, getTrunkById, getRootById, getBranchById, getKnotById, setInteractionWarning } from '../../state';
import { moveJoint } from './jointUtils';
import { Vec3, Trunk, Branch } from '../../types';
import { pushHistory } from '@/history/historyStore';
import { SUPPORT_UPDATE_TRUNK } from '../../history/actionTypes';

/**
 * Hook to handle joint interaction (dragging/moving).
 * Must be used inside a Canvas/R3F context.
 * 
 * Usage: Call this hook once in your main scene component (e.g. SupportRenderer).
 * It monitors the picking state and handles drag operations for any 'joint' object.
 */
export function useJointInteraction(enabled: boolean = true) {
    const { isDragging, hit } = usePicking();
    const { camera, raycaster, pointer, controls } = useThree();

    const activeJointId = useRef<string | null>(null);
    const activeTrunkId = useRef<string | null>(null);
    const activeBranchId = useRef<string | null>(null);
    const activeMesh = useRef<THREE.Mesh | undefined>(undefined); // Cache the mesh during drag
    const dragPlane = useRef<THREE.Plane>(new THREE.Plane());
    const dragOffset = useRef<THREE.Vector3>(new THREE.Vector3());
    const lastDragPos = useRef<Vec3 | null>(null);
    const initialTrunkSnapshot = useRef<Trunk | null>(null);
    const initialBranchSnapshot = useRef<Branch | null>(null);

    const savedControlsEnabledRef = useRef<boolean | null>(null);

    const { scene } = useThree(); // Get scene for mesh lookup

    const cloneTrunk = (trunk: Trunk): Trunk => JSON.parse(JSON.stringify(trunk));
    const cloneBranch = (branch: Branch): Branch => JSON.parse(JSON.stringify(branch));

    // Helper to find mesh by modelId
    const findMesh = (modelId: string): THREE.Mesh | undefined => {
        let found: THREE.Mesh | undefined;
        scene.traverse((child) => {
            if (child instanceof THREE.Mesh && child.userData.modelId === modelId) {
                found = child;
            }
        });
        return found;
    };

    // Monitor drag state
    useEffect(() => {
        if (!enabled) return;

        // Start Drag
        if (isDragging && hit.category === 'joint' && hit.objectId && !activeJointId.current) {
            const jointId = hit.objectId;
            const trunks = getTrunks();
            const branches = getBranches();

            // Find trunk/branch and joint
            let foundTrunk: Trunk | null = null;
            let foundBranch: Branch | null = null;
            let foundJointPos: Vec3 | null = null;

            // Search trunks first
            for (const t of trunks) {
                for (const s of t.segments) {
                    if (s.topJoint?.id === jointId) {
                        foundTrunk = t;
                        foundJointPos = s.topJoint.pos;
                        break;
                    }
                    if (s.bottomJoint?.id === jointId) {
                        foundTrunk = t;
                        foundJointPos = s.bottomJoint.pos;
                        break;
                    }
                }
                if (foundTrunk) break;
            }

            // If not in trunk, search branches
            if (!foundTrunk) {
                for (const b of branches) {
                    for (const s of b.segments) {
                        if (s.topJoint?.id === jointId) {
                            foundBranch = b;
                            foundJointPos = s.topJoint.pos;
                            break;
                        }
                        if (s.bottomJoint?.id === jointId) {
                            foundBranch = b;
                            foundJointPos = s.bottomJoint.pos;
                            break;
                        }
                    }
                    if (foundBranch) break;
                }
            }

            const foundParent = foundTrunk || foundBranch;
            if (foundParent && foundJointPos) {
                // Check if interaction is allowed: parent or joint itself must be selected
                const selectedId = getSelectedId();
                const isAllowed = selectedId === foundParent.id || selectedId === jointId;

                if (!isAllowed) return;

                activeJointId.current = jointId;

                // While dragging a joint, disable OrbitControls so camera movement cannot
                // influence drag math (which is computed from the camera ray).
                if (controls && savedControlsEnabledRef.current === null) {
                    const c: any = controls;
                    savedControlsEnabledRef.current = !!c.enabled;
                    c.enabled = false;
                }

                if (foundTrunk) {
                    activeTrunkId.current = foundTrunk.id;
                    activeMesh.current = findMesh(foundTrunk.modelId);
                    initialTrunkSnapshot.current = cloneTrunk(foundTrunk);
                } else if (foundBranch) {
                    activeBranchId.current = foundBranch.id;
                    activeMesh.current = findMesh(foundBranch.modelId);
                    initialBranchSnapshot.current = cloneBranch(foundBranch);
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

                console.log(`[JointInteraction] Started dragging joint ${jointId} on ${foundTrunk ? 'trunk' : 'branch'} ${foundParent.id}`);
            }
        }

        // End Drag
        if (!isDragging && activeJointId.current && (activeTrunkId.current || activeBranchId.current)) {
            console.log(`[JointInteraction] Stopped dragging joint ${activeJointId.current}`);

            // On drag end, do one collision-aware recompute so diskLengthOverride only reflects
            // the final settled joint position (avoids latching max standoff mid-drag).
            if (lastDragPos.current) {
                if (activeTrunkId.current) {
                    const trunk = getTrunkById(activeTrunkId.current);
                    if (trunk) {
                        const root = getRootById(trunk.rootId) ?? undefined;
                        let contextStart: Vec3 | undefined;
                        if (root) {
                            const rPos = root.transform.pos;
                            const startZ = rPos.z + root.diskHeight + root.coneHeight;
                            contextStart = { x: rPos.x, y: rPos.y, z: startZ };
                        }

                        const resolved = moveJoint(
                            trunk,
                            activeJointId.current,
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
                        updateTrunk(resolvedWithoutOverride);
                    }
                } else if (activeBranchId.current) {
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        const knot = getKnotById(branch.parentKnotId);
                        const contextStart = knot?.pos;
                        const resolved = moveJoint(
                            branch as any,
                            activeJointId.current,
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
                        updateBranch(resolvedWithoutOverride);
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
            // Note: Branch history not implemented yet, but drag still works

            activeJointId.current = null;
            activeTrunkId.current = null;
            activeBranchId.current = null;
            activeMesh.current = undefined;
            initialTrunkSnapshot.current = null;
            initialBranchSnapshot.current = null;
            setInteractionWarning(null); // Clear warning on release
            lastDragPos.current = null;

            // Restore OrbitControls enabled state
            if (controls && savedControlsEnabledRef.current !== null) {
                const c: any = controls;
                c.enabled = savedControlsEnabledRef.current;
                savedControlsEnabledRef.current = null;
            }
        }
    }, [isDragging, hit, camera, pointer, raycaster, scene, controls]);

    // Update loop
    useFrame(() => {
        if (activeJointId.current && (activeTrunkId.current || activeBranchId.current)) {
            raycaster.setFromCamera(pointer, camera);
            const intersection = new THREE.Vector3();
            const intersected = raycaster.ray.intersectPlane(dragPlane.current, intersection);

            if (intersected) {
                // Apply offset
                const newPos = intersection.add(dragOffset.current);
                const newPosVec3 = { x: newPos.x, y: newPos.y, z: newPos.z };
                lastDragPos.current = newPosVec3;

                if (activeTrunkId.current) {
                    // Update trunk
                    const trunk = getTrunkById(activeTrunkId.current);
                    if (trunk) {
                        // Resolve Context for constraints
                        const root = getRootById(trunk.rootId) ?? undefined;
                        let contextStart: Vec3 | undefined;
                        if (root) {
                            const rPos = root.transform.pos;
                            const startZ = rPos.z + root.diskHeight + root.coneHeight;
                            contextStart = { x: rPos.x, y: rPos.y, z: startZ };
                        }

                        const newTrunk = moveJoint(
                            trunk,
                            activeJointId.current!,
                            newPosVec3,
                            undefined,
                            false,
                            root,
                            contextStart
                        );
                        updateTrunk(newTrunk);

                        // Check for Clamping Warning
                        let foundJointPos: Vec3 | null = null;
                        for (const s of newTrunk.segments) {
                            if (s.topJoint?.id === activeJointId.current) foundJointPos = s.topJoint.pos;
                            if (s.bottomJoint?.id === activeJointId.current) foundJointPos = s.bottomJoint.pos;
                        }

                        if (foundJointPos) {
                            const dist = new THREE.Vector3(foundJointPos.x, foundJointPos.y, foundJointPos.z).distanceTo(newPos);
                            if (dist > 0.05) { // 0.05mm tolerance
                                setInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
                            } else {
                                setInteractionWarning(null);
                            }
                        }
                    }
                } else if (activeBranchId.current) {
                    // Update branch
                    const branch = getBranchById(activeBranchId.current);
                    if (branch) {
                        // Resolve Context
                        const knot = getKnotById(branch.parentKnotId);
                        let contextStart: Vec3 | undefined;
                        if (knot) {
                            contextStart = knot.pos;
                        } else {
                            console.warn('[JointInteraction] Warning: Parent Knot not found for branch', branch.id, branch.parentKnotId);
                        }

                        const newBranch = moveJoint(
                            branch as any,
                            activeJointId.current!,
                            newPosVec3,
                            undefined,
                            false,
                            undefined, // No root for branch?
                            contextStart
                        ) as unknown as Branch;
                        updateBranch(newBranch);

                        // Check for Clamping Warning
                        let foundJointPos: Vec3 | null = null;
                        for (const s of newBranch.segments) {
                            if (s.topJoint?.id === activeJointId.current) foundJointPos = s.topJoint.pos;
                            if (s.bottomJoint?.id === activeJointId.current) foundJointPos = s.bottomJoint.pos;
                        }

                        if (foundJointPos) {
                            const dist = new THREE.Vector3(foundJointPos.x, foundJointPos.y, foundJointPos.z).distanceTo(newPos);
                            if (dist > 0.05) {
                                setInteractionWarning('SHAFT_ANGLE_TOO_FLAT');
                            } else {
                                setInteractionWarning(null);
                            }
                        }
                    }
                }
            }
        }
    });
}
