import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

export interface ContactDiskHudReshapeHandle {
    x: number; // HUD-local X (disc-plane position, see ContactDiskRenderer mapping)
    y: number; // HUD-local Y
    radius?: number;
    onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
    onDoubleClick?: (e: ThreeEvent<MouseEvent>) => void;
}

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
    reshapeHandle?: ContactDiskHudReshapeHandle; // Oval contact-face handle (squish + rotate)
    onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
    onPointerUp?: (e: ThreeEvent<PointerEvent> | null) => void;
    onHoverChange?: (hovered: boolean) => void;
    onDragStateChange?: (dragging: boolean) => void;
}

// Reshape-knob palette: base must contrast with BOTH ring states (white
// unhovered / magenta hovered) — a dark rim guarantees it. Hover = cyan.
const RESHAPE_HANDLE_COLOR = '#c11f61';
const RESHAPE_HANDLE_HOVER_COLOR = '#22d3ee';
const RESHAPE_HANDLE_RIM_COLOR = '#1f2937';

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
    faceRatio = 1,
    faceAngleRad = 0,
    reshapeHandle,
    onPointerDown,
    onPointerUp,
    onHoverChange,
    onDragStateChange,
}: ContactDiskHudProps) {
    const [isHovered, setIsHovered] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const [isHandleHovered, setIsHandleHovered] = React.useState(false);
    const activePointerIdRef = React.useRef<number | null>(null);
    const innerRadius = Math.max(0.001, radius + gap);
    const strokeWidth = Math.max(0.001, ringThickness);
    // The HUD mirrors the contact face: same squish ratio along the same axis,
    // so the ring is a live preview of the oval tip. HUD-local squish direction
    // for angle a is (cos a, -sin a) — the renderer's handle mapping — which a
    // -a rotation about Z aligns with local X. The ring is built as an
    // elliptical shape (not a scaled circle) so its stroke width stays constant
    // instead of thinning on the squished side.
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

    const handlePointerEnterInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!isInteractable) return;
        setHovered(true);
        setIsHandleHovered(false); // Pointer is on the ring/fill, not the knob
        document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
        stopPointerEvent(e);
    }, [isDragging, isInteractable, setHovered, stopPointerEvent]);

    const handlePointerMoveInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!isInteractable) return;
        if (!isHovered) {
            setHovered(true);
        }
        setIsHandleHovered(false); // Self-heal any stuck knob-hover state
        document.body.style.cursor = isDragging ? 'grabbing' : 'grab';
        stopPointerEvent(e);
    }, [isDragging, isHovered, isInteractable, setHovered, stopPointerEvent]);

    const handlePointerLeaveInternal = React.useCallback((e: ThreeEvent<PointerEvent>) => {
        setHovered(false);
        if (!isDragging) document.body.style.cursor = '';
        stopPointerEvent(e);
    }, [isDragging, setHovered, stopPointerEvent]);

    return (
        <>
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
            >
                <circleGeometry args={[1, 64]} />
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
                rotation={[0, 0, -faceAngleRad]}
                geometry={ringGeometry}
                onPointerEnter={handlePointerEnterInternal}
                onPointerMove={handlePointerMoveInternal}
                onPointerLeave={handlePointerLeaveInternal}
                onPointerDown={handlePointerDownInternal}
                onPointerUp={handlePointerUpInternal}
                onClick={handleClickInternal}
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

        </group>
        {reshapeHandle && (
            <ContactDiskHudReshapeKnob
                handle={reshapeHandle}
                ringThickness={ringThickness}
                isInteractable={isInteractable}
                isHandleHovered={isHandleHovered}
                setIsHandleHovered={setIsHandleHovered}
                setHovered={setHovered}
                stopPointerEvent={stopPointerEvent}
            />
        )}
        </>
    );
}

interface ContactDiskHudReshapeKnobProps {
    handle: ContactDiskHudReshapeHandle;
    ringThickness: number;
    isInteractable: boolean;
    isHandleHovered: boolean;
    setIsHandleHovered: (hovered: boolean) => void;
    setHovered: (hovered: boolean) => void;
    stopPointerEvent: (e: ThreeEvent<Event> | null) => void;
}

/**
 * Reshape handle ("squish knob"): drag toward the center to turn the contact
 * face into an oval, around the ring to rotate it. Rendered as a two-tone knob
 * (dark rim + bright fill, cyan on hover) so it stays visible against every
 * ring state.
 *
 * Rendered as its OWN top-level group (a sibling of the ring/fill group, same
 * [π/2,0,0] frame) with a far higher renderOrder and no nested groups, so no
 * group-order sorting subtlety can ever paint the ring or fill over it. The
 * spheres also raycast nearer the camera than the flat HUD meshes, so the knob
 * reliably wins pointer hits.
 */
function ContactDiskHudReshapeKnob({
    handle,
    ringThickness,
    isInteractable,
    isHandleHovered,
    setIsHandleHovered,
    setHovered,
    stopPointerEvent,
}: ContactDiskHudReshapeKnobProps) {
    const knobRadius = Math.max(0.035, handle.radius ?? ringThickness * 1.4);
    const knobHitRadius = knobRadius * 2; // Generous invisible grab zone
    const position: [number, number, number] = [handle.x, handle.y, 0];

    return (
        <group rotation={[Math.PI / 2, 0, 0]} renderOrder={1000000}>
            {/* Invisible hit target — the small knob stays easy to grab */}
            <mesh
                position={position}
                renderOrder={1000000}
                onPointerEnter={(e) => {
                    if (!isInteractable) return;
                    setIsHandleHovered(true);
                    setHovered(true); // Counts as HUD interaction (suppresses placement)
                    document.body.style.cursor = 'grab';
                    stopPointerEvent(e);
                }}
                onPointerMove={(e) => {
                    if (!isInteractable) return;
                    if (!isHandleHovered) setIsHandleHovered(true);
                    stopPointerEvent(e);
                }}
                onPointerLeave={(e) => {
                    setIsHandleHovered(false);
                    setHovered(false);
                    document.body.style.cursor = '';
                    stopPointerEvent(e);
                }}
                onPointerDown={(e) => {
                    if (!isInteractable) return;
                    stopPointerEvent(e);
                    if (handle.onPointerDown) handle.onPointerDown(e);
                }}
                onPointerUp={stopPointerEvent}
                onClick={stopPointerEvent}
                onDoubleClick={(e) => {
                    stopPointerEvent(e);
                    if (handle.onDoubleClick) handle.onDoubleClick(e);
                }}
            >
                <sphereGeometry args={[knobHitRadius, 12, 8]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
            </mesh>
            {/* Dark rim: contrast against white AND hovered-magenta ring */}
            <mesh position={position} renderOrder={1000001} raycast={() => null}>
                <sphereGeometry args={[knobRadius, 16, 12]} />
                <meshBasicMaterial
                    color={RESHAPE_HANDLE_RIM_COLOR}
                    transparent
                    opacity={0.95}
                    depthWrite={false}
                    depthTest={false}
                />
            </mesh>
            {/* Bright fill: magenta at rest, cyan on hover */}
            <mesh position={position} renderOrder={1000002} raycast={() => null}>
                <sphereGeometry args={[knobRadius * 0.72, 16, 12]} />
                <meshBasicMaterial
                    color={isHandleHovered ? RESHAPE_HANDLE_HOVER_COLOR : RESHAPE_HANDLE_COLOR}
                    transparent
                    opacity={1}
                    depthWrite={false}
                    depthTest={false}
                />
            </mesh>
        </group>
    );
}
