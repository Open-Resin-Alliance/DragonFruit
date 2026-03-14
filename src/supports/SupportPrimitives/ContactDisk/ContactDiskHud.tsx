import React from 'react';

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
    onPointerDown?: (e: any) => void;
    onPointerUp?: (e: any) => void;
    onHoverChange?: (hovered: boolean) => void;
    onDragStateChange?: (dragging: boolean) => void;
}

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

    const handlePointerDownInternal = React.useCallback((e: any) => {
        console.log('[DiskHud] pointerDown | isInteractable:', isInteractable, '| hasOnPointerDown:', !!onPointerDown);
        if (!isInteractable) return;
        if (typeof e?.pointerId === 'number') {
            activePointerIdRef.current = e.pointerId;
            try {
                e.currentTarget?.setPointerCapture?.(e.pointerId);
            } catch {
            }
        }
        setDragging(true);
        document.body.style.cursor = 'grabbing';
        if (e?.stopPropagation) e.stopPropagation();
        if (e?.nativeEvent?.stopPropagation) {
            e.nativeEvent.stopPropagation();
            e.nativeEvent.stopImmediatePropagation?.();
        }
        if (onPointerDown) onPointerDown(e);
    }, [isInteractable, onPointerDown, setDragging]);

    const handlePointerUpInternal = React.useCallback((e: any) => {
        const pointerId = typeof e?.pointerId === 'number' ? e.pointerId : activePointerIdRef.current;
        if (pointerId !== null) {
            try {
                if (e?.currentTarget?.hasPointerCapture?.(pointerId)) {
                    e.currentTarget.releasePointerCapture(pointerId);
                }
            } catch {
            }
        }
        activePointerIdRef.current = null;
        setDragging(false);
        document.body.style.cursor = isHovered ? 'grab' : '';
        if (onPointerUp) onPointerUp(e);
    }, [isHovered, onPointerUp, setDragging]);

    return (
        <group rotation={[Math.PI / 2, 0, 0]} renderOrder={999}>
            <mesh
                onPointerEnter={() => {
                    if (!isInteractable) return;
                    setHovered(true);
                    document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
                }}
                onPointerLeave={() => {
                    setHovered(false);
                    if (!isDragging) document.body.style.cursor = '';
                }}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
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
                onPointerEnter={() => {
                    if (!isInteractable) return;
                    setHovered(true);
                    document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
                }}
                onPointerLeave={() => {
                    setHovered(false);
                    if (!isDragging) document.body.style.cursor = '';
                }}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
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
