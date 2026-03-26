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
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { getSnapshot, subscribe, updateBranch } from '../../state';

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
  const liveDragConeRef = React.useRef<import('../../SupportPrimitives/ContactCone/types').ContactCone | null>(null);
  const [, setDragTick] = React.useState(0);

  // Use universal highlight hook (matches TrunkRenderer pattern)
  const { pickRef, visuals, isPickingHovered } = useHighlight({
    id: branch.id,
    category: 'support',
    enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    selectedColor,
    hoverColor,
  });

  // Handle Click
  const handleClick = (e: any) => {
    if (!isPickingHovered && !isSelected) return;
    handleSupportClick(e, branch.id, !!isInteractable);
  };

  const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
    if (!isSelected || !branch.contactCone) return;
    if (!isPrimaryPointerPress(e)) return;

    const socketAnchor = getFinalSocketPosition(branch.contactCone);

    dragSessionRef.current?.stop();
    dragSessionRef.current = startContactDiskDragSession({
      camera,
      domElement: gl.domElement,
      scene,
      initialEvent: e,
      modelId: branch.modelId,
      onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
        const latest = getSnapshot().branches[branch.id];
        if (!latest?.contactCone) return;
        liveDragConeRef.current = recomputeContactConeForMovedDisk(latest.contactCone, point, surfaceNormal, socketAnchor);
        setDragTick(t => t + 1);
      },
      onEnd: () => {
        if (liveDragConeRef.current) {
          const latest = getSnapshot().branches[branch.id];
          if (latest) updateBranch({ ...latest, contactCone: liveDragConeRef.current });
        }
        liveDragConeRef.current = null;
        dragSessionRef.current = null;
      },
    });
  }, [branch.id, branch.contactCone, branch.modelId, camera, gl.domElement, isSelected, scene]);

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
          onClick={() => selectPrimitiveById(seg.id)}
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
          onClick={() => selectPrimitiveById(seg.id)}
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
  const effectiveCone = liveDragConeRef.current ?? branch.contactCone;
  let coneRender = null;
  if (effectiveCone && !deferContactConesToSceneBatch) {
    const isConeSelected = !!effectiveCone.id && supportState.selectedId === effectiveCone.id;
    coneRender = (
      <ContactConeRenderer
        contactDiskId={effectiveCone.id}
        pos={effectiveCone.pos}
        normal={effectiveCone.normal}
        surfaceNormal={effectiveCone.surfaceNormal}
        diskLengthOverride={effectiveCone.diskLengthOverride}
        profile={effectiveCone.profile}
        color={visuals.color}
        emissive={visuals.emissive}
        emissiveIntensity={visuals.emissiveIntensity}
        radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
        sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
        socketJointId={effectiveCone.socketJointId}
        isInteractable={isInteractable}
        isParentSelected={isSelected}
        isContactDiskSelected={isConeSelected}
        onDiskHudHoverChange={onContactDiskHudHoverChange}
        onDiskHudPointerDown={handleContactDiskHudPointerDown}
        onDiskHudPointerUp={handleContactDiskHudPointerUp}
      />
    );
  }

  return (
    <group
      onClick={handleClick}
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
