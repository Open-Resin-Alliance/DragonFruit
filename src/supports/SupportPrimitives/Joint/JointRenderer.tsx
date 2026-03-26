import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Joint } from '../../types';
import { usePicking } from '@/components/picking';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { subscribe, getSnapshot } from '../../state';
import { handleJointClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';

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
}

export function JointRenderer({ 
    joint, 
    color: propColor = '#ff8800', 
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
    enablePicking = true
}: JointRendererProps) {
    const resolvedDiameter = joint.diameter ?? 0;
    const blendedDiameter = Math.max(0.001, resolvedDiameter - JOINT_DIAMETER_OFFSET_MM * 0.75);
    const displayDiameter = isParentSelected ? resolvedDiameter : blendedDiameter;
    const radius = displayDiameter / 2;
    const groupRef = useRef<THREE.Group>(null);
    const [frontBlockingModelId, setFrontBlockingModelId] = useState<string | null>(null);
    const [pointerHoverActive, setPointerHoverActive] = useState(false);

    // State Subscription
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const isSelected = state.selectedId === joint.id;

    // GPU Picking Setup
    const pickIdRef = useRef<number | null>(null);
    const { register, unregister, hit, onDragStart, onDragEnd } = usePicking();

    // Register with picking system - only when parent is selected
    // When parent is NOT selected, we don't register so picking falls through to the support
    useEffect(() => {
        if (!groupRef.current || !enablePicking || !isParentSelected) {
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
    }, [register, unregister, joint.id, enablePicking, isParentSelected]);

    // Determine Hover State
    // Only show hover if parent is selected (editable mode) AND joint is not already selected
    const isTopPickedJoint = frontBlockingModelId === null
        && hit.category === 'joint'
        && hit.objectId === joint.id
        && isParentSelected;
    const isHovered = (isTopPickedJoint || pointerHoverActive) && !isSelected;
    
    // Visual State
    // If hovered, glow white. If selected, be blue. Else default/prop color.
    const displayColor = isSelected ? '#1a75ff' : (isHovered ? '#ffffff' : (isParentSelected ? '#888888' : propColor));
    const displayEmissive = isHovered ? '#ffffff' : propEmissive;
    const displayEmissiveIntensity = isHovered ? 0.5 : propEmissiveIntensity;

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
            document.body.style.cursor = 'grab';
            window.removeEventListener('mouseup', handleMouseUp);
        };
        window.addEventListener('mouseup', handleMouseUp);
    };
    
    // Grab cursor on hover when parent is selected
    // Check isHovered which already accounts for isParentSelected
    React.useEffect(() => {
        if (isHovered && isInteractable) {
            document.body.style.cursor = 'grab';
        }
    }, [isHovered, isInteractable]);
    
    const handlePointerMove = (e: any) => {
        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            setFrontBlockingModelId((prev) => (prev === frontModelId ? prev : frontModelId));
            setPointerHoverActive((prev) => (prev ? false : prev));
            emitImmediateModelHover(frontModelId);
            return;
        }

        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
        }
        emitImmediateModelHover(null);

        const pointerOverJoint = isPointerOverThisJoint(e);
        if (!pointerOverJoint || !isParentSelected) {
            setPointerHoverActive((prev) => (prev ? false : prev));
            return;
        }

        if (isParentSelected && isInteractable) {
            setPointerHoverActive((prev) => (prev ? prev : true));
        }
    };

    const handlePointerLeave = () => {
        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
        }
        setPointerHoverActive((prev) => (prev ? false : prev));
        emitImmediateModelHover(null);
        document.body.style.cursor = '';
    };
    
    const hitboxRadius = isParentSelected ? radius * 1.15 : radius;

    return (
        <group 
            ref={groupRef}
            position={[joint.pos.x, joint.pos.y, joint.pos.z]}
            userData={{ supportPrimitiveType: 'joint' }}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
        >
            {/* Hitbox Mesh - Only expanded when parent is selected */}
            <mesh raycast={raycast} userData={{ supportPrimitiveType: 'joint' }}>
                <sphereGeometry args={[hitboxRadius, 16, 12]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>

            {/* Visual Mesh - Purely display */}
            <mesh raycast={raycast} userData={{ supportPrimitiveType: 'joint' }}>
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
