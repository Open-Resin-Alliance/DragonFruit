import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Vec3 } from '../../types';
import { ContactDiskProfile } from '../ContactCone/types';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from './contactDiskUtils';

interface ContactDiskRendererProps {
    pos: Vec3;
    normal: Vec3;           // Surface Normal
    coneAxis: Vec3;         // Cone Axis (Direction of support)
    profile: ContactDiskProfile;
    contactDiameterMm: number;
    overrideThickness?: number; // Explicit thickness from collision logic
    penetrationMm?: number;
    color?: string;
    transparent?: boolean;
    opacity?: number;
    raycast?: any;
}

export function ContactDiskRenderer({
    pos,
    normal,
    coneAxis,
    profile,
    contactDiameterMm,
    overrideThickness,
    penetrationMm = 0,
    color = '#ff8800',
    transparent = false,
    opacity = 1,
    raycast
}: ContactDiskRendererProps) {
    
    // Calculate geometry based on angle between Surface Normal and Cone Axis
    // Use overrideThickness if provided (from collision logic)
    const thickness = useMemo(() => {
        if (overrideThickness !== undefined) return overrideThickness;
        return calculateDiskThickness(normal, coneAxis, profile);
    }, [normal, coneAxis, profile, overrideThickness]);
    
    const center = useMemo(() => getDiskCenter(pos, normal, thickness), [pos, normal, thickness]);
    const rotation = useMemo(() => getDiskRotation(normal), [normal]);

    const radius = contactDiameterMm / 2;

    // We want a Flat Base (Model Side) and a Round Tip (Cone Side).
    // We also want Center-to-Center alignment:
    // The Center of the Tip Sphere should be at 'thickness' distance from surface.
    // The Cylinder Shaft should go from Surface (0) to Tip Center (thickness).
    
    // Our Group is centered at 'thickness / 2' (by getDiskCenter).
    // Local Y=0 is at Global 'thickness / 2'.
    // Surface is at Local Y = -thickness / 2.
    // Tip Center is at Local Y = +thickness / 2.

    const effectivePenetration = Math.max(0, penetrationMm);

    return (
        <group position={[center.x, center.y, center.z]} quaternion={rotation}>
            <mesh position={[0, -effectivePenetration / 2, 0]} raycast={raycast}>
                {/*
                  Extend the disk into the model without moving the cone-side connection.
                  We keep the cone-side "top" aligned by:
                  - increasing height by penetration
                  - shifting the cylinder down by penetration/2
                */}
                <cylinderGeometry args={[radius, radius, thickness + effectivePenetration, 32]} />
                <meshStandardMaterial
                    color={color}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    polygonOffset
                    polygonOffsetFactor={1}
                    polygonOffsetUnits={1}
                />
            </mesh>

            {/* Round Tip: stays exactly where it was (cone side alignment) */}
            <mesh position={[0, thickness / 2, 0]} raycast={raycast}>
                <sphereGeometry args={[radius, 32, 32]} />
                <meshStandardMaterial
                    color={color}
                    transparent={transparent}
                    opacity={opacity}
                    depthWrite={!transparent}
                    polygonOffset
                    polygonOffsetFactor={1}
                    polygonOffsetUnits={1}
                />
            </mesh>
        </group>
    );
}
