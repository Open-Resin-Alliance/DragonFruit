import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ContactDisk, Twig } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { ContactDiskRenderer } from '../../SupportPrimitives/ContactDisk/ContactDiskRenderer';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { usePartDragUpdate } from '../../interaction/partDragPreview';
import { getSnapshot, updateTwig } from '../../state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

interface TwigRendererProps {
  twig: Twig;
  isSelected?: boolean;
  selectedId?: string | null;
  dimNonSelected?: boolean;
  isHovered?: boolean;
  suppressHover?: boolean;
  isInteractable?: boolean;
  deferStraightShaftsToSceneBatch?: boolean;
  deferInteractionToSceneBatch?: boolean;
  baseColor?: string;
  hoverColor?: string;
  selectedColor?: string;
}

export const TwigRenderer = React.memo(function TwigRenderer({
  twig: baseTwig,
  isSelected,
  selectedId,
  dimNonSelected,
  isHovered: propHovered,
  suppressHover,
  isInteractable = true,
  deferStraightShaftsToSceneBatch = false,
  deferInteractionToSceneBatch = false,
  baseColor = '#ff8800',
  hoverColor,
  selectedColor = '#80fffd',
}: TwigRendererProps) {
  const { camera, scene, gl } = useThree();
  const highDetailPrimitiveSegments = 24;
  const lowDetailPrimitiveSegments = 8;
  const useLowDetailPrimitives = !isSelected && !propHovered;
  const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);
  const liveDragTwigRef = React.useRef<Twig | null>(null);
  const beforeHistoryRef = React.useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
  const [, setDragTick] = React.useState(0);

  const previewTwig = usePartDragUpdate<Twig>('twig', baseTwig.id);
  const twig = previewTwig ?? baseTwig;

  React.useEffect(() => {
    return () => {
      dragSessionRef.current?.stop();
      dragSessionRef.current = null;
      liveDragTwigRef.current = null;
      beforeHistoryRef.current = null;
    };
  }, []);

  const { pickRef, visuals, isPickingHovered } = useHighlight({
    id: twig.id,
    category: 'support',
    enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
    isSelected,
    suppressHover,
    externalHover: propHovered,
    baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    selectedColor,
    hoverColor,
  });

  const handleClick = (e: unknown) => {
    if (!isPickingHovered) return;
    handleSupportClick(e, twig.id, !!isInteractable);
  };

  const getDiskTipCenter = React.useCallback((disk: ContactDisk) => {
    const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
    return {
      x: disk.pos.x + disk.surfaceNormal.x * thickness,
      y: disk.pos.y + disk.surfaceNormal.y * thickness,
      z: disk.pos.z + disk.surfaceNormal.z * thickness,
    };
  }, []);

  const recomputeTwigForMovedDisk = React.useCallback((
    sourceTwig: Twig,
    diskKey: 'contactDiskA' | 'contactDiskB',
    point: { x: number; y: number; z: number },
    surfaceNormal: { x: number; y: number; z: number },
  ) => {
    const firstSegment = sourceTwig.segments[0];
    const lastSegment = sourceTwig.segments[sourceTwig.segments.length - 1];

    const socketA = firstSegment?.bottomJoint?.pos ?? getDiskTipCenter(sourceTwig.contactDiskA);
    const socketB = lastSegment?.topJoint?.pos ?? getDiskTipCenter(sourceTwig.contactDiskB);

    const recomputeDiskForFixedSocket = (
      disk: ContactDisk,
      desiredSocket: { x: number; y: number; z: number },
      axisHint: THREE.Vector3,
    ): ContactDisk => {
      const contactPos = new THREE.Vector3(point.x, point.y, point.z);
      const desiredSocketVec = new THREE.Vector3(desiredSocket.x, desiredSocket.y, desiredSocket.z);
      const toSocket = desiredSocketVec.clone().sub(contactPos);

      let normal = toSocket.clone();
      if (normal.lengthSq() < 0.000001) {
        normal.set(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
      }
      if (normal.lengthSq() < 0.000001) {
        normal.set(disk.surfaceNormal.x, disk.surfaceNormal.y, disk.surfaceNormal.z);
      }
      if (normal.lengthSq() < 0.000001) {
        normal.set(0, 0, 1);
      }
      normal.normalize();

      let axis = axisHint.clone();
      if (axis.lengthSq() < 0.000001) {
        axis.set(disk.coneAxis.x, disk.coneAxis.y, disk.coneAxis.z);
      }
      if (axis.lengthSq() < 0.000001) {
        axis.copy(normal);
      }
      axis.normalize();

      const thickness = Math.max(0.001, toSocket.length());

      return {
        ...disk,
        pos: { x: point.x, y: point.y, z: point.z },
        surfaceNormal: { x: normal.x, y: normal.y, z: normal.z },
        coneAxis: { x: axis.x, y: axis.y, z: axis.z },
        diskLengthOverride: thickness,
      };
    };

    let nextDiskA = sourceTwig.contactDiskA;
    let nextDiskB = sourceTwig.contactDiskB;

    if (diskKey === 'contactDiskA') {
      const axisHint = new THREE.Vector3(socketB.x - socketA.x, socketB.y - socketA.y, socketB.z - socketA.z);
      nextDiskA = recomputeDiskForFixedSocket(sourceTwig.contactDiskA, socketA, axisHint);
    } else {
      const axisHint = new THREE.Vector3(socketA.x - socketB.x, socketA.y - socketB.y, socketA.z - socketB.z);
      nextDiskB = recomputeDiskForFixedSocket(sourceTwig.contactDiskB, socketB, axisHint);
    }

    let socketAxis = new THREE.Vector3(socketB.x - socketA.x, socketB.y - socketA.y, socketB.z - socketA.z);
    if (socketAxis.lengthSq() < 0.000001) {
      socketAxis.set(nextDiskA.coneAxis.x, nextDiskA.coneAxis.y, nextDiskA.coneAxis.z);
    }
    if (socketAxis.lengthSq() < 0.000001) {
      socketAxis.set(0, 0, 1);
    }
    socketAxis.normalize();

    nextDiskA = {
      ...nextDiskA,
      coneAxis: { x: socketAxis.x, y: socketAxis.y, z: socketAxis.z },
    };
    nextDiskB = {
      ...nextDiskB,
      coneAxis: { x: -socketAxis.x, y: -socketAxis.y, z: -socketAxis.z },
    };

    return {
      ...sourceTwig,
      contactDiskA: nextDiskA,
      contactDiskB: nextDiskB,
      segments: sourceTwig.segments,
    };
  }, [getDiskTipCenter]);

  const startDiskDrag = React.useCallback((diskKey: 'contactDiskA' | 'contactDiskB', initialEvent?: any) => {
    if (!isSelected) return;

    beforeHistoryRef.current = captureSupportEditSnapshot();
    dragSessionRef.current?.stop();

    dragSessionRef.current = startContactDiskDragSession({
      camera,
      domElement: gl.domElement,
      scene,
      initialEvent,
      modelId: twig.modelId,
      onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
        const latestTwig = getSnapshot().twigs[twig.id];
        if (!latestTwig) return;
        liveDragTwigRef.current = recomputeTwigForMovedDisk(latestTwig, diskKey, point, surfaceNormal);
        setDragTick((tick) => tick + 1);
      },
      onEnd: () => {
        if (liveDragTwigRef.current) {
          updateTwig(liveDragTwigRef.current);
          if (beforeHistoryRef.current) {
            pushSupportEditHistory('Move twig tip', beforeHistoryRef.current, captureSupportEditSnapshot());
          }
        }
        liveDragTwigRef.current = null;
        dragSessionRef.current = null;
        beforeHistoryRef.current = null;
      },
    });
  }, [camera, gl.domElement, isSelected, recomputeTwigForMovedDisk, scene, twig.id, twig.modelId]);

  const handleContactDiskHudPointerDownA = React.useCallback((e: any) => {
    if (!isSelected) return;
    if (!isPrimaryPointerPress(e)) return;
    startDiskDrag('contactDiskA', e);
  }, [isSelected, startDiskDrag]);

  const handleContactDiskHudPointerDownB = React.useCallback((e: any) => {
    if (!isSelected) return;
    if (!isPrimaryPointerPress(e)) return;
    startDiskDrag('contactDiskB', e);
  }, [isSelected, startDiskDrag]);

  const handleContactDiskHudPointerUp = React.useCallback(() => {
    dragSessionRef.current?.stop();
    dragSessionRef.current = null;
  }, []);

  const effectiveTwig = liveDragTwigRef.current ?? twig;

  const shafts: React.ReactNode[] = [];
  const batchedStraightShafts: InstancedShaft[] = [];

  const joints = useMemo(() => {
    const map = new Map<string, { id: string; pos: { x: number; y: number; z: number }; diameter: number }>();
    for (const seg of effectiveTwig.segments) {
      if (seg.bottomJoint) map.set(seg.bottomJoint.id, seg.bottomJoint);
      if (seg.topJoint) map.set(seg.topJoint.id, seg.topJoint);
    }
    return Array.from(map.values());
  }, [effectiveTwig.segments]);

  const isDiskASelected = selectedId === effectiveTwig.contactDiskA.id;
  const isDiskBSelected = selectedId === effectiveTwig.contactDiskB.id;

  effectiveTwig.segments.forEach((seg) => {
    let startPoint: THREE.Vector3;
    let endPoint: THREE.Vector3;
    let diameterStart = seg.diameter;
    let diameterEnd = seg.diameter;

    if (seg.bottomJoint) {
      startPoint = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
    } else {
      const diskATipCenter = getDiskTipCenter(effectiveTwig.contactDiskA);
      startPoint = new THREE.Vector3(diskATipCenter.x, diskATipCenter.y, diskATipCenter.z);
      diameterStart = effectiveTwig.contactDiskA.contactDiameterMm;
    }

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else {
      const diskBTipCenter = getDiskTipCenter(effectiveTwig.contactDiskB);
      endPoint = new THREE.Vector3(diskBTipCenter.x, diskBTipCenter.y, diskBTipCenter.z);
      diameterEnd = effectiveTwig.contactDiskB.contactDiameterMm;
    }

    const startPosVec = { x: startPoint.x, y: startPoint.y, z: startPoint.z };
    const endPosVec = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

    const isSegSelected = selectedId === seg.id;

    const canBatchShaft = !isSelected && !deferStraightShaftsToSceneBatch && seg.type !== 'bezier' && Math.abs(diameterStart - diameterEnd) < 1e-6;

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
          diameterStart={diameterStart}
          diameterEnd={diameterEnd}
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

  const diskA = (
    <ContactDiskRenderer
      id={twig.contactDiskA.id}
      pos={effectiveTwig.contactDiskA.pos}
      normal={effectiveTwig.contactDiskA.surfaceNormal}
      coneAxis={effectiveTwig.contactDiskA.coneAxis}
      profile={effectiveTwig.contactDiskA.profile}
      contactDiameterMm={effectiveTwig.contactDiskA.contactDiameterMm}
      overrideThickness={effectiveTwig.contactDiskA.diskLengthOverride}
      radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      color={visuals.color}
      isInteractable={isInteractable}
      isParentSelected={!!isSelected}
      isContactDiskSelected={isDiskASelected}
      onHudPointerDown={handleContactDiskHudPointerDownA}
      onHudPointerUp={handleContactDiskHudPointerUp}
    />
  );

  const diskB = (
    <ContactDiskRenderer
      id={effectiveTwig.contactDiskB.id}
      pos={effectiveTwig.contactDiskB.pos}
      normal={effectiveTwig.contactDiskB.surfaceNormal}
      coneAxis={effectiveTwig.contactDiskB.coneAxis}
      profile={effectiveTwig.contactDiskB.profile}
      contactDiameterMm={effectiveTwig.contactDiskB.contactDiameterMm}
      overrideThickness={effectiveTwig.contactDiskB.diskLengthOverride}
      radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
      color={visuals.color}
      isInteractable={isInteractable}
      isParentSelected={!!isSelected}
      isContactDiskSelected={isDiskBSelected}
      onHudPointerDown={handleContactDiskHudPointerDownB}
      onHudPointerUp={handleContactDiskHudPointerUp}
    />
  );

  return (
    <group
      onClick={handleClick}
    >
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
