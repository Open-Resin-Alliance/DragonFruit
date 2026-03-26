import React, { useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_SIZES } from '@/components/gizmo/constants';
import { BezierHandleProps } from './types';

import { useBezierHandleDrag } from './useBezierHandleDrag';

const HANDLE_SCALE_FACTOR = 0.012;
const MIN_HANDLE_SCALE = 0.55;
const MAX_HANDLE_SCALE = 2.1;
const SPHERE_RADIUS = GIZMO_SIZES.arrowHeadRadius * 1.25;

export function BezierHandle({
    position,
    jointPosition,
    color = '#ffffff',
    isActive: propActive = false,
    onDrag,
    onDragStart,
    onDragEnd
}: BezierHandleProps) {
    const { camera } = useThree();
    const [scale, setScale] = useState(1);
    const [isHovered, setIsHovered] = useState(false);
    const sphereRef = useRef<THREE.Mesh>(null);

    // Drag Hook
    const { isDragging, handlePointerDown } = useBezierHandleDrag({
        jointPosition, // Use joint as pivot plane origin
        handlePosition: position,
        onDragStart,
        onDrag: (newPos) => {
            if (onDrag) onDrag(newPos);
        },
        onDragEnd
    });

    // Calculate screen-space scale for the sphere
    useFrame(() => {
        if (sphereRef.current) {
            const distance = camera.position.distanceTo(position);
            const next = THREE.MathUtils.clamp(distance * HANDLE_SCALE_FACTOR, MIN_HANDLE_SCALE, MAX_HANDLE_SCALE);
            setScale((prev) => (Math.abs(prev - next) > 1e-4 ? next : prev));
        }
    });

    // Visuals
    const isActive = propActive || isDragging;
    // Color Priority: Dragging (Yellow) > Hover (Cyan) > Normal (White/Color)
    const displayColor = isActive ? '#ffcc00' : (isHovered ? '#00FFFF' : color);
    
    return (
        <group>
            {/* The Connector Line */}
            <Line
                points={[jointPosition, position]}
                color={displayColor}
                lineWidth={1} // Pixel width
                transparent
                opacity={0.8}
                depthTest={false} // Always draw on top? Maybe.
            />

            {/* The Control Point Sphere */}
            <mesh
                ref={sphereRef}
                position={position}
                scale={[scale, scale, scale]}
                onPointerDown={handlePointerDown} // Attach Drag Handler
                onPointerOver={(e) => {
                    e.stopPropagation();
                    setIsHovered(true);
                    document.body.style.cursor = 'pointer';
                }}
                onPointerOut={(e) => {
                    e.stopPropagation();
                    setIsHovered(false);
                    document.body.style.cursor = 'auto';
                }}
                onPointerMove={(e) => e.stopPropagation()} // Block raycast to model
                onClick={(e) => e.stopPropagation()}
            >
                <sphereGeometry args={[SPHERE_RADIUS, 16, 16]} />
                <meshStandardMaterial
                    color={displayColor}
                    emissive={displayColor}
                    emissiveIntensity={isActive || isHovered ? 0.5 : 0.2}
                    depthTest={false}
                    transparent
                />
            </mesh>
        </group>
    );
}
