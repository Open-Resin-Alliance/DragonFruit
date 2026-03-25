import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { Knot } from '../../types';
import { usePicking } from '@/components/picking';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getSnapshot, setHoveredCategory, setHoveredId, subscribe } from '../../state';
import { handleKnotClick } from '../../interaction/clickHandlers';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../../interaction/pointerOcclusion';

interface KnotRendererProps {
    knot: Knot;
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

export function KnotRenderer({
    knot,
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
    enablePicking = true,
}: KnotRendererProps) {
    const resolvedDiameter = knot.diameter ?? 1.2;
    const blendedDiameter = Math.max(0.001, resolvedDiameter - JOINT_DIAMETER_OFFSET_MM);
    const displayDiameter = isParentSelected ? resolvedDiameter : blendedDiameter;
    const radius = displayDiameter / 2;
    const groupRef = useRef<THREE.Group>(null);
    const [frontBlockingModelId, setFrontBlockingModelId] = useState<string | null>(null);
    const [pointerHoverActive, setPointerHoverActive] = useState(false);

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

    const isTopPickedKnot = frontBlockingModelId === null
        && hit.category === 'knot'
        && hit.objectId === knot.id
        && isParentSelected;
    const isHovered = (isTopPickedKnot || pointerHoverActive) && !isSelected;

    const displayColor = isSelected ? '#1a75ff' : (isHovered ? '#ffffff' : (isParentSelected ? '#00ff00' : propColor));
    const displayEmissive = isHovered ? '#ffffff' : propEmissive;
    const displayEmissiveIntensity = isHovered ? 0.5 : propEmissiveIntensity;

    const isPointerOverThisKnot = (e: any): boolean => {
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

    // Get drag callbacks from picking
    const { onDragStart, onDragEnd } = usePicking();

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

        const pointerOverKnot = isPointerOverThisKnot(e);
        if (!pointerOverKnot || !isParentSelected) return;
        handleKnotClick(e, knot.id, !!isInteractable, isParentSelected, isSelected, (id) => {
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
        const pointerOverKnot = isPointerOverThisKnot(e);
        if (!isParentSelected || !isInteractable || !pointerOverKnot) return;

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

    React.useEffect(() => {
        if (!isParentSelected || !pointerHoverActive) return;
        if (state.hoveredCategory !== 'knot' || state.hoveredId !== knot.id) {
            setHoveredCategory('knot');
            setHoveredId(knot.id);
        }
    }, [isParentSelected, knot.id, pointerHoverActive, state.hoveredCategory, state.hoveredId]);

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

        const pointerOverKnot = isPointerOverThisKnot(e);
        if (!pointerOverKnot || !isParentSelected) {
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
        if (state.hoveredCategory === 'knot' && state.hoveredId === knot.id) {
            setHoveredCategory('none');
            setHoveredId(null);
        }
        emitImmediateModelHover(null);
        document.body.style.cursor = '';
    };

    const hitboxRadius = isParentSelected ? radius * 1.2 : radius;

    return (
        <group
            ref={groupRef}
            position={[knot.pos.x, knot.pos.y, knot.pos.z]}
            userData={{ supportPrimitiveType: 'knot' }}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
        >
            <mesh raycast={raycast} userData={{ supportPrimitiveType: 'knot' }}>
                <sphereGeometry args={[hitboxRadius, 8, 8]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh raycast={raycast} userData={{ supportPrimitiveType: 'knot' }}>
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
