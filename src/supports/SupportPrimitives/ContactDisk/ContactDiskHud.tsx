import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

interface ContactDiskHudProps {
    radius: number;
    gap?: number;
    ringThickness?: number;
    color?: string;
    opacity?: number;
    hoveredColor?: string;
    isInteractable?: boolean;
    fillColor?: string;
    fillOpacity?: number;
    faceRatio?: number; // Contact-face squish ratio (1 = circle); the ring mirrors the oval
    faceAngleRad?: number; // Oval rotation about the disc normal
    showRing?: boolean; // Hide the stroke ring (fill + interactions stay)
    onRingDoubleClick?: () => void; // Double-click the ring/fill: reset the face to a circle
    onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
    onPointerUp?: (e: ThreeEvent<PointerEvent> | null) => void;
    onHoverChange?: (hovered: boolean) => void;
    onDragStateChange?: (dragging: boolean) => void;
}

type PointerCaptureTarget = EventTarget & {
    setPointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
    releasePointerCapture?: (pointerId: number) => void;
};

/**
 * Pure shape indicator for the selected contact disc: an elliptical ring plus
 * a soft fill that live-mirror the oval contact face. Reshaping happens on
 * the ContactFaceGizmo (rotation ring + squish cube); the HUD's only own
 * interaction is double-click-to-reset.
 */
export function ContactDiskHud({
    radius,
    gap = 0.18,
    ringThickness = 0.04,
    color = '#ffffff',
    opacity = 0.95,
    hoveredColor = '#c11f61',
    isInteractable = true,
    fillColor = '#c11f61',
    fillOpacity = 0.18,
    faceRatio = 1,
    faceAngleRad = 0,
    showRing = true,
    onRingDoubleClick,
    onPointerDown,
    onPointerUp,
    onHoverChange,
    onDragStateChange,
}: ContactDiskHudProps) {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const activePointerIdRef = React.useRef<number | null>(null);
    const innerRadius = Math.max(0.001, radius + gap);
    const strokeWidth = Math.max(0.001, ringThickness);
    // The HUD mirrors the contact face: same squish ratio along the same axis,
    // so the ring is a live preview of the oval tip. HUD-local squish direction
    // for angle a is (cos a, -sin a) — a -a rotation about Z aligns it with
    // local X. The ring is built as an elliptical shape (not a scaled circle)
    // so its stroke width stays constant instead of thinning on the squished
    // side.
    const squishRatio = Math.max(0.01, Math.min(1, faceRatio));
    const innerRadiusX = innerRadius * squishRatio;
    const ringGeometry = React.useMemo(() => {
        const shape = new THREE.Shape();
        shape.absellipse(0, 0, innerRadiusX + strokeWidth, innerRadius + strokeWidth, 0, Math.PI * 2, false, 0);
        const hole = new THREE.Path();
        hole.absellipse(0, 0, innerRadiusX, innerRadius, 0, Math.PI * 2, true, 0);
        shape.holes.push(hole);
        return new THREE.ShapeGeometry(shape, 64);
    }, [innerRadiusX, innerRadius, strokeWidth]);
    React.useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

    const setHovered = React.useCallback((hovered: boolean) => {
        setIsHovered(hovered);
        if (onHoverChange) onHoverChange(hovered);
    }, [onHoverChange]);

    const setDragging = React.useCallback((dragging: boolean) => {
        setIsDragging(dragging);
        if (onDragStateChange) onDragStateChange(dragging);
    }, [onDragStateChange]);

    const stopPointerEvent = React.useCallback((e: ThreeEvent<Event> | null) => {
        if (e?.stopPropagation) e.stopPropagation();
    }, []);

    React.useEffect(() => {
        if (!isDragging) return;

        const handlePointerUp = () => {
            setDragging(false);
            activePointerIdRef.current = null;
            document.body.style.cursor = isHovered ? 'grab' : '';
            if (onPointerUp) onPointerUp(null);
        };

        window.addEventListener('pointerup', handlePointerUp, true);
        window.addEventListener('pointercancel', handlePointerUp, true);
        return () => {
            window.removeEventListener('pointerup', handlePointerUp, true);
            window.removeEventListener('pointercancel', handlePointerUp, true);
        };
    }, [isDragging, isHovered, onPointerUp, setDragging]);

    const handlePointerDownInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!isInteractable) return;
        if (typeof e?.pointerId === 'number') {
            activePointerIdRef.current = e.pointerId;
            try {
                const target = (e.currentTarget as PointerCaptureTarget | null);
                target?.setPointerCapture?.(e.pointerId);
            } catch {
            }
        }
        setDragging(true);
        document.body.style.cursor = 'grabbing';
        stopPointerEvent(e);
        if (onPointerDown) onPointerDown(e);
    }, [isInteractable, onPointerDown, setDragging, stopPointerEvent]);

    const handlePointerUpInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        const pointerId = typeof e?.pointerId === 'number' ? e.pointerId : activePointerIdRef.current;
        if (pointerId !== null) {
            try {
                const target = (e.currentTarget as PointerCaptureTarget | null);
                if (target?.hasPointerCapture?.(pointerId)) {
                    target.releasePointerCapture?.(pointerId);
                }
            } catch {
            }
        }
        activePointerIdRef.current = null;
        setDragging(false);
        document.body.style.cursor = isHovered ? 'grab' : '';
        stopPointerEvent(e);
        if (onPointerUp) onPointerUp(e);
    }, [isHovered, onPointerUp, setDragging, stopPointerEvent]);

    const handleClickInternal = React.useCallback((e: ThreeEvent<MouseEvent>) => {
        stopPointerEvent(e);
    }, [stopPointerEvent]);

    const handleDoubleClickInternal = React.useCallback((e: ThreeEvent<MouseEvent>) => {
        stopPointerEvent(e);
        if (onRingDoubleClick) onRingDoubleClick();
    }, [onRingDoubleClick, stopPointerEvent]);

    const handlePointerEnterInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!isInteractable) return;
        setHovered(true);
        document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
        stopPointerEvent(e);
    }, [isDragging, isInteractable, setHovered, stopPointerEvent]);

    const handlePointerMoveInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!isInteractable) return;
        if (!isHovered) {
            setHovered(true);
        }
        document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
        stopPointerEvent(e);
    }, [isDragging, isHovered, isInteractable, setHovered, stopPointerEvent]);

    const handlePointerLeaveInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        setHovered(false);
        if (!isDragging) document.body.style.cursor = '';
        stopPointerEvent(e);
    }, [isDragging, setHovered, stopPointerEvent]);

    return (
        <group rotation={[Math.PI / 2, 0, 0]} renderOrder={100000}>
            <mesh
                rotation={[0, 0, -faceAngleRad]}
                scale={[innerRadiusX, innerRadius, 1]}
                onPointerEnter={handlePointerEnterInternal}
                onPointerMove={handlePointerMoveInternal}
                onPointerLeave={handlePointerLeaveInternal}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
                onClick={handleClickInternal}
                onDoubleClick={handleDoubleClickInternal}
            >
                <circleGeometry args={[1, 64]} />
                <meshBasicMaterial
                    color={fillColor}
                    transparent
                    // Always-on soft tint of the contact footprint while the
                    // disc is selected; brightens on hover.
                    opacity={isHovered ? Math.min(1, fillOpacity * 1.8) : fillOpacity}
                    depthWrite={false}
                    depthTest={false}
                    side={2}
                />
            </mesh>
            {showRing && (
                <mesh
                    rotation={[0, 0, -faceAngleRad]}
                    geometry={ringGeometry}
                    onPointerEnter={handlePointerEnterInternal}
                    onPointerMove={handlePointerMoveInternal}
                    onPointerLeave={handlePointerLeaveInternal}
                    onPointerDown={handlePointerDownInternal}
                    onPointerUp={handlePointerUpInternal}
                    onClick={handleClickInternal}
                    onDoubleClick={handleDoubleClickInternal}
                >
                    <meshBasicMaterial
                        color={isHovered ? hoveredColor : color}
                        transparent
                        opacity={isHovered ? 1 : opacity}
                        depthWrite={false}
                        depthTest={false}
                        side={2}
                    />
                </mesh>
            )}
        </group>
    );
}
