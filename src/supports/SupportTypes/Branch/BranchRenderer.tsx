import React from 'react';
import * as THREE from 'three';
import { Branch, Knot } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { setSelectedId } from '../../state';

interface BranchRendererProps {
  branch: Branch;
  parentKnot: Knot;
  isSelected?: boolean;
  selectedId?: string | null;
  dimNonSelected?: boolean;
  showKnots?: boolean;
  isHovered?: boolean;
  suppressHover?: boolean;
  isInteractable?: boolean;
}

export function BranchRenderer({ 
  branch, 
  parentKnot, 
  isSelected, 
  selectedId, 
  dimNonSelected,
  showKnots,
  isHovered: propHovered, 
  suppressHover,
  isInteractable = true 
}: BranchRendererProps) {
  // Use universal highlight hook (matches TrunkRenderer pattern)
  const { pickRef, visuals } = useHighlight({
    id: branch.id,
    category: 'support',
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
    selectedColor: '#80fffd'
  });

  // Handle Click
  const handleClick = (e: any) => {
    handleSupportClick(e, branch.id, !!isInteractable);
  };

  // Start point is the Knot position
  const startPos = parentKnot.pos 
    ? new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z)
    : new THREE.Vector3(0, 0, 0);

  let currentStart = startPos.clone();

  const shafts: React.ReactNode[] = [];
  const joints: React.ReactNode[] = [];

  branch.segments.forEach((seg, index) => {
    let endPoint: THREE.Vector3;

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else if (branch.contactCone) {
      // Shaft ends at the cone's socket position
      const socketPos = getFinalSocketPosition(branch.contactCone);
      endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else {
      endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 5));
    }

    const startPosVec = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
    const endPosVec = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

    currentStart = endPoint;

    const isSegSelected = selectedId === seg.id;

    // Add Shaft (straight or bezier)
    if (seg.type === 'bezier') {
      // Bezier segments appear Magenta when parent selected, otherwise standard color
      const bezierColor = isSelected ? '#ff00ff' : visuals.color;

      shafts.push(
        <BezierRenderer
          key={`shaft-${seg.id}`}
          id={seg.id}
          start={startPosVec}
          end={endPosVec}
          control1={seg.controlPoint1}
          control2={seg.controlPoint2}
          diameter={seg.diameter}
          resolution={seg.resolution}
          color={bezierColor}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          isParentSelected={isSelected}
          isSelected={isSegSelected}
          onClick={() => setSelectedId(seg.id)}
        />
      );
    } else {
      shafts.push(
        <ShaftRenderer
          key={`shaft-${seg.id}`}
          id={seg.id}
          start={startPosVec}
          end={endPosVec}
          diameter={seg.diameter}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          isParentSelected={isSelected}
          isSelected={isSegSelected}
          onClick={() => setSelectedId(seg.id)}
        />
      );
    }

    // Add Joint (if present)
    if (seg.topJoint) {
      joints.push(
        <JointRenderer
          key={`joint-${seg.topJoint.id}`}
          joint={{
            id: seg.topJoint.id,
            pos: seg.topJoint.pos,
            diameter: seg.topJoint.diameter
          }}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      );
    }
  });

  // --- Render Contact Cone (if present) ---
  let coneRender = null;
  if (branch.contactCone) {
    coneRender = (
      <ContactConeRenderer
        pos={branch.contactCone.pos}
        normal={branch.contactCone.normal}
        surfaceNormal={branch.contactCone.surfaceNormal}
        diskLengthOverride={branch.contactCone.diskLengthOverride}
        profile={branch.contactCone.profile}
        color={visuals.color}
        emissive={visuals.emissive}
        emissiveIntensity={visuals.emissiveIntensity}
        socketJointId={branch.contactCone.socketJointId}
        isInteractable={isInteractable}
        isParentSelected={isSelected}
      />
    );
  }

  return (
    <group onClick={handleClick}>
      {/* Branch Picking Group - Contains Shafts, Cone */}
      <group ref={pickRef as any}>
        {shafts}
        {coneRender}
      </group>

      {/* Knot - Separate picking (like joints) */}
      {showKnots !== false && (
        <KnotRenderer
          knot={parentKnot}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      )}

      {/* Joints - Separate picking */}
      {joints}
    </group>
  );
}
