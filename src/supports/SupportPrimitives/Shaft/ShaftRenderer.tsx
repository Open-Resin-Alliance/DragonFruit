import React, { useState } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../../types';
import { usePickingSubscription } from '@/components/picking';
import { useBracePlacementState } from '../../SupportTypes/Brace/bracePlacementState';
import { useKickstandPlacementState } from '../../SupportTypes/Kickstand/kickstandPlacementState';
import { emitImmediateModelHover } from '../../interaction/pointerOcclusion';

const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

interface ShaftRendererProps {
    id: string;
    start: Vec3;
    end: Vec3;
    diameter: number;
    diameterStart?: number;
    diameterEnd?: number;
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    selectedColor?: string;
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    enablePicking?: boolean;
    isSelected?: boolean;
    isParentSelected?: boolean;
    onClick?: (e: any) => void;
    onPointerMove?: (e: any) => void;
    radialSegments?: number;
}

export function ShaftRenderer({ 
    id,
    start, 
    end, 
    diameter, 
    diameterStart,
    diameterEnd,
    color = '#ff8800', 
    emissive = '#000000', 
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    raycast,
    enablePicking = true,
    isSelected,
    isParentSelected,
    onClick,
    onPointerMove,
    radialSegments = 16,
}: ShaftRendererProps) {
    const radiusStart = (diameterStart ?? diameter) / 2;
    const radiusEnd = (diameterEnd ?? diameter) / 2;
    const selectedVisualScale = isSelected ? 1.03 : 1;
    const visualRadiusStart = radiusStart * selectedVisualScale;
    const visualRadiusEnd = radiusEnd * selectedVisualScale;
    const pickRadiusStart = visualRadiusStart;
    const pickRadiusEnd = visualRadiusEnd;

    const { altActive: braceAltActive } = useBracePlacementState();
    const { hotkeyActive: kickstandHotkeyActive } = useKickstandPlacementState();
    const enableSegmentInteraction = (isParentSelected || braceAltActive || kickstandHotkeyActive) === true;

    const { isHovered: isPickingHovered, pickRef } = usePickingSubscription({
        category: 'segment',
        objectId: id,
        enabled: !!enablePicking && enableSegmentInteraction,
    });
    const [pointerHoverActive, setPointerHoverActive] = useState(false);

    // Determine Hover State
    const isTopPickedSegment = enableSegmentInteraction && isPickingHovered;
    const isHovered = (isTopPickedSegment || pointerHoverActive)
        && !isSelected
        && isParentSelected;

    // Vector math
    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const endVec = new THREE.Vector3(end.x, end.y, end.z);
    
    const length = startVec.distanceTo(endVec);
    
    if (length < 0.001) return null;
    
    const midpoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(endVec, startVec).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);

    const rayIntersectsJointOrKnot = (e: any): boolean => {
        const intersections = Array.isArray(e?.intersections) ? e.intersections : [];
        for (const intersection of intersections) {
            let current = (intersection as { object?: THREE.Object3D | null })?.object ?? null;
            while (current) {
                const primitiveType = current.userData?.supportPrimitiveType;
                if (primitiveType === 'joint' || primitiveType === 'knot') {
                    return true;
                }
                current = current.parent;
            }
        }
        return false;
    };
    
    const handleClick = (e: any) => {
        if (rayIntersectsJointOrKnot(e)) return;

        const altDown = !!(e?.nativeEvent?.altKey || e?.altKey);
        const ctrlDown = !!(e?.nativeEvent?.ctrlKey || e?.ctrlKey);

        // If Alt is held, this click is intended for placement tools (Brace/Branch/etc.).
        // Stop propagation so it does not fall through to the canvas/model click handlers.
        if (altDown || ctrlDown) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
        }

        if ((altDown || ctrlDown || isParentSelected) && isTopPickedSegment) {
            // Emit global event for branch placement and editable-segment clicks only.
            window.dispatchEvent(new CustomEvent('shaft-click', {
                detail: {
                    segmentId: id,
                    point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                    intersection: e
                }
            }));
        }

        // Ctrl is reserved for Kickstand placement and should not re-select segments.
        if (ctrlDown) return;

        // When not in an editable context, let parent support handlers own the click.
        if (!isParentSelected && !altDown) return;

        if (isParentSelected && onClick) {
            e.stopPropagation();
            
            // Stop DOM propagation to prevent SceneCanvas handleCanvasClick from clearing selection
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }

            onClick(e);
        }
    };

    const finalColor = isSelected ? '#ffffff' : (isHovered ? '#ffffff' : color);
    const finalEmissive = isSelected ? '#444444' : (isHovered ? '#ffffff' : emissive);
    const finalEmissiveIntensity = isSelected ? 0.5 : (isHovered ? 0.5 : emissiveIntensity);
    
    // Handle pointer move for branch placement preview
    const handlePointerMove = (e: any) => {
        if (rayIntersectsJointOrKnot(e)) {
            setPointerHoverActive((prev) => (prev ? false : prev));
            return;
        }

        const topIntersectionObject = Array.isArray(e?.intersections)
            ? ((e.intersections[0] as { object?: THREE.Object3D | null } | undefined)?.object ?? null)
            : null;

        let isTopPointerTargetNow = false;
        let current = topIntersectionObject;
        while (current) {
            if (current === pickRef.current) {
                isTopPointerTargetNow = true;
                break;
            }
            current = current.parent;
        }
        emitImmediateModelHover(null);

        if (!isTopPointerTargetNow) {
            setPointerHoverActive((prev) => (prev ? false : prev));
            return;
        }

        if (isParentSelected) {
            setPointerHoverActive((prev) => (prev ? prev : true));
        }

        // Emit global event for branch placement preview
        window.dispatchEvent(new CustomEvent('shaft-hover', {
            detail: {
                segmentId: id,
                point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                intersection: e
            }
        }));

        if (onPointerMove) {
            onPointerMove(e);
        }
    };

    // Handle pointer leaving shaft - clear branch preview
    const handlePointerLeave = () => {
        setPointerHoverActive((prev) => (prev ? false : prev));
        emitImmediateModelHover(null);

        if (!enableSegmentInteraction) return;

        window.dispatchEvent(new CustomEvent('shaft-leave', {
            detail: { segmentId: id }
        }));
    };

    return (
        <group 
            position={[midpoint.x, midpoint.y, midpoint.z]} 
            quaternion={quaternion} 
            scale={[1, length, 1]}
            onClick={!enableSegmentInteraction ? handleClick : undefined}
            onPointerMove={!enableSegmentInteraction ? handlePointerMove : undefined}
            onPointerLeave={!enableSegmentInteraction ? handlePointerLeave : undefined}
        >
            {enableSegmentInteraction && (
                <mesh
                    ref={pickRef as any}
                    raycast={raycast}
                    onClick={handleClick}
                    onPointerMove={handlePointerMove}
                    onPointerLeave={handlePointerLeave}
                    userData={{ segmentId: id, supportPrimitiveType: 'shaft' }}
                >
                    <cylinderGeometry args={[pickRadiusEnd, pickRadiusStart, 1, Math.max(8, radialSegments)]} />
                    <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
            )}
            <mesh
                raycast={enableSegmentInteraction ? NOOP_RAYCAST : raycast}
                userData={enableSegmentInteraction ? { excludeFromPickingClone: true, supportPrimitiveType: 'shaft' } : { supportPrimitiveType: 'shaft' }}
            >
                <cylinderGeometry args={[visualRadiusEnd, visualRadiusStart, 1, radialSegments]} />
                <meshStandardMaterial 
                    color={finalColor} 
                    emissive={finalEmissive} 
                    emissiveIntensity={finalEmissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    polygonOffset={!!isSelected}
                    polygonOffsetFactor={isSelected ? -2 : 0}
                    polygonOffsetUnits={isSelected ? -2 : 0}
                />
            </mesh>
        </group>
    );
}
