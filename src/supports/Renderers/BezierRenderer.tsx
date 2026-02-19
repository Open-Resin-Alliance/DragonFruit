import React, { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../types';
import { toVector3 } from '../Curves/BezierUtils';
import { usePicking } from '@/components/picking';
import { useBracePlacementState } from '../SupportTypes/Brace/bracePlacementState';

interface BezierRendererProps {
    id: string;
    start: Vec3;
    end: Vec3;
    control1: Vec3;
    control2: Vec3;
    diameter: number;
    diameterStart?: number;
    diameterEnd?: number;
    resolution?: number;
    color?: string;
    emissive?: string;
    emissiveIntensity?: number;
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    isSelected?: boolean;
    isParentSelected?: boolean;
    onClick?: (e: any) => void;
}

export function BezierRenderer({
    id,
    start,
    end,
    control1,
    control2,
    diameter,
    diameterStart,
    diameterEnd,
    resolution = 16,
    color = '#ff8800',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    raycast,
    isSelected,
    isParentSelected,
    onClick
}: BezierRendererProps) {
    const curve = useMemo(() => {
        return new THREE.CubicBezierCurve3(
            toVector3(start),
            toVector3(control1),
            toVector3(control2),
            toVector3(end)
        );
    }, [
        start.x, start.y, start.z, 
        end.x, end.y, end.z, 
        control1.x, control1.y, control1.z, 
        control2.x, control2.y, control2.z
    ]);

    const startRadius = (diameterStart ?? diameter) / 2;
    const endRadius = (diameterEnd ?? diameter) / 2;

    const geometry = useMemo(() => {
        const tubularSegments = Math.max(2, resolution);
        const radialSegments = 8;
        const g = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false);

        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const ringSize = radialSegments + 1;
        const ringCount = tubularSegments + 1;

        for (let i = 0; i < ringCount; i++) {
            const u = i / tubularSegments;
            const center = curve.getPointAt(u);
            const r = THREE.MathUtils.lerp(startRadius, endRadius, u);

            for (let j = 0; j < ringSize; j++) {
                const idx = i * ringSize + j;
                const x = pos.getX(idx);
                const y = pos.getY(idx);
                const z = pos.getZ(idx);

                const v = new THREE.Vector3(x, y, z);
                const dir = v.sub(center);
                const len = dir.length();
                if (len > 0) {
                    dir.multiplyScalar(1 / len);
                }
                const nv = center.clone().add(dir.multiplyScalar(r));
                pos.setXYZ(idx, nv.x, nv.y, nv.z);
            }
        }

        pos.needsUpdate = true;
        g.computeVertexNormals();
        g.computeBoundingBox();
        g.computeBoundingSphere();
        return g;
    }, [curve, resolution, startRadius, endRadius]);

    useEffect(() => {
        return () => {
            geometry.dispose();
        };
    }, [geometry]);
    const groupRef = useRef<THREE.Group>(null);

    // GPU Picking Setup
    const pickIdRef = useRef<number | null>(null);
    const { register, unregister, hit } = usePicking();

    const { altActive: braceAltActive } = useBracePlacementState();

    // Register with picking system
    useEffect(() => {
        if (!groupRef.current) return;
        
        // Only register if parent is selected (editable mode)
        if (isParentSelected) {
            pickIdRef.current = register({
                category: 'segment',
                objectId: id,
                object: groupRef.current,
            });
        }
        
        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, id, isParentSelected]);

    // Determine Hover State
    const isPickingHovered = hit.category === 'segment' && hit.objectId === id;
    const isHovered = isPickingHovered && !isSelected && isParentSelected && !braceAltActive;

    const handleClick = (e: any) => {
        const altDown = !!(e?.nativeEvent?.altKey || e?.altKey);
        const ctrlDown = !!(e?.nativeEvent?.ctrlKey || e?.ctrlKey);

        // If Alt is held, this click is intended for placement tools.
        // Stop propagation so it does not fall through to the canvas/model click handlers.
        if (altDown || ctrlDown) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
        }

        window.dispatchEvent(new CustomEvent('shaft-click', {
            detail: {
                segmentId: id,
                point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                intersection: e
            }
        }));

        // Ctrl is reserved for Support Brace placement and should not re-select segments.
        if (ctrlDown) return;

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

    const handlePointerMove = (e: any) => {
        window.dispatchEvent(new CustomEvent('shaft-hover', {
            detail: {
                segmentId: id,
                point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                intersection: e
            }
        }));
    };

    const handlePointerOut = () => {
        window.dispatchEvent(new CustomEvent('shaft-leave', {
            detail: { segmentId: id }
        }));
    };

    const finalColor = isSelected ? '#ff80ff' : color; // Light Magenta when selected
    const finalEmissive = isSelected ? '#440044' : (isHovered ? '#ffffff' : emissive);
    const finalEmissiveIntensity = isSelected ? 0.5 : (isHovered ? 0.3 : emissiveIntensity);

    return (
        <group ref={groupRef}>
            <mesh raycast={raycast} onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
                <primitive object={geometry} attach="geometry" />
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
