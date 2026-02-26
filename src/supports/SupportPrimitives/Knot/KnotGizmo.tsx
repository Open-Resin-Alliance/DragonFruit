import React, { useSyncExternalStore, useCallback, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { subscribe, getSnapshot, getKnotById, getTrunks, getBranches, getTwigs, getSticks, getRootById, updateKnot, updateBranch, getBranchById, getTrunkById, getTwigById, getStickById } from '../../state';
import { Knot } from '../../types';
import { getTrunkSegmentEndpoints, getBranchSegmentEndpoints, projectOntoSegment } from './knotUtils';
import { usePicking } from '@/components/picking';
import { ElasticChainInitialState, solveElasticChain } from '../../PlacementLogic/ElasticChainSolver';
import { getSettings } from '../../Settings';
import { getSocketPosition } from '../ContactCone';

/**
 * KnotGizmo - A gizmo for moving knots along their parent shaft
 * 
 * Shows two arrows (up/down along shaft) that can be dragged to slide the knot.
 */
export function KnotGizmo() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const selectedId = state.selectedId;
    const selectedCategory = state.selectedCategory;
    const { camera, raycaster, pointer } = useThree();

    const isDraggingRef = useRef(false);
    const shaftAxisRef = useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 1));
    const shaftStartRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const shaftEndRef = useRef<THREE.Vector3>(new THREE.Vector3());
    const selectedKnotParentRef = useRef<{
        selectedId: string;
        parentShaftId: string;
        kind: 'trunk' | 'branch' | 'twig' | 'stick';
        supportId: string;
        segmentIndex: number;
    } | null>(null);

    // Elastic chain state - captured at drag start
    const elasticStateRef = useRef<Record<string, ElasticChainInitialState>>({});

    const [hoveredArrow, setHoveredArrow] = React.useState<'up' | 'down' | null>(null);
    const [scale, setScale] = React.useState(1);

    const setKnotGizmoInteractionFlags = useCallback((isDragging: boolean, postGuardMs = 180) => {
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

    // Picking registration for gizmo handles
    const upArrowRef = useRef<THREE.Group>(null);
    const downArrowRef = useRef<THREE.Group>(null);
    const { register, unregister, hit } = usePicking();
    const upPickIdRef = useRef<number | null>(null);
    const downPickIdRef = useRef<number | null>(null);

    // Register arrows with picking system
    useEffect(() => {
        if (upArrowRef.current && selectedCategory === 'knot') {
            upPickIdRef.current = register({
                category: 'gizmo',
                objectId: 'knot-gizmo-up',
                object: upArrowRef.current,
            });
        }
        return () => {
            if (upPickIdRef.current !== null) {
                unregister(upPickIdRef.current);
                upPickIdRef.current = null;
            }
        };
    }, [register, unregister, selectedCategory]);

    useEffect(() => {
        if (downArrowRef.current && selectedCategory === 'knot') {
            downPickIdRef.current = register({
                category: 'gizmo',
                objectId: 'knot-gizmo-down',
                object: downArrowRef.current,
            });
        }
        return () => {
            if (downPickIdRef.current !== null) {
                unregister(downPickIdRef.current);
                downPickIdRef.current = null;
            }
        };
    }, [register, unregister, selectedCategory]);

    // Find the selected knot and its parent shaft
    const findKnotAndShaft = useCallback((): {
        knot: Knot,
        start: THREE.Vector3,
        end: THREE.Vector3,
        axis: THREE.Vector3
    } | null => {
        if (!selectedId) return null;

        const knot = getKnotById(selectedId);
        if (!knot) return null;

        const cached = selectedKnotParentRef.current;
        if (cached && cached.selectedId === selectedId && cached.parentShaftId === knot.parentShaftId) {
            if (cached.kind === 'trunk') {
                const trunk = getTrunkById(cached.supportId);
                const seg = trunk?.segments[cached.segmentIndex];
                const root = trunk ? getRootById(trunk.rootId) : null;
                if (trunk && seg && seg.id === knot.parentShaftId && root) {
                    const endpoints = getTrunkSegmentEndpoints(trunk, seg, cached.segmentIndex, root);
                    if (endpoints) {
                        const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                        const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                        const axis = new THREE.Vector3().subVectors(end, start).normalize();
                        return { knot, start, end, axis };
                    }
                }
            } else if (cached.kind === 'branch') {
                const branch = getBranchById(cached.supportId);
                const seg = branch?.segments[cached.segmentIndex];
                const parentKnot = branch ? getKnotById(branch.parentKnotId) : null;
                if (branch && seg && seg.id === knot.parentShaftId && parentKnot) {
                    const endpoints = getBranchSegmentEndpoints(branch, seg, cached.segmentIndex, parentKnot);
                    if (endpoints) {
                        const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                        const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                        const axis = new THREE.Vector3().subVectors(end, start).normalize();
                        return { knot, start, end, axis };
                    }
                }
            } else if (cached.kind === 'twig') {
                const twig = getTwigById(cached.supportId);
                const seg = twig?.segments[cached.segmentIndex];
                if (twig && seg && seg.id === knot.parentShaftId && seg.bottomJoint && seg.topJoint) {
                    const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                    const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    return { knot, start, end, axis };
                }
            } else {
                const stick = getStickById(cached.supportId);
                const seg = stick?.segments[cached.segmentIndex];
                if (stick && seg && seg.id === knot.parentShaftId && seg.bottomJoint && seg.topJoint) {
                    const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
                    const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    return { knot, start, end, axis };
                }
            }

            selectedKnotParentRef.current = null;
        }

        // Find parent shaft in trunks
        const trunks = getTrunks();
        for (const trunk of trunks) {
            const idx = trunk.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx !== -1) {
                const root = getRootById(trunk.rootId);
                if (!root) continue;
                const seg = trunk.segments[idx];
                const endpoints = getTrunkSegmentEndpoints(trunk, seg, idx, root);
                if (endpoints) {
                    const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                    const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    selectedKnotParentRef.current = {
                        selectedId,
                        parentShaftId: knot.parentShaftId,
                        kind: 'trunk',
                        supportId: trunk.id,
                        segmentIndex: idx,
                    };
                    return { knot, start, end, axis };
                }
            }
        }

        // Find parent shaft in branches
        const branches = getBranches();
        for (const branch of branches) {
            const idx = branch.segments.findIndex(s => s.id === knot.parentShaftId);
            if (idx !== -1) {
                const parentKnot = getKnotById(branch.parentKnotId);
                if (!parentKnot) continue;
                const seg = branch.segments[idx];
                const endpoints = getBranchSegmentEndpoints(branch, seg, idx, parentKnot);
                if (endpoints) {
                    const start = new THREE.Vector3(endpoints.start.x, endpoints.start.y, endpoints.start.z);
                    const end = new THREE.Vector3(endpoints.end.x, endpoints.end.y, endpoints.end.z);
                    const axis = new THREE.Vector3().subVectors(end, start).normalize();
                    selectedKnotParentRef.current = {
                        selectedId,
                        parentShaftId: knot.parentShaftId,
                        kind: 'branch',
                        supportId: branch.id,
                        segmentIndex: idx,
                    };
                    return { knot, start, end, axis };
                }
            }
        }

         // Find parent shaft in twigs
         const twigs = getTwigs();
         for (const twig of twigs) {
             const idx = twig.segments.findIndex(s => s.id === knot.parentShaftId);
             if (idx === -1) continue;
             const seg = twig.segments[idx];
             if (!seg.bottomJoint || !seg.topJoint) continue;
             const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
             const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
             const axis = new THREE.Vector3().subVectors(end, start).normalize();
             selectedKnotParentRef.current = {
                 selectedId,
                 parentShaftId: knot.parentShaftId,
                 kind: 'twig',
                 supportId: twig.id,
                 segmentIndex: idx,
             };
             return { knot, start, end, axis };
         }

         // Find parent shaft in sticks
         const sticks = getSticks();
         for (const stick of sticks) {
             const idx = stick.segments.findIndex(s => s.id === knot.parentShaftId);
             if (idx === -1) continue;
             const seg = stick.segments[idx];
             if (!seg.bottomJoint || !seg.topJoint) continue;
             const start = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
             const end = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
             const axis = new THREE.Vector3().subVectors(end, start).normalize();
             selectedKnotParentRef.current = {
                 selectedId,
                 parentShaftId: knot.parentShaftId,
                 kind: 'stick',
                 supportId: stick.id,
                 segmentIndex: idx,
             };
             return { knot, start, end, axis };
         }

        selectedKnotParentRef.current = null;
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId, state]);

    const result = findKnotAndShaft();

    // Update scale based on camera distance
    useFrame(() => {
        // Only show gizmo when a knot is selected
        if (selectedCategory !== 'knot') return;
        if (!result) return;
        const knotPos = new THREE.Vector3(result.knot.pos.x, result.knot.pos.y, result.knot.pos.z);
        const distance = camera.position.distanceTo(knotPos);
        const nextScale = distance * 0.03;
        setScale((prev) => (Math.abs(prev - nextScale) > 0.01 ? nextScale : prev));

        // Update refs for drag
        shaftAxisRef.current.copy(result.axis);
        shaftStartRef.current.copy(result.start);
        shaftEndRef.current.copy(result.end);
    });

    // Handle drag with elastic chain constraints
    useFrame(() => {
        if (!isDraggingRef.current || !result) return;

        raycaster.setFromCamera(pointer, camera);
        const projected = projectOntoSegment(
            raycaster.ray,
            shaftStartRef.current,
            shaftEndRef.current
        );

        // Apply elastic chain constraints
        const settings = getSettings();
        const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;

        let finalKnotPos = projected.point;
        let wasLocked = false;

        // Run elastic solver for each attached branch
        for (const branchId in elasticStateRef.current) {
            const state = elasticStateRef.current[branchId];
            const res = solveElasticChain(finalKnotPos, state, maxAngleDeg);

            // If solver clamped the knot, use the clamped position
            if (res.isLocked && res.knotPos.z < finalKnotPos.z) {
                finalKnotPos = res.knotPos;
                wasLocked = true;
            }

            // Update branch joints
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
                updateBranch({ ...branch, segments: newSegments });
            }
        }

        // Recalculate t based on final position
        const lineVec = new THREE.Vector3().subVectors(shaftEndRef.current, shaftStartRef.current);
        const lenSq = lineVec.lengthSq();
        let t = projected.t;
        if (lenSq > 0.0001 && wasLocked) {
            const knotVec = new THREE.Vector3(finalKnotPos.x, finalKnotPos.y, finalKnotPos.z).sub(shaftStartRef.current);
            t = knotVec.dot(lineVec) / lenSq;
            t = Math.max(0, Math.min(1, t));
        }

        const updated: Knot = {
            ...result.knot,
            pos: finalKnotPos,
            t: t,
        };
        updateKnot(updated);
    });

    // Global mouseup listener to catch releases outside the arrows
    useEffect(() => {
        const handleGlobalMouseUp = () => {
            if (isDraggingRef.current) {
                isDraggingRef.current = false;
                setKnotGizmoInteractionFlags(false);
                // Set flag to prevent canvas click from deselecting
                (window as any).__gizmoDragEndedThisFrame = true;
                // Clear flag after a short delay
                setTimeout(() => {
                    (window as any).__gizmoDragEndedThisFrame = false;
                }, 100);
                // Reset cursor
                document.body.style.cursor = '';
            }
        };
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => {
            window.removeEventListener('mouseup', handleGlobalMouseUp);
            setKnotGizmoInteractionFlags(false, 0);
        };
    }, [setKnotGizmoInteractionFlags]);

    // Only show gizmo when a knot is selected
    if (selectedCategory !== 'knot' || !result) return null;

    const { knot, axis } = result;
    const knotPos = new THREE.Vector3(knot.pos.x, knot.pos.y, knot.pos.z);

    // Use a minimum scale to ensure visibility
    const effectiveScale = Math.max(scale, 2);

    // Arrow positions along the axis
    const arrowOffset = effectiveScale * 1.5;
    const upArrowPos = knotPos.clone().add(axis.clone().multiplyScalar(arrowOffset));
    const downArrowPos = knotPos.clone().add(axis.clone().multiplyScalar(-arrowOffset));

    // Calculate rotation to align arrows with shaft axis
    const upQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    const downQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().negate());

    const handlePointerDown = (e: any) => {
        e.stopPropagation();
        if (e.nativeEvent) {
            e.nativeEvent.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
        }
        isDraggingRef.current = true;
        setKnotGizmoInteractionFlags(true);
        (window as any).__gizmoDragEndedThisFrame = false;
        document.body.style.cursor = 'grabbing';

        // Capture elastic state for attached branches
        if (result) {
            const allBranches = getBranches();
            const attached = allBranches.filter(b => b.parentKnotId === result.knot.id);
            const state: Record<string, ElasticChainInitialState> = {};

            for (const b of attached) {
                const joints: { id: string; pos: { x: number, y: number, z: number } }[] = [];

                for (let i = 0; i < b.segments.length; i++) {
                    const seg = b.segments[i];
                    let joint = seg.topJoint;
                    if (!joint && i < b.segments.length - 1) {
                        joint = b.segments[i + 1].bottomJoint;
                    }
                    if (joint) {
                        joints.push({ id: joint.id, pos: { ...joint.pos } });
                    }
                }

                state[b.id] = {
                    branchId: b.id,
                    knotPos: { ...result.knot.pos },
                    joints,
                    // Use SOCKET position (where shaft connects), not TIP position (where cone touches model)
                    contactCone: b.contactCone ? {
                        pos: getSocketPosition(b.contactCone.pos, b.contactCone.normal, b.contactCone.profile)
                    } : undefined
                };
            }

            elasticStateRef.current = state;
            console.log('[KnotGizmo] Captured elastic state for', Object.keys(state).length, 'branches');
        }
    };

    const handlePointerUp = (e: any) => {
        if (e) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
        }
        if (isDraggingRef.current) {
            isDraggingRef.current = false;
            setKnotGizmoInteractionFlags(false);
            // Set flag to prevent canvas click from deselecting
            (window as any).__gizmoDragEndedThisFrame = true;
            // Also set a short timeout to ensure the flag persists
            setTimeout(() => {
                (window as any).__gizmoDragEndedThisFrame = false;
            }, 100);
        }
        document.body.style.cursor = '';
    };

    const handlePointerEnterGizmo = () => {
        document.body.style.cursor = 'grab';
    };

    const handlePointerLeaveGizmo = () => {
        if (!isDraggingRef.current) {
            document.body.style.cursor = '';
        }
    };

    // Prevent click from propagating to supports underneath
    const handleClick = (e: any) => {
        e.stopPropagation();
        if (e.nativeEvent) {
            e.nativeEvent.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
        }
    };

    // Arrow geometry - use effectiveScale for sizing (smaller arrows)
    const arrowLength = effectiveScale * 0.4;
    const arrowRadius = effectiveScale * 0.08;
    const coneLength = effectiveScale * 0.25;
    const coneRadius = effectiveScale * 0.15;

    // Offset from knot center - arrows start just outside the knot
    const knotRadius = (knot.diameter ?? 1.2) / 2;
    const gapFromKnot = knotRadius + 0.2; // Small gap from knot surface


    return (
        <group renderOrder={999}>
            {/* Central grab sphere - allows grabbing the knot directly */}
            <mesh
                position={[knotPos.x, knotPos.y, knotPos.z]}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerEnter={handlePointerEnterGizmo}
                onPointerLeave={handlePointerLeaveGizmo}
                renderOrder={999}
            >
                <sphereGeometry args={[knotRadius * 1.5, 16, 16]} />
                <meshBasicMaterial transparent opacity={0} depthTest={false} />
            </mesh>

            {/* Up arrow (towards tip) - starts from knot, points along axis */}
            <group
                ref={upArrowRef}
                position={[knotPos.x, knotPos.y, knotPos.z]}
                quaternion={upQuat}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerEnter={() => { setHoveredArrow('up'); handlePointerEnterGizmo(); }}
                onPointerLeave={() => { setHoveredArrow(null); handlePointerLeaveGizmo(); }}
            >
                {/* Shaft - offset from knot center */}
                <mesh position={[0, gapFromKnot + arrowLength / 2, 0]} renderOrder={999}>
                    <cylinderGeometry args={[arrowRadius, arrowRadius, arrowLength, 8]} />
                    <meshBasicMaterial
                        color={hoveredArrow === 'up' ? '#80ffff' : '#ffffff'}
                        depthTest={false}
                        transparent
                        opacity={hoveredArrow === 'up' ? 1.0 : 0.85}
                    />
                </mesh>
                {/* Cone */}
                <mesh position={[0, gapFromKnot + arrowLength + coneLength / 2, 0]} renderOrder={999}>
                    <coneGeometry args={[coneRadius, coneLength, 8]} />
                    <meshBasicMaterial
                        color={hoveredArrow === 'up' ? '#80ffff' : '#ffffff'}
                        depthTest={false}
                        transparent
                        opacity={hoveredArrow === 'up' ? 1.0 : 0.85}
                    />
                </mesh>
            </group>

            {/* Down arrow (towards base) - starts from knot, points opposite to axis */}
            <group
                ref={downArrowRef}
                position={[knotPos.x, knotPos.y, knotPos.z]}
                quaternion={downQuat}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerEnter={() => { setHoveredArrow('down'); handlePointerEnterGizmo(); }}
                onPointerLeave={() => { setHoveredArrow(null); handlePointerLeaveGizmo(); }}
            >
                {/* Shaft - offset from knot center */}
                <mesh position={[0, gapFromKnot + arrowLength / 2, 0]} renderOrder={999}>
                    <cylinderGeometry args={[arrowRadius, arrowRadius, arrowLength, 8]} />
                    <meshBasicMaterial
                        color={hoveredArrow === 'down' ? '#80ffff' : '#ffffff'}
                        depthTest={false}
                        transparent
                        opacity={hoveredArrow === 'down' ? 1.0 : 0.85}
                    />
                </mesh>
                {/* Cone */}
                <mesh position={[0, gapFromKnot + arrowLength + coneLength / 2, 0]} renderOrder={999}>
                    <coneGeometry args={[coneRadius, coneLength, 8]} />
                    <meshBasicMaterial
                        color={hoveredArrow === 'down' ? '#80ffff' : '#ffffff'}
                        depthTest={false}
                        transparent
                        opacity={hoveredArrow === 'down' ? 1.0 : 0.85}
                    />
                </mesh>
            </group>
        </group>
    );
}
