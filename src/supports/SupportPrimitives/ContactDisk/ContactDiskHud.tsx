import React from 'react';
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
    onPointerDown,
    onPointerUp,
    onHoverChange,
    onDragStateChange,
}: ContactDiskHudProps) {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const activePointerIdRef = React.useRef<number | null>(null);
    const innerRadius = Math.max(0.001, radius + gap);
    const outerRadius = Math.max(innerRadius + 0.001, innerRadius + ringThickness);
    const hitRadius = innerRadius;

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
                onPointerEnter={handlePointerEnterInternal}
                onPointerMove={handlePointerMoveInternal}
                onPointerLeave={handlePointerLeaveInternal}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
                onClick={handleClickInternal}
            >
                <circleGeometry args={[hitRadius, 64]} />
                <meshBasicMaterial
                    color={fillColor}
                    transparent
                    opacity={isHovered ? fillOpacity : 0}
                    depthWrite={false}
                    depthTest={false}
                    side={2}
                />
            </mesh>
            <mesh
                onPointerEnter={handlePointerEnterInternal}
                onPointerMove={handlePointerMoveInternal}
                onPointerLeave={handlePointerLeaveInternal}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
                onClick={handleClickInternal}
            >
                <ringGeometry args={[innerRadius, outerRadius, 64]} />
                <meshBasicMaterial
                    color={isHovered ? hoveredColor : color}
                    transparent
                    opacity={isHovered ? 1 : opacity}
                    depthWrite={false}
                    depthTest={false}
                    side={2}
                />
            </mesh>
        </group>
    );
}
