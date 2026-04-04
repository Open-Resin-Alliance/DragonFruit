import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Stick } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { usePartDragUpdate } from '../../interaction/partDragPreview';
import { getSnapshot, updateStick } from '../../state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

interface StickRendererProps {
  stick: Stick;
  isSelected?: boolean;
  selectedId?: string | null;
  dimNonSelected?: boolean;
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

export const StickRenderer = React.memo(function StickRenderer({
  stick: baseStick,
  isSelected,
  selectedId,
  dimNonSelected,
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
}: StickRendererProps) {
  const previewStick = usePartDragUpdate<Stick>('stick', baseStick.id);
  const stick = previewStick ?? baseStick;
  
  const { camera, scene, gl } = useThree();
  const highDetailPrimitiveSegments = 24;
  const lowDetailPrimitiveSegments = 8;
  const useLowDetailPrimitives = !isSelected && !propHovered;
  const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);
  const liveDragConeARef = React.useRef<ContactCone | null>(null);
  const liveDragConeBRef = React.useRef<ContactCone | null>(null);
  const beforeHistoryRef = React.useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
  const [, setDragTick] = React.useState(0);

  const { pickRef, visuals } = useHighlight({
    id: stick.id,
    category: 'support',
    enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    selectedColor,
    hoverColor,
  });

  const handleClick = (e: any) => {
    handleSupportClick(e, stick.id, !!isInteractable);
  };

  const startConeDrag = React.useCallback((coneKey: 'contactConeA' | 'contactConeB', initialEvent?: any) => {
    const cone = stick[coneKey];
    if (!cone) return;
    const socketAnchor = getFinalSocketPosition(cone);

    beforeHistoryRef.current = captureSupportEditSnapshot();

    dragSessionRef.current?.stop();
    dragSessionRef.current = startContactDiskDragSession({
      camera,
      domElement: gl.domElement,
      scene,
      initialEvent,
      modelId: stick.modelId,
      onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
        const latestStick = getSnapshot().sticks[stick.id];
        const latestCone = latestStick?.[coneKey] as ContactCone | undefined;
        if (!latestStick || !latestCone) return;
        const newCone = recomputeContactConeForMovedDisk(latestCone, point, surfaceNormal, socketAnchor);
        if (coneKey === 'contactConeA') liveDragConeARef.current = newCone;
        else liveDragConeBRef.current = newCone;
        setDragTick(t => t + 1);
      },
      onEnd: () => {
        const dragA = liveDragConeARef.current;
        const dragB = liveDragConeBRef.current;
        if (dragA || dragB) {
          const latestStick = getSnapshot().sticks[stick.id];
          if (latestStick) {
            updateStick({
              ...latestStick,
              ...(dragA ? { contactConeA: dragA } : {}),
              ...(dragB ? { contactConeB: dragB } : {}),
            });
            if (beforeHistoryRef.current) {
              pushSupportEditHistory('Move stick tip', beforeHistoryRef.current, captureSupportEditSnapshot());
            }
          }
        }
        liveDragConeARef.current = null;
        liveDragConeBRef.current = null;
        dragSessionRef.current = null;
        beforeHistoryRef.current = null;
      },
    });
  }, [camera, gl.domElement, scene, stick.id, stick.contactConeA, stick.contactConeB, stick.modelId]);

  const handleContactDiskHudPointerDownA = React.useCallback((e: any) => {
    if (!isSelected || !stick.contactConeA) return;
    if (!isPrimaryPointerPress(e)) return;
    startConeDrag('contactConeA', e);
  }, [isSelected, startConeDrag, stick.contactConeA]);

  const handleContactDiskHudPointerDownB = React.useCallback((e: any) => {
    if (!isSelected || !stick.contactConeB) return;
    if (!isPrimaryPointerPress(e)) return;
    startConeDrag('contactConeB', e);
  }, [isSelected, startConeDrag, stick.contactConeB]);

  const handleContactDiskHudPointerUp = React.useCallback(() => {
    dragSessionRef.current?.stop();
    dragSessionRef.current = null;
  }, []);
  const shafts: React.ReactNode[] = [];
  const batchedStraightShafts: InstancedShaft[] = [];

  const joints = useMemo(() => {
    const map = new Map<string, { id: string; pos: { x: number; y: number; z: number }; diameter: number }>();
    for (const seg of stick.segments) {
      if (seg.bottomJoint) map.set(seg.bottomJoint.id, seg.bottomJoint);
      if (seg.topJoint) map.set(seg.topJoint.id, seg.topJoint);
    }
    return Array.from(map.values());
  }, [stick.segments]);

  stick.segments.forEach((seg) => {
    let startPoint: THREE.Vector3;
    let endPoint: THREE.Vector3;

    if (seg.bottomJoint) {
      startPoint = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
    } else {
      const socket = getFinalSocketPosition(stick.contactConeA);
      startPoint = new THREE.Vector3(socket.x, socket.y, socket.z);
    }

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else {
      const socket = getFinalSocketPosition(stick.contactConeB);
      endPoint = new THREE.Vector3(socket.x, socket.y, socket.z);
    }

    const startPosVec = { x: startPoint.x, y: startPoint.y, z: startPoint.z };
    const endPosVec = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

    const isSegSelected = selectedId === seg.id;

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
          isInteractable={isInteractable}
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
          isInteractable={isInteractable}
          isSelected={isSegSelected}
          onClick={() => selectPrimitiveById(seg.id)}
        />
      );
    }
  });

  const effectiveConeA = liveDragConeARef.current ?? stick.contactConeA;
  const effectiveConeB = liveDragConeBRef.current ?? stick.contactConeB;
  const isConeASelected = !!effectiveConeA.id && selectedId === effectiveConeA.id;
  const isConeBSelected = !!effectiveConeB.id && selectedId === effectiveConeB.id;

  const coneA = !deferContactConesToSceneBatch && (
    <ContactConeRenderer
      contactDiskId={effectiveConeA.id}
      pos={effectiveConeA.pos}
      normal={effectiveConeA.normal}
      surfaceNormal={effectiveConeA.surfaceNormal}
      diskLengthOverride={effectiveConeA.diskLengthOverride}
      profile={effectiveConeA.profile}
      color={visuals.color}
      emissive={visuals.emissive}
      emissiveIntensity={visuals.emissiveIntensity}
      radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      socketJointId={effectiveConeA.socketJointId}
      isInteractable={isInteractable}
      isParentSelected={isSelected}
      isContactDiskSelected={isConeASelected}
      onDiskHudHoverChange={onContactDiskHudHoverChange}
      onDiskHudPointerDown={handleContactDiskHudPointerDownA}
      onDiskHudPointerUp={handleContactDiskHudPointerUp}
    />
  );

  const coneB = !deferContactConesToSceneBatch && (
    <ContactConeRenderer
      contactDiskId={effectiveConeB.id}
      pos={effectiveConeB.pos}
      normal={effectiveConeB.normal}
      surfaceNormal={effectiveConeB.surfaceNormal}
      diskLengthOverride={effectiveConeB.diskLengthOverride}
      profile={effectiveConeB.profile}
      color={visuals.color}
      emissive={visuals.emissive}
      emissiveIntensity={visuals.emissiveIntensity}
      radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      socketJointId={effectiveConeB.socketJointId}
      isInteractable={isInteractable}
      isParentSelected={isSelected}
      isContactDiskSelected={isConeBSelected}
      onDiskHudHoverChange={onContactDiskHudHoverChange}
      onDiskHudPointerDown={handleContactDiskHudPointerDownB}
      onDiskHudPointerUp={handleContactDiskHudPointerUp}
    />
  );

  return (
    <group
      onClick={handleClick}
    >
      <group ref={pickRef as any}>
        <InstancedShaftGroup
          shafts={batchedStraightShafts}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
        />
        {shafts}
        {coneA}
        {coneB}
      </group>

      {isSelected && joints.map((joint) => (
        <JointRenderer
          key={`joint-${joint.id}`}
          joint={joint}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          selectedColor={visuals.selectedColor}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      ))}
    </group>
  );
});

StickRenderer.displayName = 'StickRenderer';
