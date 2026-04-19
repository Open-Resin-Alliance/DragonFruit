import { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, ThreeEvent } from '@react-three/fiber';

interface UseBezierHandleDragProps {
    jointPosition: THREE.Vector3;
    handlePosition: THREE.Vector3;
    onDragStart?: () => void;
    onDrag: (newPosition: THREE.Vector3) => void;
    onDragEnd?: () => void;
    enabled?: boolean;
}

/**
 * Handles the mouse interaction for dragging a Bezier handle in 3D space.
 * Projects mouse movement onto a plane perpendicular to the camera, passing through the joint.
 */
export function useBezierHandleDrag({
    jointPosition: _jointPosition,
    handlePosition,
    onDragStart,
    onDrag,
    onDragEnd,
    enabled = true
}: UseBezierHandleDragProps) {
    const { camera, gl, invalidate } = useThree();
    const [isDragging, setIsDragging] = useState(false);
    
    // Refs for drag state
    const dragPlane = useRef<THREE.Plane | null>(null);
    const dragOffset = useRef<THREE.Vector3>(new THREE.Vector3());
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerNdcRef = useRef(new THREE.Vector2());
    const rafId = useRef<number | null>(null);
    const isDraggingRef = useRef(false);

    // Refs for callbacks to avoid effect re-subscriptions
    const onDragRef = useRef(onDrag);
    const onDragStartRef = useRef(onDragStart);
    const onDragEndRef = useRef(onDragEnd);

    useEffect(() => {
        onDragRef.current = onDrag;
        onDragStartRef.current = onDragStart;
        onDragEndRef.current = onDragEnd;
    }, [onDrag, onDragStart, onDragEnd]);

    // Calculate the intersection point of the mouse ray with the drag plane
    const getRayPlaneIntersection = useCallback((clientX: number, clientY: number): THREE.Vector3 | null => {
        if (!dragPlane.current) return null;

        const rect = gl.domElement.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((clientY - rect.top) / rect.height) * 2 + 1;

        pointerNdcRef.current.set(x, y);
        raycasterRef.current.setFromCamera(pointerNdcRef.current, camera);

        const target = new THREE.Vector3();
        return raycasterRef.current.ray.intersectPlane(dragPlane.current, target);
    }, [camera, gl]);

    const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!enabled) return;
        if (e.button !== 0) return; // Only allow Left Click
        
        // Prevent bubbling and conflict with OrbitControls
        e.stopPropagation();
        (e as any).stopped = true; 

        // Create a plane passing through the handle, facing the camera.
        // Using handle depth keeps drag movement aligned to pointer motion.
        const planeNormal = new THREE.Vector3();
        camera.getWorldDirection(planeNormal);
        
        dragPlane.current = new THREE.Plane();
        dragPlane.current.setFromNormalAndCoplanarPoint(planeNormal, handlePosition);

        const startPoint = getRayPlaneIntersection(e.clientX, e.clientY);
        if (startPoint) {
            dragOffset.current.copy(handlePosition).sub(startPoint);
        } else {
            dragOffset.current.set(0, 0, 0);
        }

        isDraggingRef.current = true;
        setIsDragging(true);
        
        if (onDragStartRef.current) onDragStartRef.current();
    }, [enabled, camera, handlePosition, getRayPlaneIntersection]);

    // Global pointer move handler
    useEffect(() => {
        const handleGlobalPointerMove = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;

            // Throttle with RAF
            if (rafId.current) return;

            rafId.current = requestAnimationFrame(() => {
                const point = getRayPlaneIntersection(e.clientX, e.clientY);
                if (point && onDragRef.current) {
                    onDragRef.current(point.clone().add(dragOffset.current));
                    // onDrag mutates three.js refs via parent — needed for demand mode.
                    invalidate();
                }
                rafId.current = null;
            });
        };

        const handleGlobalPointerUp = () => {
            if (!isDraggingRef.current) return;
            
            isDraggingRef.current = false;
            setIsDragging(false);
            dragPlane.current = null;
            
            if (rafId.current) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }

            if (onDragEndRef.current) onDragEndRef.current();
        };

        if (isDragging) {
            window.addEventListener('pointermove', handleGlobalPointerMove);
            window.addEventListener('pointerup', handleGlobalPointerUp);
        }

        return () => {
            window.removeEventListener('pointermove', handleGlobalPointerMove);
            window.removeEventListener('pointerup', handleGlobalPointerUp);
            if (rafId.current) cancelAnimationFrame(rafId.current);
        };
    }, [isDragging, getRayPlaneIntersection]); // Dependencies reduced to stable refs

    return {
        isDragging,
        handlePointerDown
    };
}
