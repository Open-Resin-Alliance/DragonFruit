import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Twig } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactDiskRenderer } from '../../SupportPrimitives/ContactDisk';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { setSelectedId } from '../../state';

interface TwigRendererProps {
  twig: Twig;
  isSelected?: boolean;
  selectedId?: string | null;
  dimNonSelected?: boolean;
  isHovered?: boolean;
  suppressHover?: boolean;
  isInteractable?: boolean;
}

export function TwigRenderer({
  twig,
  isSelected,
  selectedId,
  dimNonSelected,
  isHovered: propHovered,
  suppressHover,
  isInteractable = true,
}: TwigRendererProps) {
  const { pickRef, visuals } = useHighlight({
    id: twig.id,
    category: 'support',
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
    selectedColor: '#80fffd',
  });

  const handleClick = (e: any) => {
    handleSupportClick(e, twig.id, !!isInteractable);
  };

  const shafts: React.ReactNode[] = [];

  const joints = useMemo(() => {
    const map = new Map<string, { id: string; pos: { x: number; y: number; z: number }; diameter: number }>();
    for (const seg of twig.segments) {
      if (seg.bottomJoint) map.set(seg.bottomJoint.id, seg.bottomJoint);
      if (seg.topJoint) map.set(seg.topJoint.id, seg.topJoint);
    }
    return Array.from(map.values());
  }, [twig.segments]);

  twig.segments.forEach((seg, index) => {
    let startPoint: THREE.Vector3;
    let endPoint: THREE.Vector3;

    if (seg.bottomJoint) {
      startPoint = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
    } else {
      startPoint = new THREE.Vector3(twig.contactDiskA.pos.x, twig.contactDiskA.pos.y, twig.contactDiskA.pos.z);
    }

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else {
      endPoint = new THREE.Vector3(twig.contactDiskB.pos.x, twig.contactDiskB.pos.y, twig.contactDiskB.pos.z);
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

  const diskA = (
    <ContactDiskRenderer
      pos={twig.contactDiskA.pos}
      normal={twig.contactDiskA.surfaceNormal}
      coneAxis={twig.contactDiskA.coneAxis}
      profile={twig.contactDiskA.profile}
      contactDiameterMm={twig.contactDiskA.contactDiameterMm}
      overrideThickness={twig.contactDiskA.diskLengthOverride}
      color={visuals.color}
    />
  );

  const diskB = (
    <ContactDiskRenderer
      pos={twig.contactDiskB.pos}
      normal={twig.contactDiskB.surfaceNormal}
      coneAxis={twig.contactDiskB.coneAxis}
      profile={twig.contactDiskB.profile}
      contactDiameterMm={twig.contactDiskB.contactDiameterMm}
      overrideThickness={twig.contactDiskB.diskLengthOverride}
      color={visuals.color}
    />
  );

  return (
    <group onClick={handleClick}>
      <group ref={pickRef as any}>
        {shafts}
        {diskA}
        {diskB}
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
