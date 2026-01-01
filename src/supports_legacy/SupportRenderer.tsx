"use client";

import React, { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { SupportInstance, Vec3 } from './types';
import { SupportJoint, ShaftSegment as ShaftSegmentType } from './Joints/types';
import { BallJoint } from './components/BallJoint';
import { ShaftSegment } from './components/ShaftSegment';
import { getRaftSettings, subscribeToRaftStore } from '../supports/Rafts/Crenelated/RaftState';

/**
 * Builds shaft segments for rendering, starting from tipEnd (not tip).
 * This ensures the shaft connects to the base of the tip cone, not the tip point.
 */
function buildShaftSegments(
  support: SupportInstance,
  tipEnd: THREE.Vector3,
  joints: SupportJoint[],
  shaftEndPosition: Vec3
): ShaftSegmentType[] {
  const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
  const segments: ShaftSegmentType[] = [];
  const tipEndVec: Vec3 = { x: tipEnd.x, y: tipEnd.y, z: tipEnd.z };

  if (sortedJoints.length === 0) {
    // Single segment: tipEnd to shaftEnd (top of base raft)
    segments.push({
      id: `segment-${support.id}-0`,
      startPosition: tipEndVec,
      endPosition: shaftEndPosition,
      diameterMm: support.settings.mid.diameterMm,
      shape: support.settings.mid.shape,
      startJointId: null,
      endJointId: null,
      order: 0,
    });
  } else {
    // TipEnd to first joint
    segments.push({
      id: `segment-${support.id}-0`,
      startPosition: tipEndVec,
      endPosition: sortedJoints[0].position,
      diameterMm: support.settings.mid.diameterMm,
      shape: support.settings.mid.shape,
      startJointId: null,
      endJointId: sortedJoints[0].id,
      order: 0,
    });

    // Between joints
    for (let i = 0; i < sortedJoints.length - 1; i++) {
      segments.push({
        id: `segment-${support.id}-${i + 1}`,
        startPosition: sortedJoints[i].position,
        endPosition: sortedJoints[i + 1].position,
        diameterMm: support.settings.mid.diameterMm,
        shape: support.settings.mid.shape,
        startJointId: sortedJoints[i].id,
        endJointId: sortedJoints[i + 1].id,
        order: i + 1,
      });
    }

    // Last joint to shaftEnd (top of base raft)
    // UNLESS the last joint is a branch joint (which connects directly to parent, no shaft below it)
    const lastJoint = sortedJoints[sortedJoints.length - 1];
    const isBranchJoint = lastJoint.type === 'branch';

    if (!isBranchJoint) {
      segments.push({
        id: `segment-${support.id}-${sortedJoints.length}`,
        startPosition: sortedJoints[sortedJoints.length - 1].position,
        endPosition: shaftEndPosition,
        diameterMm: support.settings.mid.diameterMm,
        shape: support.settings.mid.shape,
        startJointId: sortedJoints[sortedJoints.length - 1].id,
        endJointId: null,
        order: sortedJoints.length,
      });
    }
  }

  return segments;
}

/**
 * Renders a single support instance as tip cone + shaft segments + joints + base.
 * Supports variable joint count (0 to N joints per support).
 */
function SingleSupport({
  support,
  isSelected,
  isHovered,
  onSelect,
  onHoverChange,
  supportClickedRef,
  selectedJointId,
  hoveredJointId,
  onJointSelect,
  onJointHoverChange,
}: {
  support: SupportInstance;
  isSelected?: boolean;
  isHovered?: boolean;
  onSelect?: (id: string | null) => void;
  onHoverChange?: (id: string | null) => void;
  supportClickedRef?: React.RefObject<boolean>;
  selectedJointId?: string | null;
  hoveredJointId?: string | null;
  onJointSelect?: (supportId: string, jointId: string) => void;
  onJointHoverChange?: (supportId: string, jointId: string | null) => void;
}) {
  const raft = useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const { tip, base, tipNormal, settings } = support;

  // Check if this is a leaf support (type 2 or has 'leaf' tag)
  const isLeaf = support.type === 2 || support.tags?.includes('leaf');

  // Debug baseFlare rendering
  console.log('[SupportRenderer] Support:', support.id, 'baseFlare:', settings.baseFlare, 'parentBaseId:', support.parentBaseId, 'raft.bottomMode:', (raft as any).bottomMode);

  // The support should extend from the tip PERPENDICULAR to the surface (along -tipNormal)
  // Then drop down to the base

  // Tip geometry parameters
  const tipPointRadius = settings.tip.contactDiameterMm / 2; // Small end (touches model)
  const tipBaseRadius = settings.tip.bodyDiameterMm / 2; // Large end (connects to shaft)
  const tipLength = settings.tip.lengthMm;

  // Shaft parameters
  const shaftRadius = settings.mid.diameterMm / 2;

  // Base parameters
  const baseRadius = settings.base.diameterMm / 2;
  const baseHeight = settings.base.heightMm;

  // Tip direction: perpendicular to surface, pointing AWAY from the model
  // The normal points OUT from the surface, so we use it directly
  const tipDir = new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z).normalize();

  // Tip end point: extend from tip along tipDir for tipLength
  // The POINT of the cone is at 'tip', the BASE of the cone is at 'tipEnd'
  const tipEnd = new THREE.Vector3(
    tip.x + tipDir.x * tipLength,
    tip.y + tipDir.y * tipLength,
    tip.z + tipDir.z * tipLength
  );

  // Get joints
  const joints = support.joints || [];


  // Calculate where the shaft should end (top of the base raft)
  // IMPORTANT: Keep base anchored at its original XY; do not follow tipEnd XY
  const shaftEndPosition = {
    x: base.x,
    y: base.y,
    z: base.z + baseHeight, // Top of the base raft
  };

  // Build shaft segments manually to ensure they start from tipEnd (not tip)
  // The shaft goes from tipEnd down to the top of the base raft
  const segments = buildShaftSegments(support, tipEnd, joints, shaftEndPosition);

  // Base disk: anchored at original base XY (does NOT follow tipEnd)
  const baseCenter = new THREE.Vector3(
    base.x,
    base.y,
    base.z + baseHeight / 2
  );

  // Compute rotations
  const up = new THREE.Vector3(0, 1, 0);

  // Tip rotation: CylinderGeometry has top at +Y, bottom at -Y
  // We want small end (tipPointRadius) at 'tip' and large end (tipBaseRadius) at 'tipEnd'
  // So we need to flip: align +Y with -tipDir (so +Y/top is at tip, -Y/bottom is at tipEnd)
  const tipDirFlipped = new THREE.Vector3(-tipDir.x, -tipDir.y, -tipDir.z);
  const tipQuaternion = new THREE.Quaternion().setFromUnitVectors(up, tipDirFlipped);
  const tipMidpoint = new THREE.Vector3(
    (tip.x + tipEnd.x) / 2,
    (tip.y + tipEnd.y) / 2,
    (tip.z + tipEnd.z) / 2
  );

  // (Shaft rotation now handled by ShaftSegment component)

  // Base rotation: CylinderGeometry is vertical (along Y), we need it horizontal (along Z)
  // Rotate 90 degrees around X to make it flat on XY plane
  const baseQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  // console.log('[SupportRenderer] Tip point radius:', tipPointRadius, 'Tip base radius:', tipBaseRadius, 'Tip length:', tipLength);
  // console.log('[SupportRenderer] Shaft radius:', shaftRadius, 'Shaft length:', shaftLength, 'Base height:', baseHeight);

  // Determine color based on selection state
  const supportColor = isSelected ? '#80fffd' : '#ff8800'; // Cyan if selected, orange otherwise
  const emissive = isHovered ? '#ffffff' : '#000000'; // White emissive on hover
  const emissiveIntensity = isHovered ? 0.3 : 0;

  // LEAF SUPPORT: Render ONLY the tip cone and the leaf joint
  if (isLeaf) {
    // For leaf, tip is contact point (small end) and base is socket point (large end)
    const leafLength = Math.sqrt(
      Math.pow(base.x - tip.x, 2) +
      Math.pow(base.y - tip.y, 2) +
      Math.pow(base.z - tip.z, 2)
    );

    // Direction from tip to base
    const leafDir = new THREE.Vector3(
      base.x - tip.x,
      base.y - tip.y,
      base.z - tip.z
    ).normalize();

    // FLIP the direction so cylinder aligns correctly
    // CylinderGeometry has +Y at top (large end) and -Y at bottom (small end)
    // We want: -Y at tip (small), +Y at base (large)
    // So we flip the direction
    const leafDirFlipped = new THREE.Vector3(-leafDir.x, -leafDir.y, -leafDir.z);

    const leafMidpoint = new THREE.Vector3(
      (tip.x + base.x) / 2,
      (tip.y + base.y) / 2,
      (tip.z + base.z) / 2
    );

    const up = new THREE.Vector3(0, 1, 0);
    const leafQuaternion = new THREE.Quaternion().setFromUnitVectors(up, leafDirFlipped);

    return (
      <group
        onPointerOver={(e) => {
          e.stopPropagation();
          if (onHoverChange) onHoverChange(support.id);
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          if (onHoverChange) onHoverChange(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (supportClickedRef) supportClickedRef.current = true;
          if (onSelect) onSelect(support.id);
        }}
      >
        {/* Leaf cone: small end at tip (contact), large end at base (socket) */}
        <group position={[leafMidpoint.x, leafMidpoint.y, leafMidpoint.z]} quaternion={leafQuaternion}>
          <mesh>
            {/* CylinderGeometry(radiusTop, radiusBottom, height) - top is +Y, bottom is -Y */}
            {/* After flipping direction: +Y points toward tip, -Y points toward base */}
            {/* So: top (+Y, at tip) = small, bottom (-Y, at base) = large */}
            <cylinderGeometry args={[tipPointRadius, tipBaseRadius, leafLength, 16]} />
            <meshStandardMaterial
              color={supportColor}
              emissive={emissive}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
        </group>

        {/* Render leaf joint at socket (base) */}
        {support.joints && support.joints.length > 0 && support.joints.map((joint) => (
          <BallJoint
            key={joint.id}
            joint={joint}
            supportId={support.id}
            isSelected={selectedJointId === joint.id}
            isHovered={hoveredJointId === joint.id}
            onSelect={onJointSelect}
            onHoverChange={onJointHoverChange}
            onSupportSelect={onSelect}
            supportClickedRef={supportClickedRef}
            isSupportSelected={isSelected}
          />
        ))}
      </group>
    );
  }

  // REGULAR SUPPORT: Render full structure with shaft, joints, base
  return (
    <group
      onPointerOver={(e) => {
        e.stopPropagation();
        if (onHoverChange) onHoverChange(support.id);
      }}
      onPointerMove={(e) => {
        // During leaf/branch placement, we need the exact 3D point for snapping
        // This ensures we get continuous updates as mouse moves over the support
        e.stopPropagation();
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        if (onHoverChange) onHoverChange(null);
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Set flag to prevent canvas deselection
        if (supportClickedRef) supportClickedRef.current = true;
        if (onSelect) onSelect(support.id);
      }}
    >
      {/* Tip frustum - tapered cylinder from point diameter to shaft diameter */}
      <group position={[tipMidpoint.x, tipMidpoint.y, tipMidpoint.z]} quaternion={tipQuaternion}>
        <mesh>
          {/* CylinderGeometry(radiusTop, radiusBottom, height) - top is +Y, bottom is -Y */}
          {/* Since we flipped, +Y is at tip (small), -Y is at tipEnd (large) */}
          <cylinderGeometry args={[tipPointRadius, tipBaseRadius, tipLength, 16]} />
          <meshStandardMaterial
            color={supportColor}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      </group>

      {/* Shaft segments - renders N+1 segments for N joints */}
      {segments.map((segment) => (
        <ShaftSegment
          key={segment.id}
          segment={segment}
          color={supportColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      ))}

      {/* Ball joints - renders N joints */}
      {joints.map((joint) => (
        <BallJoint
          key={joint.id}
          joint={joint}
          supportId={support.id}
          isSelected={selectedJointId === joint.id}
          isHovered={hoveredJointId === joint.id}
          color="#888888"
          supportColor={supportColor}
          isSupportSelected={isSelected}
          isSupportHovered={isHovered}
          onSelect={onJointSelect}
          onHoverChange={onJointHoverChange}
          onSupportHoverChange={onHoverChange}
          onSupportSelect={onSelect}
          supportClickedRef={supportClickedRef}
        />
      ))}

      {/* Base cylinder - only for trunk supports (rooted to plate), not branches */}
      {!support.parentBaseId && ((raft as any).bottomMode ? (raft as any).bottomMode !== 'solid' : !(raft as any).enabled) && (
        <group position={[baseCenter.x, baseCenter.y, baseCenter.z]} quaternion={baseQuaternion}>
          <mesh>
            <cylinderGeometry args={[baseRadius, baseRadius, baseHeight, 16]} />
            <meshStandardMaterial
              color={supportColor}
              emissive={emissive}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
        </group>
      )}

      {/* Base flare cone - only for trunk supports when enabled */}
      {!support.parentBaseId && settings.baseFlare.enabled && (
        (() => {
          // When rotated 90° flat: radiusBottom = outer edge (plate), radiusTop = inner edge (base)
          const flareOuterRadius = settings.baseFlare.diameterMm / 2; // Wide end at plate
          const flareInnerRadius = Math.max(0.05, shaftRadius - 0.05); // Narrow end: shaft diameter - 0.1mm
          const flareHeight = settings.baseFlare.heightMm;

          // Position: center between plate and base cylinder, extending upward from plate
          const flareCenter = new THREE.Vector3(
            base.x,
            base.y,
            base.z + flareHeight / 2
          );

          // Rotation: same as base (flat on XY plane)
          const flareQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

          return (
            <group position={[flareCenter.x, flareCenter.y, flareCenter.z]} quaternion={flareQuaternion}>
              <mesh>
                {/* CylinderGeometry(radiusTop, radiusBottom, height) - SWAPPED: top=inner, bottom=outer */}
                <cylinderGeometry args={[flareInnerRadius, flareOuterRadius, flareHeight, 16]} />
                <meshStandardMaterial
                  color={supportColor}
                  emissive={emissive}
                  emissiveIntensity={emissiveIntensity}
                />
              </mesh>
            </group>
          );
        })()
      )}
    </group>
  );
}
/**
 * Renders all supports in the collection.
 * Supports multi-segment shafts with variable joint counts.
 */
export function SupportRenderer({
  supports,
  selectedId,
  onSelect,
  hoveredId,
  onHoverChange,
  supportClickedRef,
  selectedJointId,
  hoveredJointId,
  onJointSelect,
  onJointHoverChange,
  jointCreationMode,
}: {
  supports: SupportInstance[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  hoveredId?: string | null;
  onHoverChange?: (id: string | null) => void;
  supportClickedRef?: React.RefObject<boolean>;
  selectedJointId?: string | null;
  hoveredJointId?: string | null;
  onJointSelect?: (supportId: string, jointId: string) => void;
  onJointHoverChange?: (supportId: string, jointId: string | null) => void;
  jointCreationMode?: boolean;
}) {
  return (
    <>
      {supports.map((support) => (
        <SingleSupport
          key={support.id}
          support={support}
          isSelected={selectedId === support.id}
          isHovered={!jointCreationMode && hoveredId === support.id}
          onSelect={onSelect}
          onHoverChange={onHoverChange}
          supportClickedRef={supportClickedRef}
          selectedJointId={selectedJointId}
          hoveredJointId={hoveredJointId}
          onJointSelect={onJointSelect}
          onJointHoverChange={onJointHoverChange}
        />
      ))}
    </>
  );
}
