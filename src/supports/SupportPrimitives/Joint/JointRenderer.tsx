import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Joint } from '../../types';
import { usePicking } from '@/components/picking';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { subscribe, getSnapshot, setSelectedId } from '../../state';
import { handleJointClick } from '../../interaction/clickHandlers';

interface JointRendererProps {
    joint: Joint;
    // Optional overrides from parent
    color?: string; 
    emissive?: string;
    emissiveIntensity?: number;
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
    const blendedDiameter = Math.max(0.001, resolvedDiameter - JOINT_DIAMETER_OFFSET_MM);
    const displayDiameter = isParentSelected ? resolvedDiameter : blendedDiameter;
    const radius = displayDiameter / 2;
    const groupRef = useRef<THREE.Group>(null);
    
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
    const isHovered = (hit.category === 'joint' && hit.objectId === joint.id) && !isSelected && isParentSelected;
    
    // Visual State
    // If hovered, glow white. If selected, be blue. Else default/prop color.
    const displayColor = isSelected ? '#1a75ff' : (isParentSelected ? '#888888' : propColor);
    const displayEmissive = isHovered ? '#ffffff' : propEmissive;
    const displayEmissiveIntensity = isHovered ? 0.5 : propEmissiveIntensity;

    const handleClick = (e: any) => {
        handleJointClick(e, joint.id, !!isInteractable, isParentSelected, isSelected, (id) => {
            if (onSelect) onSelect(id);
            if (onClick) onClick(e);
        });
    };
    
    // Handle pointer down for direct dragging (left-click only)
    const handlePointerDown = (e: any) => {
        // Only allow left-click (button 0) for dragging
        if (e.button !== 0) return;
        if (!isParentSelected || !isInteractable) return;
        
        e.stopPropagation();
        
        // Select this joint if not already selected
        if (!isSelected) {
            setSelectedId(joint.id);
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
    
    const handlePointerLeave = () => {
        document.body.style.cursor = '';
    };
    
    // Only use expanded hitbox when parent is selected (editable mode)
    // Otherwise, use the visual radius so it doesn't block support hover
    const hitboxRadius = isParentSelected ? radius * 2.5 : radius;

    return (
        <group 
            ref={groupRef}
            position={[joint.pos.x, joint.pos.y, joint.pos.z]}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerLeave={handlePointerLeave}
        >
            {/* Hitbox Mesh - Only expanded when parent is selected */}
            <mesh raycast={raycast}>
                <sphereGeometry args={[hitboxRadius, 16, 16]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>

            {/* Visual Mesh - Purely display */}
            <mesh raycast={raycast}>
                <sphereGeometry args={[radius, 16, 16]} />
                <meshStandardMaterial 
                    color={displayColor} 
                    emissive={displayEmissive} 
                    emissiveIntensity={displayEmissiveIntensity}
                    metalness={0.3}
                    roughness={0.6}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                />
            </mesh>
        </group>
    );
}
