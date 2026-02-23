import React, { useMemo } from 'react';
import * as THREE from 'three';
import { ContactDisk, Twig } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactDiskRenderer } from '../../SupportPrimitives/ContactDisk/ContactDiskRenderer';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { handleSupportClick, emitSupportModelPointerHover } from '../../interaction/clickHandlers';
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
  baseColor?: string;
  hoverColor?: string;
  selectedColor?: string;
}

export const TwigRenderer = React.memo(function TwigRenderer({
  twig,
  isSelected,
  selectedId,
  dimNonSelected,
  isHovered: propHovered,
  suppressHover,
  isInteractable = true,
  baseColor = '#ff8800',
  hoverColor,
  selectedColor = '#80fffd',
}: TwigRendererProps) {
  const { pickRef, visuals } = useHighlight({
    id: twig.id,
    category: 'support',
    enabled: !!isInteractable && !suppressHover,
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    selectedColor,
    hoverColor,
  });

  const handleClick = (e: unknown) => {
    handleSupportClick(e, twig.id, !!isInteractable);
  };

  const handlePointerMove = React.useCallback(() => {
    emitSupportModelPointerHover(twig.modelId ?? null);
  }, [twig.modelId]);

  const handlePointerOut = React.useCallback(() => {
    emitSupportModelPointerHover(null);
  }, []);

  const shafts: React.ReactNode[] = [];
  const batchedStraightShafts: InstancedShaft[] = [];

  const joints = useMemo(() => {
    const map = new Map<string, { id: string; pos: { x: number; y: number; z: number }; diameter: number }>();
    for (const seg of twig.segments) {
      if (seg.bottomJoint) map.set(seg.bottomJoint.id, seg.bottomJoint);
      if (seg.topJoint) map.set(seg.topJoint.id, seg.topJoint);
    }
    return Array.from(map.values());
  }, [twig.segments]);

  const getDiskTipCenter = (disk: ContactDisk) => {
    const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
    return {
      x: disk.pos.x + disk.surfaceNormal.x * thickness,
      y: disk.pos.y + disk.surfaceNormal.y * thickness,
      z: disk.pos.z + disk.surfaceNormal.z * thickness,
    };
  };

  twig.segments.forEach((seg) => {
    let startPoint: THREE.Vector3;
    let endPoint: THREE.Vector3;
    let diameterStart = seg.diameter;
    let diameterEnd = seg.diameter;

    if (seg.bottomJoint) {
      startPoint = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
    } else {
      const diskATipCenter = getDiskTipCenter(twig.contactDiskA);
      startPoint = new THREE.Vector3(diskATipCenter.x, diskATipCenter.y, diskATipCenter.z);
      diameterStart = twig.contactDiskA.contactDiameterMm;
    }

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else {
      const diskBTipCenter = getDiskTipCenter(twig.contactDiskB);
      endPoint = new THREE.Vector3(diskBTipCenter.x, diskBTipCenter.y, diskBTipCenter.z);
      diameterEnd = twig.contactDiskB.contactDiameterMm;
    }

    const startPosVec = { x: startPoint.x, y: startPoint.y, z: startPoint.z };
    const endPosVec = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

    const isSegSelected = selectedId === seg.id;

    const canBatchShaft = !isSelected && seg.type !== 'bezier' && Math.abs(diameterStart - diameterEnd) < 1e-6;

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
    } else {
      shafts.push(
        <ShaftRenderer
          key={`shaft-${seg.id}`}
          id={seg.id}
          start={startPosVec}
          end={endPosVec}
          diameter={seg.diameter}
          diameterStart={diameterStart}
          diameterEnd={diameterEnd}
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
    <group onClick={handleClick} onPointerMove={handlePointerMove} onPointerOut={handlePointerOut}>
      <group ref={pickRef as React.Ref<THREE.Group>}>
        <InstancedShaftGroup
          shafts={batchedStraightShafts}
          color={visuals.color}
          emissive={visuals.emissive}
          emissiveIntensity={visuals.emissiveIntensity}
        />
        {shafts}
        {diskA}
        {diskB}
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

TwigRenderer.displayName = 'TwigRenderer';
