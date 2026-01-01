import { useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useThree, ThreeEvent } from '@react-three/fiber';

interface UseBezierHandleDragProps {
    jointPosition: THREE.Vector3;
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
    jointPosition,
    onDragStart,
    onDrag,
    onDragEnd,
    enabled = true
}: UseBezierHandleDragProps) {
    const { camera, gl } = useThree();
    const [isDragging, setIsDragging] = useState(false);
    
    // Refs for drag state
    const dragPlane = useRef<THREE.Plane | null>(null);
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

        const ray = new THREE.Ray();
        ray.origin.setFromMatrixPosition(camera.matrixWorld);
        ray.direction.set(x, y, 0.5).unproject(camera).sub(ray.origin).normalize();

        const target = new THREE.Vector3();
        return ray.intersectPlane(dragPlane.current, target);
    }, [camera, gl]);

    const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        if (!enabled) return;
        if (e.button !== 0) return; // Only allow Left Click
        
        // Prevent bubbling and conflict with OrbitControls
        e.stopPropagation();
        (e as any).stopped = true; 

        // Create a plane passing through the joint, facing the camera
        const planeNormal = new THREE.Vector3();
        camera.getWorldDirection(planeNormal);
        
        dragPlane.current = new THREE.Plane();
        dragPlane.current.setFromNormalAndCoplanarPoint(planeNormal, jointPosition);

        isDraggingRef.current = true;
        setIsDragging(true);
        
        if (onDragStartRef.current) onDragStartRef.current();
    }, [enabled, camera, jointPosition]);

    // Global pointer move handler
    useEffect(() => {
        const handleGlobalPointerMove = (e: PointerEvent) => {
            if (!isDraggingRef.current) return;

            // Throttle with RAF
            if (rafId.current) return;

            rafId.current = requestAnimationFrame(() => {
                const point = getRayPlaneIntersection(e.clientX, e.clientY);
                if (point && onDragRef.current) {
                    onDragRef.current(point);
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
