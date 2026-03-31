import React, { useMemo, useEffect, useState, useRef } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../types';
import { toVector3 } from '../Curves/BezierUtils';
import { useBracePlacementState } from '../SupportTypes/Brace/bracePlacementState';
import { emitImmediateModelHover, getFrontBlockingModelId } from '../interaction/pointerOcclusion';

const NOOP_RAYCAST: THREE.Object3D['raycast'] = () => {};

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
    selectedColor?: string;
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
    isSelected?: boolean;
    isParentSelected?: boolean;
    isInteractable?: boolean;
    suppressPlacementInteraction?: boolean;
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
    color = '#c8752a',
    emissive = '#000000',
    emissiveIntensity = 0,
    transparent = false,
    opacity = 1,
    raycast,
    isSelected,
    isParentSelected,
    isInteractable = true,
    suppressPlacementInteraction = false,
    onClick
}: BezierRendererProps) {
    const groupRef = useRef<THREE.Group>(null);
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
    const PICK_RADIUS_MULTIPLIER = 1.9;
    const MIN_PICK_RADIUS_MM = 0.45;
    const selectedVisualScale = isSelected ? 1.03 : 1;
    const visualStartRadius = startRadius * selectedVisualScale;
    const visualEndRadius = endRadius * selectedVisualScale;
    const pickRadius = Math.max(Math.max(visualStartRadius, visualEndRadius) * PICK_RADIUS_MULTIPLIER, MIN_PICK_RADIUS_MM);
    const { altActive: braceAltActive } = useBracePlacementState();
    const enableSegmentInteraction = !!isInteractable && (isParentSelected || (!suppressPlacementInteraction && braceAltActive)) === true;
    const [frontBlockingModelId, setFrontBlockingModelId] = useState<string | null>(null);
    const [pointerHoverActive, setPointerHoverActive] = useState(false);
    const pickRef = useRef<THREE.Mesh>(null);

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
            const r = THREE.MathUtils.lerp(visualStartRadius, visualEndRadius, u);

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
    }, [curve, resolution, visualStartRadius, visualEndRadius]);

    const pickGeometry = useMemo(() => {
        if (!enableSegmentInteraction) return null;
        const tubularSegments = Math.max(2, resolution);
        const radialSegments = 8;
        const g = new THREE.TubeGeometry(curve, tubularSegments, pickRadius, radialSegments, false);
        g.computeBoundingBox();
        g.computeBoundingSphere();
        return g;
    }, [curve, enableSegmentInteraction, pickRadius, resolution]);

    useEffect(() => {
        return () => {
            geometry.dispose();
        };
    }, [geometry]);

    useEffect(() => {
        return () => {
            pickGeometry?.dispose();
        };
    }, [pickGeometry]);

    // Determine Hover State
    const isTopPickedSegment = enableSegmentInteraction && pointerHoverActive;
    const isHovered = pointerHoverActive && !isSelected && isParentSelected;

    const handleClick = (e: any) => {
        const frontModelId = getFrontBlockingModelId(e, groupRef.current);
        if (frontModelId) {
            setFrontBlockingModelId((prev) => (prev === frontModelId ? prev : frontModelId));
            emitImmediateModelHover(frontModelId);
            window.dispatchEvent(new CustomEvent('shaft-leave', {
                detail: { segmentId: id }
            }));
            return;
        }

        if (frontBlockingModelId !== null) {
            setFrontBlockingModelId(null);
            emitImmediateModelHover(null);
        }

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

        if ((altDown || ctrlDown || isParentSelected) && !isTopPickedSegment) return;

        if (altDown || ctrlDown || isParentSelected) {
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

        // UX: for curved segments, a direct click should select the segment immediately
        // (so bezier handles appear on first click) instead of requiring a support-first click.
        if (!isParentSelected && !altDown && onClick) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
            onClick(e);
            return;
        }

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

    const handlePointerMove = (e: any) => {
        if (!enableSegmentInteraction) return;

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

        if (!isTopPointerTargetNow) {
            setPointerHoverActive((prev) => (prev ? false : prev));
            return;
        }

        setPointerHoverActive((prev) => (prev ? prev : true));

        window.dispatchEvent(new CustomEvent('shaft-hover', {
            detail: {
                segmentId: id,
                point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                intersection: e
            }
        }));
    };

    const handlePointerOver = (e: any) => {
        if (!enableSegmentInteraction) return;
        e.stopPropagation();
        setPointerHoverActive((prev) => (prev ? prev : true));
    };

    const handlePointerOut = (e: any) => {
        if (!enableSegmentInteraction) return;
        e.stopPropagation();
        setPointerHoverActive((prev) => (prev ? false : prev));
        window.dispatchEvent(new CustomEvent('shaft-leave', {
            detail: { segmentId: id }
        }));
    };

    const handlePointerLeave = () => {
        if (!enableSegmentInteraction) return;

        window.dispatchEvent(new CustomEvent('shaft-leave', {
            detail: { segmentId: id }
        }));
    };

    const finalColor = isSelected ? '#ff80ff' : (isHovered ? '#efd8c2' : color);
    const finalEmissive = isSelected ? '#440044' : (isHovered ? '#efd8c2' : emissive);
    const finalEmissiveIntensity = isSelected ? 0.22 : (isHovered ? 0.18 : emissiveIntensity);

    return (
        <group ref={groupRef}>
            {pickGeometry && (
                <mesh
                    ref={pickRef}
                    raycast={raycast}
                    onClick={handleClick}
                    onPointerOver={handlePointerOver}
                    onPointerMove={enableSegmentInteraction ? handlePointerMove : undefined}
                    onPointerOut={handlePointerOut}
                    onPointerLeave={enableSegmentInteraction ? handlePointerLeave : undefined}
                    userData={{ segmentId: id }}
                >
                    <primitive object={pickGeometry} attach="geometry" />
                    <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
            )}
            <mesh
                raycast={enableSegmentInteraction ? NOOP_RAYCAST : raycast}
                onClick={!enableSegmentInteraction ? handleClick : undefined}
                onPointerMove={!enableSegmentInteraction ? handlePointerMove : undefined}
                onPointerLeave={!enableSegmentInteraction ? handlePointerLeave : undefined}
                userData={enableSegmentInteraction ? { excludeFromPickingClone: true } : undefined}
            >
                <primitive object={geometry} attach="geometry" />
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
