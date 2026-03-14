import React, { useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Branch, Knot } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick, emitSupportModelPointerHover } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { getSnapshot, setSelectedId, subscribe, updateBranch } from '../../state';

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
  deferStraightShaftsToSceneBatch?: boolean;
  deferInteractionToSceneBatch?: boolean;
  deferContactConesToSceneBatch?: boolean;
  baseColor?: string;
  hoverColor?: string;
  selectedColor?: string;
  onContactDiskHudHoverChange?: (hovered: boolean) => void;
}

export const BranchRenderer = React.memo(function BranchRenderer({ 
  branch, 
  parentKnot, 
  isSelected, 
  selectedId, 
  dimNonSelected,
  showKnots,
  isHovered: propHovered, 
  suppressHover,
  isInteractable = true,
  deferStraightShaftsToSceneBatch = false,
  deferInteractionToSceneBatch = false,
  deferContactConesToSceneBatch = false,
  baseColor = '#ff8800',
  hoverColor,
  selectedColor = '#80fffd',
  onContactDiskHudHoverChange,
}: BranchRendererProps) {
  const { camera, scene, gl } = useThree();
  const supportState = useSyncExternalStore(subscribe, getSnapshot);
  const highDetailPrimitiveSegments = 24;
  const lowDetailPrimitiveSegments = 8;
  const useLowDetailPrimitives = !isSelected && !propHovered;
  const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);

  // Use universal highlight hook (matches TrunkRenderer pattern)
  const { pickRef, visuals } = useHighlight({
    id: branch.id,
    category: 'support',
    enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch,
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    selectedColor,
    hoverColor,
  });

  // Handle Click
  const handleClick = (e: any) => {
    handleSupportClick(e, branch.id, !!isInteractable);
  };

  const handlePointerMove = React.useCallback(() => {
    emitSupportModelPointerHover(branch.modelId ?? null);
  }, [branch.modelId]);

  const handlePointerOut = React.useCallback(() => {
    emitSupportModelPointerHover(null);
  }, []);

  const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
    console.log('[BranchDrag] HUD pointerDown fired | isSelected:', isSelected, '| hasCone:', !!branch.contactCone);
    if (!isSelected || !branch.contactCone) return;
    if (!isPrimaryPointerPress(e)) return;
    console.log('[BranchDrag] Starting drag session...');

    dragSessionRef.current?.stop();
    dragSessionRef.current = startContactDiskDragSession({
      camera,
      domElement: gl.domElement,
      scene,
      initialEvent: e,
      modelId: branch.modelId,
      onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
        const latestBranch = supportState.branches[branch.id];
        if (!latestBranch?.contactCone) return;
        updateBranch({
          ...latestBranch,
          contactCone: recomputeContactConeForMovedDisk(latestBranch.contactCone, point, surfaceNormal),
        });
      },
      onEnd: () => {
        dragSessionRef.current = null;
      },
    });
  }, [branch.id, branch.contactCone, camera, gl.domElement, isInteractable, isSelected, scene, supportState]);

  const handleContactDiskHudPointerUp = React.useCallback(() => {
    dragSessionRef.current?.stop();
    dragSessionRef.current = null;
  }, []);

  // Start point is the Knot position
  const startPos = parentKnot.pos 
    ? new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z)
    : new THREE.Vector3(0, 0, 0);

  let currentStart = startPos.clone();

  const shafts: React.ReactNode[] = [];
  const batchedStraightShafts: InstancedShaft[] = [];
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
    const canBatchShaft = !isSelected && !deferStraightShaftsToSceneBatch && seg.type !== 'bezier';

    if (canBatchShaft) {
      batchedStraightShafts.push({
        id: seg.id,
        start: startPosVec,
        end: endPosVec,
        diameter: seg.diameter,
      });
    } else if (seg.type === 'bezier') {
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
          selectedColor={visuals.selectedColor}
          isParentSelected={isSelected}
          isSelected={isSegSelected}
          onClick={() => setSelectedId(seg.id)}
        />
      );
    } else if (!deferStraightShaftsToSceneBatch || isSelected) {
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
          selectedColor={visuals.selectedColor}
          isParentSelected={isSelected}
          isSelected={isSegSelected}
          onClick={() => setSelectedId(seg.id)}
        />
      );
    }

    // Add Joint (if present)
    if (isSelected && seg.topJoint) {
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
          selectedColor={visuals.selectedColor}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      );
    }
  });

  // --- Render Contact Cone (if present) ---
  let coneRender = null;
  if (branch.contactCone && !deferContactConesToSceneBatch) {
    coneRender = (
      <ContactConeRenderer
        contactDiskId={branch.contactCone.id}
        pos={branch.contactCone.pos}
        normal={branch.contactCone.normal}
        surfaceNormal={branch.contactCone.surfaceNormal}
        diskLengthOverride={branch.contactCone.diskLengthOverride}
        profile={branch.contactCone.profile}
        color={visuals.color}
        emissive={visuals.emissive}
        emissiveIntensity={visuals.emissiveIntensity}
        radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
        sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
        socketJointId={branch.contactCone.socketJointId}
        isInteractable={isInteractable}
        isParentSelected={isSelected}
        onDiskHudHoverChange={onContactDiskHudHoverChange}
        onDiskHudPointerDown={handleContactDiskHudPointerDown}
        onDiskHudPointerUp={handleContactDiskHudPointerUp}
      />
    );
  }

  return (
    <group
      onClick={handleClick}
      onPointerMove={deferInteractionToSceneBatch ? undefined : handlePointerMove}
      onPointerOut={deferInteractionToSceneBatch ? undefined : handlePointerOut}
    >
      {/* Branch Picking Group - Contains Shafts, Cone */}
      <group ref={pickRef as any}>
        <InstancedShaftGroup
          shafts={batchedStraightShafts}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
        />
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
          selectedColor={visuals.selectedColor}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      )}

      {/* Joints - Separate picking */}
      {joints}
    </group>
  );
});

BranchRenderer.displayName = 'BranchRenderer';
