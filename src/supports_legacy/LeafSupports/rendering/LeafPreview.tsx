import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { LeafPlacementState } from '../types';
import type { Vec3 } from '../../types';
import { getCurrentSupportSettings } from '../../state';
import { LEAF_PREVIEW_COLOR } from '../constants';

/**
 * Lightweight visual preview for leaf placement.
 * - Shows contact cone from contact point (small end) to socket point (large end)
 * - Colors differently when snapped to parent support
 * - NO shaft, NO joints, NO base - just the contact cone
 */

interface LeafPreviewProps {
  state: LeafPlacementState;
  socketPosition?: Vec3 | null; // dynamic follow position
  color?: string;               // default color
  snappedColor?: string;        // color when snapped
}

export default function LeafPreview({ 
  state, 
  socketPosition, 
  color = LEAF_PREVIEW_COLOR, 
  snappedColor = '#00ffcc' 
}: LeafPreviewProps) {
  const contactPoint = state.contactPoint;
  const contactNormal = state.contactNormal;
  const snapPoint = state.snapPoint;
  const isSnapped = !!state.parentSupportId;
  
  console.log('[LeafPreview] Rendering - parentSupportId:', state.parentSupportId, 'isSnapped:', isSnapped, 'color:', isSnapped ? snappedColor : color);

  if (!contactPoint || !contactNormal) return null;

  const socketPoint = snapPoint || socketPosition;
  if (!socketPoint) return null;

  const settings = getCurrentSupportSettings();

  // Contact cone aligned from contact (small end) to socket (large end)
  const cone = useMemo(() => {
    if (!settings) return null;
    
    const tipContactRadius = settings.tip.contactDiameterMm / 2; // small end (touches model)
    const tipSocketRadius = settings.tip.bodyDiameterMm / 2;     // large end (connects to parent)
    
    // Calculate cone axis from contact to socket
    const contactVec = new THREE.Vector3(contactPoint.x, contactPoint.y, contactPoint.z);
    const socketVec = new THREE.Vector3(socketPoint.x, socketPoint.y, socketPoint.z);
    const coneAxis = new THREE.Vector3().subVectors(socketVec, contactVec);
    const coneLength = coneAxis.length();
    
    if (coneLength < 0.01) return null; // Too short to render
    
    const coneDir = coneAxis.clone().normalize();
    
    // Cone center is halfway between contact and socket
    const center = new THREE.Vector3().addVectors(contactVec, socketVec).multiplyScalar(0.5);
    
    // Flip direction so cone points from contact (small) to socket (large)
    // CylinderGeometry: radiusTop at +Y, radiusBottom at -Y
    // We want small end at contact, large end at socket
    const coneDirFlipped = new THREE.Vector3(-coneDir.x, -coneDir.y, -coneDir.z);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    q.setFromUnitVectors(up, coneDirFlipped);
    
    return { 
      position: [center.x, center.y, center.z] as [number, number, number], 
      quaternion: q, 
      height: coneLength,
      tipContactRadius,
      tipSocketRadius,
    };
  }, [contactPoint, socketPoint, settings]);

  // Socket marker sphere
  const socketMarker = useMemo(() => {
    if (!socketPoint) return null;
    const radius = (settings?.tip.bodyDiameterMm ?? 1.0) / 2;
    return {
      position: [socketPoint.x, socketPoint.y, socketPoint.z] as [number, number, number],
      radius,
    };
  }, [socketPoint, settings]);

  return (
    <group>
      {/* Contact cone - only geometry for leaf support */}
      {cone && (
        <mesh position={cone.position} quaternion={cone.quaternion}>
          {/* CylinderGeometry(radiusTop, radiusBottom, height) - top is small, bottom is large */}
          <cylinderGeometry args={[cone.tipContactRadius, cone.tipSocketRadius, cone.height, 16]} />
          <meshStandardMaterial 
            color={isSnapped ? snappedColor : color} 
            transparent 
            opacity={0.6} 
            depthWrite={false} 
          />
        </mesh>
      )}

      {/* Socket marker - shows where it will attach to parent */}
      {socketMarker && (
        <mesh position={socketMarker.position}>
          <sphereGeometry args={[socketMarker.radius, 16, 16]} />
          <meshStandardMaterial 
            color={isSnapped ? snappedColor : color} 
            transparent 
            opacity={isSnapped ? 0.95 : 0.7} 
          />
        </mesh>
      )}

      {/* Contact point marker - small sphere at model contact */}
      <mesh position={[contactPoint.x, contactPoint.y, contactPoint.z]}>
        <sphereGeometry args={[(settings?.tip.contactDiameterMm ?? 0.3) / 2, 16, 16]} />
        <meshStandardMaterial 
          color={isSnapped ? snappedColor : color} 
          transparent 
          opacity={0.85} 
        />
      </mesh>
    </group>
  );
}
