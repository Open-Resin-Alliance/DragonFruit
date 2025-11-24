"use client";

import React from 'react';
import * as THREE from 'three';
import { SupportJoint } from '../Joints/types';

interface BallJointProps {
  joint: SupportJoint;
  supportId: string;
  isSelected?: boolean;
  isHovered?: boolean;
  color?: string;
  supportColor?: string; // Color of the parent support
  isSupportSelected?: boolean; // Whether the parent support is selected
  isSupportHovered?: boolean; // Whether the parent support is hovered
  onSelect?: (supportId: string, jointId: string) => void;
  onHoverChange?: (supportId: string, jointId: string | null) => void;
  onSupportHoverChange?: (id: string | null) => void; // Callback to trigger support hover
  onSupportSelect?: (id: string | null) => void; // Callback to select the parent support
  supportClickedRef?: React.RefObject<boolean>; // Ref to prevent canvas deselection
}

/**
 * Renders a single ball joint as a sphere.
 * Used to connect shaft segments in multi-joint supports.
 */
export function BallJoint({
  joint,
  supportId,
  isSelected = false,
  isHovered = false,
  color = '#888888',
  supportColor = '#ff8800',
  isSupportSelected = false,
  isSupportHovered = false,
  onSelect,
  onHoverChange,
  onSupportHoverChange,
  onSupportSelect,
  supportClickedRef,
}: BallJointProps) {
  const radius = joint.ballDiameterMm / 2;
  
  // Color states
  const isBranchJoint = joint.type === 'branch';
  
  // When support is not selected, joints inherit support color
  // When support is selected, joints use their own selection/hover colors
  let jointColor: string;
  let emissive: string;
  let emissiveIntensity: number;
  
  if (isSupportSelected) {
    // Support is selected: joints can be selected/hovered independently
    const baseColor = isBranchJoint ? '#ffff00' : color; // Yellow for branch joints
    jointColor = isSelected ? '#80fffd' : (isHovered ? '#ffffff' : baseColor);
    emissive = isSelected ? '#80fffd' : (isHovered ? '#ffffff' : '#000000');
    emissiveIntensity = (isSelected || isHovered) ? 0.5 : 0;
  } else {
    // Support is not selected: joints inherit support color and hover state
    jointColor = supportColor;
    emissive = isSupportHovered ? '#ffffff' : '#000000';
    emissiveIntensity = isSupportHovered ? 0.3 : 0;
  }

  return (
    <mesh
      position={[joint.position.x, joint.position.y, joint.position.z]}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (isSupportSelected) {
          // Support is selected: allow joint hover
          if (onHoverChange) onHoverChange(supportId, joint.id);
        } else {
          // Support is not selected: trigger support hover instead
          if (onSupportHoverChange) onSupportHoverChange(supportId);
        }
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        if (isSupportSelected) {
          // Support is selected: clear joint hover
          if (onHoverChange) onHoverChange(supportId, null);
        } else {
          // Support is not selected: clear support hover
          if (onSupportHoverChange) onSupportHoverChange(null);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Set flag to prevent canvas deselection
        if (supportClickedRef) supportClickedRef.current = true;
        
        if (isSupportSelected) {
          // Support is selected: allow joint selection
          if (onSelect) onSelect(supportId, joint.id);
        } else {
          // Support is not selected: select the parent support
          if (onSupportSelect) onSupportSelect(supportId);
        }
      }}
    >
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial
        color={jointColor}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        metalness={0.3}
        roughness={0.6}
      />
    </mesh>
  );
}
