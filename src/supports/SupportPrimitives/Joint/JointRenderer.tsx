import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Joint } from '../../types';
import { usePicking } from '@/components/picking';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getSelectedId, subscribe } from '../../state';
import { handleJointClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';
import { useJointDragPosition } from '../../interaction/jointDragPosition';
import { isSupportEditInteractionActive } from '../../interaction/gizmoInteractionLock';

interface JointRendererProps {
    joint: Joint;
    // Optional overrides from parent
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    selectedColor?: string;
    onClick?: (e: any) => void;
    onSelect?: (id: string) => void;
    transparent?: boolean;
    opacity?: number;
    isInteractable?: boolean;
    isParentSelected?: boolean;
    raycast?: any;
    enablePicking?: boolean;
    // When set, this joint behaves as a visual extension of the named disk:
    // skips its own picking/click/drag, and treats the disk's selection
    // state as its own. Used for Twig disk-end joints so the joint and disk
    // act as one selectable part.
    attachedToDiskId?: string;
}

export function JointRenderer({ 
    joint, 
    color: propColor = '#c8752a', 
    emissive: propEmissive = '#000000', 
    emissiveIntensity: propEmissiveIntensity = 0,
    selectedColor: _selectedColor,
    onClick,
    onSelect,
    transparent = false,
    opacity = 1,
    isInteractable = true,
    isParentSelected = false,
    raycast,
    enablePicking = true,
    attachedToDiskId,
}: JointRendererProps) {
    const resolvedDiameter = joint.diameter ?? 0;
    const blendedDiameter = Math.max(0.001, resolvedDiameter - JOINT_DIAMETER_OFFSET_MM * 0.75);
    const displayDiameter = isParentSelected ? resolvedDiameter : blendedDiameter;
    const radius = displayDiameter / 2;
    const groupRef = useRef<THREE.Group>(null);
    const [frontBlockingModelId, setFrontBlockingModelId] = useState<string | null>(null);
    const [pointerHoverActive, setPointerHoverActive] = useState(false);

    // State Subscription. When attached to a disk, mirror the disk's selection
    // state instead of having an independent one.
    const selectedId = useSyncExternalStore(subscribe, getSelectedId, getSelectedId);
    const isSelected = attachedToDiskId
        ? selectedId === attachedToDiskId
        : selectedId === joint.id;

    // GPU Picking Setup
    const pickIdRef = useRef<number | null>(null);
    const { register, unregister, hit, onDragStart, onDragEnd, isDragging } = usePicking();

    // Register with picking system - only when parent is selected
    // When parent is NOT selected, we don't register so picking falls through to the support.
    // When attached to a disk, the disk is the pick target; this joint never registers.
    useEffect(() => {
        if (!groupRef.current || !enablePicking || !isParentSelected || attachedToDiskId) {
            // Unregister if we were registered
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
            return;
        }

        pickIdRef.current = register({
            category: 'joint',
            objectId: joint.id,
            object: groupRef.current,
        });

        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, joint.id, enablePicking, isParentSelected, attachedToDiskId]);

    // Determine Hover State
    // Only show hover if parent is selected (editable mode) AND joint is not already selected
    const isTopPickedJoint = frontBlockingModelId === null
        && isInteractable
        && !isDragging
        && !isSupportEditInteractionActive()
        && hit.category === 'joint'
        && hit.objectId === joint.id
        && isParentSelected;
    const isHovered = !isDragging
        && !isSupportEditInteractionActive()
        && !isSelected
        && isParentSelected
        && (isTopPickedJoint || pointerHoverActive);
    
    // Visual State
    // If hovered, glow white. If selected, be blue. Else default/prop color.
    const displayColor = isSelected ? '#1a75ff' : (isHovered ? '#efd8c2' : (isParentSelected ? '#888888' : propColor));
    const displayEmissive = isHovered ? '#efd8c2' : propEmissive;
    const displayEmissiveIntensity = isHovered ? 0.18 : propEmissiveIntensity;

    const jointDragPosition = useJointDragPosition(joint.id);
    const effectiveJointPos = jointDragPosition ?? joint.pos;

    const isPointerOverThisJoint = (e: any): boolean => {
        if (!groupRef.current) return false;
        const intersections = Array.isArray(e?.intersections) ? e.intersections : [];
        for (const intersection of intersections) {
            let current = (intersection as { object?: THREE.Object3D | null })?.object ?? null;
            while (current) {
                if (current === groupRef.current) return true;
                current = current.parent;
            }
        }
        return false;
    };

    const handleClick = (e: any) => {
        // When attached to a disk, the joint is purely visual; clicks should
        // fall through to the disk's own handlers.
        if (attachedToDiskId) return;

        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            setFrontBlockingModelId((prev) => (prev === frontModelId ? prev : frontModelId));
            emitImmediateModelHover(frontModelId);
            return;
        }

        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
            emitImmediateModelHover(null);
        }

        const pointerOverJoint = isPointerOverThisJoint(e);
        if (!pointerOverJoint || !isParentSelected) return;
        handleJointClick(e, joint.id, !!isInteractable, isParentSelected, isSelected, (id) => {
            if (onSelect) onSelect(id);
            if (onClick) onClick(e);
        });
    };

    // Handle pointer down for direct dragging (left-click only)
    const handlePointerDown = (e: any) => {
        // When attached to a disk, the joint is not independently draggable.
        if (attachedToDiskId) return;

        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            setFrontBlockingModelId((prev) => (prev === frontModelId ? prev : frontModelId));
            emitImmediateModelHover(frontModelId);
            return;
        }

        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
            emitImmediateModelHover(null);
        }

        // Only allow left-click (button 0) for dragging
        if (e.button !== 0) return;
        const pointerOverJoint = isPointerOverThisJoint(e);
        if (!isParentSelected || !isInteractable || !pointerOverJoint) return;

        e.stopPropagation();
        
        // Select this joint if not already selected
        if (!isSelected) {
            selectPrimitiveById(joint.id);
        }
        
        // Start drag operation
        onDragStart();
        document.body.style.cursor = 'grabbing';
        
        // Global mouse up to end drag
        const handleMouseUp = () => {
            onDragEnd();
            // Always clear to '' on release — if still hovering, the next
            // pointermove/enter will re-apply 'grab' via the effect below.
            document.body.style.cursor = '';
            window.removeEventListener('mouseup', handleMouseUp);
        };
        window.addEventListener('mouseup', handleMouseUp);
    };
    
    // Grab cursor on hover when parent is selected
    // Check isHovered which already accounts for isParentSelected
    React.useEffect(() => {
        if (isHovered && isInteractable) {
            document.body.style.cursor = 'grab';
        } else {
            document.body.style.cursor = '';
        }
    }, [isHovered, isInteractable]);
    
    const handlePointerMove = (e: any) => {
        if (isDragging || isSupportEditInteractionActive()) {
            setPointerHoverActive(false);
            emitImmediateModelHover(null);
            return;
        }

        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            setPointerHoverActive(false);
            setFrontBlockingModelId((prev) => (prev === frontModelId ? prev : frontModelId));
            emitImmediateModelHover(frontModelId);
            return;
        }

        const pointerOverJoint = isPointerOverThisJoint(e);
        setPointerHoverActive(pointerOverJoint && isParentSelected && isInteractable);

        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
        }
        emitImmediateModelHover(null);
    };

    const handlePointerLeave = () => {
        setPointerHoverActive(false);
        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
        }
        emitImmediateModelHover(null);
        document.body.style.cursor = '';
    };

    useEffect(() => {
        if (!isParentSelected || !isInteractable || isDragging || isSupportEditInteractionActive()) {
            setPointerHoverActive(false);
        }
    }, [isParentSelected, isInteractable, isDragging]);
    
    const hitboxRadius = isParentSelected ? radius * 1.15 : radius;

    // Joints attached to a disk must not absorb pointer events — those go
    // straight to the disk so the joint+disk behave as one selectable part.
    const noopRaycast = () => {};
    const meshRaycast = attachedToDiskId ? (noopRaycast as any) : raycast;

    return (
        <group
            ref={groupRef}
            position={[effectiveJointPos.x, effectiveJointPos.y, effectiveJointPos.z]}
            userData={{ supportPrimitiveType: 'joint' }}
            onClick={attachedToDiskId ? undefined : handleClick}
            onPointerDown={attachedToDiskId ? undefined : handlePointerDown}
            onPointerMove={attachedToDiskId ? undefined : handlePointerMove}
            onPointerLeave={attachedToDiskId ? undefined : handlePointerLeave}
        >
            {/* Hitbox Mesh - Only expanded when parent is selected */}
            <mesh raycast={meshRaycast} userData={{ supportPrimitiveType: 'joint' }}>
                <sphereGeometry args={[hitboxRadius, 16, 12]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>

            {/* Visual Mesh - Purely display */}
            <mesh raycast={meshRaycast} userData={{ supportPrimitiveType: 'joint' }}>
                <sphereGeometry args={[radius, 16, 12]} />
                <meshStandardMaterial 
                    color={displayColor} 
                    emissive={displayEmissive} 
                    emissiveIntensity={displayEmissiveIntensity}
                    roughness={1}
                    metalness={0}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                />
            </mesh>
        </group>
    );
}
