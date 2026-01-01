import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../../types';
import { usePicking } from '@/components/picking';
import { useBracePlacementState } from '../../SupportTypes/Brace/bracePlacementState';

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
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    enablePicking?: boolean;
    isSelected?: boolean;
    isParentSelected?: boolean;
    onClick?: (e: any) => void;
    onPointerMove?: (e: any) => void;
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
    onPointerMove
}: ShaftRendererProps) {
    const radiusStart = (diameterStart ?? diameter) / 2;
    const radiusEnd = (diameterEnd ?? diameter) / 2;
    const groupRef = useRef<THREE.Group>(null);

    const { altActive: braceAltActive } = useBracePlacementState();
    
    // GPU Picking Setup
    const pickIdRef = useRef<number | null>(null);
    const { register, unregister, hit } = usePicking();

    // Register with picking system
    // Always register so branch placement can detect shaft hovers/clicks
    useEffect(() => {
        if (!groupRef.current || !enablePicking) {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
            return;
        }

        // Expose segment id for snapping/branch placement
        groupRef.current.userData.segmentId = id;

        pickIdRef.current = register({
            category: 'segment',
            objectId: id,
            object: groupRef.current,
        });
        
        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, id, enablePicking]);

    // Determine Hover State
    const isPickingHovered = hit.category === 'segment' && hit.objectId === id;
    const isHovered = isPickingHovered && !isSelected && isParentSelected && !braceAltActive;

    // Vector math
    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const endVec = new THREE.Vector3(end.x, end.y, end.z);
    
    const length = startVec.distanceTo(endVec);
    
    if (length < 0.001) return null;
    
    const midpoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(endVec, startVec).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
    
    const handleClick = (e: any) => {
        // If Alt is held, this click is intended for placement tools (Brace/Branch/etc.).
        // Stop propagation so it does not fall through to the canvas/model click handlers.
        if (e?.nativeEvent?.altKey || e?.altKey) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
        }

        // Emit global event for branch placement
        window.dispatchEvent(new CustomEvent('shaft-click', {
            detail: {
                segmentId: id,
                point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                intersection: e
            }
        }));

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

    const finalColor = isSelected ? '#ffffff' : color; // White when selected, otherwise inherited (Cyan/Orange)
    const finalEmissive = isSelected ? '#444444' : (isHovered ? '#ffffff' : emissive);
    const finalEmissiveIntensity = isSelected ? 0.5 : (isHovered ? 0.3 : emissiveIntensity);
    
    // Handle pointer move for branch placement preview
    const handlePointerMove = (e: any) => {
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
    const handlePointerOut = () => {
        window.dispatchEvent(new CustomEvent('shaft-leave', {
            detail: { segmentId: id }
        }));
    };

    return (
        <group 
            ref={groupRef}
            position={[midpoint.x, midpoint.y, midpoint.z]} 
            quaternion={quaternion} 
            scale={[1, length, 1]}
            onClick={handleClick}
            onPointerMove={handlePointerMove}
            onPointerOut={handlePointerOut}
        >
            <mesh raycast={raycast}>
                <cylinderGeometry args={[radiusEnd, radiusStart, 1, 8]} />
                <meshStandardMaterial 
                    color={finalColor} 
                    emissive={finalEmissive} 
                    emissiveIntensity={finalEmissiveIntensity}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                />
            </mesh>
        </group>
    );
}
