import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Stick } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { setSelectedId } from '../../state';

interface StickRendererProps {
  stick: Stick;
  isSelected?: boolean;
  selectedId?: string | null;
  dimNonSelected?: boolean;
  isHovered?: boolean;
  suppressHover?: boolean;
  isInteractable?: boolean;
}

export function StickRenderer({
  stick,
  isSelected,
  selectedId,
  dimNonSelected,
  isHovered: propHovered,
  suppressHover,
  isInteractable = true,
}: StickRendererProps) {
  const { pickRef, visuals } = useHighlight({
    id: stick.id,
    category: 'support',
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
    selectedColor: '#80fffd',
  });

  const handleClick = (e: any) => {
    handleSupportClick(e, stick.id, !!isInteractable);
  };

  const shafts: React.ReactNode[] = [];

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

    if (seg.type === 'bezier') {
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
  });

  const coneA = (
    <ContactConeRenderer
      pos={stick.contactConeA.pos}
      normal={stick.contactConeA.normal}
      surfaceNormal={stick.contactConeA.surfaceNormal}
      diskLengthOverride={stick.contactConeA.diskLengthOverride}
      profile={stick.contactConeA.profile}
      color={visuals.color}
      emissive={visuals.emissive}
      emissiveIntensity={visuals.emissiveIntensity}
      socketJointId={stick.contactConeA.socketJointId}
      isInteractable={isInteractable}
      isParentSelected={isSelected}
    />
  );

  const coneB = (
    <ContactConeRenderer
      pos={stick.contactConeB.pos}
      normal={stick.contactConeB.normal}
      surfaceNormal={stick.contactConeB.surfaceNormal}
      diskLengthOverride={stick.contactConeB.diskLengthOverride}
      profile={stick.contactConeB.profile}
      color={visuals.color}
      emissive={visuals.emissive}
      emissiveIntensity={visuals.emissiveIntensity}
      socketJointId={stick.contactConeB.socketJointId}
      isInteractable={isInteractable}
      isParentSelected={isSelected}
    />
  );

  return (
    <group onClick={handleClick}>
      <group ref={pickRef as any}>
        {shafts}
        {coneA}
        {coneB}
      </group>

      {joints.map((joint) => (
        <JointRenderer
          key={`joint-${joint.id}`}
          joint={joint}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
          isInteractable={isInteractable}
          isParentSelected={isSelected}
        />
      ))}
    </group>
  );
}
