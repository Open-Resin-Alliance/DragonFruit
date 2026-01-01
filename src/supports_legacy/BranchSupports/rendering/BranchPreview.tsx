import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { BranchPlacementState } from '../types';
import type { Vec3, SupportInstance } from '../../types';
import { getCurrentSupportSettings } from '../../state';

// Lightweight visual preview for branch placement.
// - Shows contact marker when tip is placed
// - Shows a line from contact → base (either dynamic basePosition or snapped position)
// - Colors base marker differently when snapped

interface BranchPreviewProps {
  state: BranchPlacementState;
  basePosition?: Vec3 | null; // dynamic follow position prior to snap
  color?: string;             // default line/marker color
  snappedColor?: string;      // color when snapped is active
  supports?: SupportInstance[]; // needed to get parent support diameter
}

export default function BranchPreview({ state, basePosition, color = '#7dd3fc', snappedColor = '#22d3ee', supports = [] }: BranchPreviewProps) {
  const contact = state.contact;
  const snapped = state.snap;

  if (!contact) return null;

  const base = (snapped?.position ?? basePosition) || null;
  const isSnapped = !!snapped;
  const settings = getCurrentSupportSettings();
  
  // Calculate branch joint diameter based on parent support shaft diameter
  const branchJointDiameter = useMemo(() => {
    if (!snapped || !supports.length) {
      // Fallback to default if not snapped
      return (settings?.jointDefaults.ballDiameterMm ?? 1.5);
    }
    
    // Find parent support
    const parentSupport = supports.find(s => s.id === snapped.trunkId);
    if (!parentSupport) {
      return (settings?.jointDefaults.ballDiameterMm ?? 1.5);
    }
    
    // Branch joint diameter = parent shaft diameter + 0.1mm
    const parentShaftDiameter = parentSupport.settings?.mid?.diameterMm ?? 1.0;
    return parentShaftDiameter + 0.1;
  }, [snapped, supports, settings]);

  // Contact cone aligned by contactNormal (small end at model surface)
  const cone = useMemo(() => {
    if (!settings) return null as any;
    const tipLen = Math.max(0.5, settings.tip.lengthMm);
    const tipContactRadius = settings.tip.contactDiameterMm / 2; // small end (touches model)
    const tipSocketRadius = settings.tip.bodyDiameterMm / 2; // large end (connects to shaft)
    const a = new THREE.Vector3(contact.x, contact.y, contact.z);
    const n = state.contactNormal ? new THREE.Vector3(state.contactNormal.x, state.contactNormal.y, state.contactNormal.z).normalize() : new THREE.Vector3(0, 1, 0);
    // Socket face (wide end) is at tipLen distance from contact along normal
    const socketPos = a.clone().add(n.clone().multiplyScalar(tipLen));
    // Cone center is halfway between contact and socket
    const center = a.clone().add(n.clone().multiplyScalar(tipLen * 0.5));
    // Flip direction so cone points from socket (wide) to contact (small)
    const nFlipped = new THREE.Vector3(-n.x, -n.y, -n.z);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    q.setFromUnitVectors(up, nFlipped);
    return { position: [center.x, center.y, center.z] as [number, number, number], quaternion: q, height: tipLen, socket: socketPos, tipContactRadius, tipSocketRadius };
  }, [contact, state.contactNormal, settings]);

  // Compute shaft between cone socket face and base
  const shaft = useMemo(() => {
    if (!base || !cone) return null as null | { position: [number, number, number]; quaternion: THREE.Quaternion; height: number };
    const a = cone.socket; // start from socket face
    const b = new THREE.Vector3(base.x, base.y, base.z);
    const dir = new THREE.Vector3().subVectors(b, a);
    const height = Math.max(0.01, dir.length());
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    q.setFromUnitVectors(up, dir.clone().normalize());
    return { position: [mid.x, mid.y, mid.z] as [number, number, number], quaternion: q, height };
  }, [cone, base]);

  return (
    <group>
      {/* Contact cone (tip piece), small end on model, aligned to surface normal */}
      {cone && (
        <mesh position={cone.position} quaternion={cone.quaternion}>
          {/* CylinderGeometry(radiusTop, radiusBottom, height) - top is +Y (small), bottom is -Y (large) */}
          <cylinderGeometry args={[cone.tipContactRadius, cone.tipSocketRadius, cone.height, 16]} />
          <meshStandardMaterial color={isSnapped ? snappedColor : color} transparent opacity={0.5} depthWrite={false} />
        </mesh>
      )}

      {/* Contact joint sphere at the cone socket */}
      {cone && (
        <mesh position={[cone.socket.x, cone.socket.y, cone.socket.z]}>
          <sphereGeometry args={[Math.max(0.2, (settings?.jointDefaults.ballDiameterMm ?? 1.5) * 0.3), 16, 16]} />
          <meshStandardMaterial color={isSnapped ? snappedColor : color} transparent opacity={0.85} />
        </mesh>
      )}

      {/* Base joint marker (snapped target) - sized to match parent shaft + 0.1mm */}
      {base && (
        <mesh position={[base.x, base.y, base.z]}>
          <sphereGeometry args={[branchJointDiameter / 2, 16, 16]} />
          <meshStandardMaterial color={isSnapped ? snappedColor : color} transparent opacity={0.95} />
        </mesh>
      )}

      {/* Shaft cylinder between cone socket and base */}
      {shaft && (
        <mesh position={shaft.position} quaternion={shaft.quaternion}>
          <cylinderGeometry args={[Math.max(0.2, (settings?.mid.diameterMm ?? 1.0) * 0.5), Math.max(0.2, (settings?.mid.diameterMm ?? 1.0) * 0.5), Math.max(0.01, shaft.height), 16]} />
          <meshStandardMaterial color={isSnapped ? snappedColor : color} transparent opacity={0.6} />
        </mesh>
      )}

      {/* Mid joint sphere at halfway point for clarity */}
      {shaft && (
        <mesh position={shaft.position}>
          <sphereGeometry args={[Math.max(0.2, (settings?.jointDefaults.ballDiameterMm ?? 1.5) * 0.35), 16, 16]} />
          <meshStandardMaterial color={isSnapped ? snappedColor : color} transparent opacity={0.7} />
        </mesh>
      )}
    </group>
  );
}
