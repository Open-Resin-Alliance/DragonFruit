import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Knot } from '../../types';
import { usePicking } from '@/components/picking';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getSnapshot, subscribe } from '../../state';
import { handleKnotClick } from '../../interaction/clickHandlers';

interface KnotRendererProps {
    knot: Knot;
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

export function KnotRenderer({
    knot,
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
    enablePicking = true,
}: KnotRendererProps) {
    const resolvedDiameter = knot.diameter ?? 1.2;
    const blendedDiameter = Math.max(0.001, resolvedDiameter - JOINT_DIAMETER_OFFSET_MM);
    const displayDiameter = isParentSelected ? resolvedDiameter : blendedDiameter;
    const radius = displayDiameter / 2;
    const groupRef = useRef<THREE.Group>(null);

    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const isSelected = state.selectedId === knot.id;

    const pickIdRef = useRef<number | null>(null);
    const { register, unregister, hit } = usePicking();

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
            category: 'knot',
            objectId: knot.id,
            object: groupRef.current,
        });

        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, knot.id, enablePicking, isParentSelected]);

    const isHovered =
        hit.category === 'knot' && hit.objectId === knot.id && !isSelected && isParentSelected;

    const displayColor = isSelected ? '#1a75ff' : (isParentSelected ? '#00ff00' : propColor);
    const displayEmissive = isHovered ? '#ffffff' : propEmissive;
    const displayEmissiveIntensity = isHovered ? 0.5 : propEmissiveIntensity;

    // Get drag callbacks from picking
    const { onDragStart, onDragEnd } = usePicking();

    const handleClick = (e: any) => {
        handleKnotClick(e, knot.id, !!isInteractable, isParentSelected, isSelected, (id) => {
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

    // Hide entirely when parent is not selected — eliminates all sphere geometry from render
    if (!isParentSelected) return null;

    const hitboxRadius = radius * 2.0;

    return (
        <group
            ref={groupRef}
            position={[knot.pos.x, knot.pos.y, knot.pos.z]}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerLeave={handlePointerLeave}
        >
            <mesh raycast={raycast}>
                <sphereGeometry args={[hitboxRadius, 8, 8]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh raycast={raycast}>
                <sphereGeometry args={[radius, 8, 8]} />
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
