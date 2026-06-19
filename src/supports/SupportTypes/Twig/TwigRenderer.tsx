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
import { getSnapshot, updateTwig, updateKnot, updateLeaf } from '../../state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';
import { twigDiskJointStandoff } from './twigJointStandoff';
import { clearTwigDragPreview, computeTwigDragAttachmentUpdates, emitTwigDragPreview } from './twigDragPreview';

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
    // Rule: the dragged disk's face stays glued to the model surface. Its
    // joint moves WITH the disk along the new surface normal. The other
    // disk/joint stay put. The shaft naturally re-angles between the two
    // joints. The disks' coneAxis points along the shaft.

    const normal = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
    if (normal.lengthSq() < 0.000001) {
      // Fallback to existing normal if the drag hit didn't supply one.
      const fallback = diskKey === 'contactDiskA'
        ? sourceTwig.contactDiskA.surfaceNormal
        : sourceTwig.contactDiskB.surfaceNormal;
      normal.set(fallback.x, fallback.y, fallback.z);
    }
    if (normal.lengthSq() < 0.000001) normal.set(0, 0, 1);
    normal.normalize();

    const movedDisk = diskKey === 'contactDiskA' ? sourceTwig.contactDiskA : sourceTwig.contactDiskB;
    // Stand-off scales with joint diameter so a large disk-end joint stays
    // off the model. coneAxis temporarily approximated by the normal; we'll
    // set the real coneAxis below once both joint positions are known.
    const firstSegInput = sourceTwig.segments[0];
    const lastSegInput = sourceTwig.segments[sourceTwig.segments.length - 1];
    const movedJointDiameter = (diskKey === 'contactDiskA'
      ? firstSegInput?.bottomJoint?.diameter
      : lastSegInput?.topJoint?.diameter
    ) ?? movedDisk.contactDiameterMm;
    const thickness = twigDiskJointStandoff({
      surfaceNormal: { x: normal.x, y: normal.y, z: normal.z },
      coneAxis: { x: normal.x, y: normal.y, z: normal.z },
      profile: movedDisk.profile,
      jointDiameterMm: movedJointDiameter,
    });

    const newJointPos = {
      x: point.x + normal.x * thickness,
      y: point.y + normal.y * thickness,
      z: point.z + normal.z * thickness,
    };

    // Build updated segments: move the disk-end joint to newJointPos; leave
    // mid-shaft joints and the other disk's joint untouched.
    const firstSegmentIndex = 0;
    const lastSegmentIndex = sourceTwig.segments.length - 1;
    const nextSegments = sourceTwig.segments.map((seg, idx) => {
      if (diskKey === 'contactDiskA' && idx === firstSegmentIndex && seg.bottomJoint) {
        return { ...seg, bottomJoint: { ...seg.bottomJoint, pos: newJointPos } };
      }
      if (diskKey === 'contactDiskB' && idx === lastSegmentIndex && seg.topJoint) {
        return { ...seg, topJoint: { ...seg.topJoint, pos: newJointPos } };
      }
      return seg;
    });

    // Resolve the two end-joint positions after the move so we can set
    // coneAxis on both disks (shaft direction).
    const firstSeg = nextSegments[firstSegmentIndex];
    const lastSeg = nextSegments[lastSegmentIndex];
    const jointAPos = firstSeg?.bottomJoint?.pos ?? newJointPos;
    const jointBPos = lastSeg?.topJoint?.pos ?? newJointPos;

    const shaftAxis = new THREE.Vector3(
      jointBPos.x - jointAPos.x,
      jointBPos.y - jointAPos.y,
      jointBPos.z - jointAPos.z,
    );
    if (shaftAxis.lengthSq() < 0.000001) shaftAxis.copy(normal);
    shaftAxis.normalize();

    const nextDiskA: ContactDisk = diskKey === 'contactDiskA'
      ? {
          ...sourceTwig.contactDiskA,
          pos: { x: point.x, y: point.y, z: point.z },
          surfaceNormal: { x: normal.x, y: normal.y, z: normal.z },
          coneAxis: { x: shaftAxis.x, y: shaftAxis.y, z: shaftAxis.z },
          diskLengthOverride: thickness,
        }
      : {
          ...sourceTwig.contactDiskA,
          coneAxis: { x: shaftAxis.x, y: shaftAxis.y, z: shaftAxis.z },
        };

    const nextDiskB: ContactDisk = diskKey === 'contactDiskB'
      ? {
          ...sourceTwig.contactDiskB,
          pos: { x: point.x, y: point.y, z: point.z },
          surfaceNormal: { x: normal.x, y: normal.y, z: normal.z },
          coneAxis: { x: -shaftAxis.x, y: -shaftAxis.y, z: -shaftAxis.z },
          diskLengthOverride: thickness,
        }
      : {
          ...sourceTwig.contactDiskB,
          coneAxis: { x: -shaftAxis.x, y: -shaftAxis.y, z: -shaftAxis.z },
        };

    return {
      ...sourceTwig,
      contactDiskA: nextDiskA,
      contactDiskB: nextDiskB,
      segments: nextSegments,
    };
  }, []);

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
      placementSurface: (diskKey === 'contactDiskA' ? twig.contactDiskA : twig.contactDiskB).placementSurface,
      onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
        const snap = getSnapshot();
        const latestTwig = snap.twigs[twig.id];
        if (!latestTwig) return;
        const nextTwig = recomputeTwigForMovedDisk(latestTwig, diskKey, point, surfaceNormal);
        liveDragTwigRef.current = nextTwig;

        // Find attached knots / leaves and emit a preview so SupportRenderer
        // can show them following the twig's new geometry in real time.
        const segmentIdSet = new Set<string>(nextTwig.segments.map(s => s.id));
        const attachedKnots = Object.values(snap.knots).filter(k => segmentIdSet.has(k.parentShaftId));
        const leavesByParentKnotId = new Map<string, typeof snap.leaves[string][]>();
        for (const leaf of Object.values(snap.leaves)) {
          const list = leavesByParentKnotId.get(leaf.parentKnotId);
          if (list) list.push(leaf);
          else leavesByParentKnotId.set(leaf.parentKnotId, [leaf]);
        }
        const { knotsById, leavesById } = computeTwigDragAttachmentUpdates(
          nextTwig,
          attachedKnots,
          leavesByParentKnotId,
        );
        emitTwigDragPreview({
          twigId: nextTwig.id,
          twig: nextTwig,
          knotsById,
          leavesById,
        });

        setDragTick((tick) => tick + 1);
      },
      onEnd: () => {
        if (liveDragTwigRef.current) {
          const nextTwig = liveDragTwigRef.current;
          updateTwig(nextTwig);

          // Persist attached knot/leaf updates so the on-screen preview
          // becomes the committed state.
          const snap = getSnapshot();
          const segmentIdSet = new Set<string>(nextTwig.segments.map(s => s.id));
          const attachedKnots = Object.values(snap.knots).filter(k => segmentIdSet.has(k.parentShaftId));
          const leavesByParentKnotId = new Map<string, typeof snap.leaves[string][]>();
          for (const leaf of Object.values(snap.leaves)) {
            const list = leavesByParentKnotId.get(leaf.parentKnotId);
            if (list) list.push(leaf);
            else leavesByParentKnotId.set(leaf.parentKnotId, [leaf]);
          }
          const { knotsById, leavesById } = computeTwigDragAttachmentUpdates(
            nextTwig,
            attachedKnots,
            leavesByParentKnotId,
          );
          for (const knot of Object.values(knotsById)) updateKnot(knot);
          for (const leaf of Object.values(leavesById)) updateLeaf(leaf);

          if (beforeHistoryRef.current) {
            pushSupportEditHistory('Move twig tip', beforeHistoryRef.current, captureSupportEditSnapshot());
          }
        }
        clearTwigDragPreview();
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
  // Invisible pick-only cylinders for tapered shafts when the twig is not
  // selected. Inside pickRef so clicks register as twig hits; not visible.
  const taperedPickShafts: Array<{
    id: string;
    start: THREE.Vector3;
    end: THREE.Vector3;
    radiusStart: number;
    radiusEnd: number;
  }> = [];
  // Invisible pick-only tube shells for bezier segments when the twig is
  // not selected. BezierRenderer's own pick mesh is gated on isParentSelected
  // / Alt held, so without these the bezier segments are unpickable in the
  // normal "click to select" / "hover to highlight" flow. Inside pickRef.
  const bezierPickShafts: Array<{
    id: string;
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    control1: { x: number; y: number; z: number };
    control2: { x: number; y: number; z: number };
    resolution: number;
    radiusStart: number;
    radiusEnd: number;
  }> = [];

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
    // Shaft tapers between the two contact disks. Joints bulge slightly at
    // each end (their own diameter, sized from the disks in twigBuilder).
    let diameterStart = effectiveTwig.contactDiskA.contactDiameterMm;
    let diameterEnd = effectiveTwig.contactDiskB.contactDiameterMm;

    if (seg.bottomJoint) {
      startPoint = new THREE.Vector3(seg.bottomJoint.pos.x, seg.bottomJoint.pos.y, seg.bottomJoint.pos.z);
    } else {
      const diskATipCenter = getDiskTipCenter(effectiveTwig.contactDiskA);
      startPoint = new THREE.Vector3(diskATipCenter.x, diskATipCenter.y, diskATipCenter.z);
    }

    if (seg.topJoint) {
      endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
    } else {
      const diskBTipCenter = getDiskTipCenter(effectiveTwig.contactDiskB);
      endPoint = new THREE.Vector3(diskBTipCenter.x, diskBTipCenter.y, diskBTipCenter.z);
    }

    const startPosVec = { x: startPoint.x, y: startPoint.y, z: startPoint.z };
    const endPosVec = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

    const isSegSelected = selectedId === seg.id;

    const canBatchShaft = !isSelected && !deferStraightShaftsToSceneBatch && seg.type !== 'bezier' && Math.abs(diameterStart - diameterEnd) < 1e-6;

    // Tapered + unselected: ShaftRenderer omits its pick mesh, so add an
    // invisible pick-only cylinder inside pickRef matching the visible rod.
    if (
      !canBatchShaft
      && !isSelected
      && seg.type !== 'bezier'
      && Math.abs(diameterStart - diameterEnd) >= 1e-6
    ) {
      taperedPickShafts.push({
        id: seg.id,
        start: startPoint.clone(),
        end: endPoint.clone(),
        radiusStart: diameterStart / 2,
        radiusEnd: diameterEnd / 2,
      });
    }

    // Bezier + unselected: BezierRenderer's pick mesh is gated on the parent
    // being selected (or Alt held during brace placement). Without an always-
    // on pick shell, an unselected bezier twig can't be hovered, selected,
    // or used as a brace placement target. Mirror the tapered straight path.
    if (seg.type === 'bezier' && !isSelected) {
      bezierPickShafts.push({
        id: seg.id,
        start: startPosVec,
        end: endPosVec,
        control1: seg.controlPoint1,
        control2: seg.controlPoint2,
        resolution: seg.resolution,
        radiusStart: diameterStart / 2,
        radiusEnd: diameterEnd / 2,
      });
    }

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
          diameter={Math.max(diameterStart, diameterEnd)}
          diameterStart={diameterStart}
          diameterEnd={diameterEnd}
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
        {taperedPickShafts.map((pick) => {
          const startVec = pick.start;
          const endVec = pick.end;
          const length = startVec.distanceTo(endVec);
          if (length < 0.001) return null;
          const midpoint = new THREE.Vector3()
            .addVectors(startVec, endVec)
            .multiplyScalar(0.5);
          const direction = new THREE.Vector3()
            .subVectors(endVec, startVec)
            .normalize();
          const up = new THREE.Vector3(0, 1, 0);
          const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
          return (
            <mesh
              key={`taper-pick-${pick.id}`}
              position={[midpoint.x, midpoint.y, midpoint.z]}
              quaternion={quaternion}
              userData={{ supportPrimitiveType: 'shaft', segmentId: pick.id }}
            >
              <cylinderGeometry args={[pick.radiusEnd, pick.radiusStart, length, 16]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          );
        })}
        {bezierPickShafts.map((pick) => (
          <BezierTwigPickShell key={`bezier-pick-${pick.id}`} pick={pick} />
        ))}
        {diskA}
        {diskB}
      </group>

      {isSelected && joints.map((joint) => {
        // Disk-end joints are visually part of their disk: clicks/drags
        // route to the disk, and the joint highlights with the disk.
        const firstSeg = effectiveTwig.segments[0];
        const lastSeg = effectiveTwig.segments[effectiveTwig.segments.length - 1];
        const isDiskAEndJoint = firstSeg?.bottomJoint?.id === joint.id;
        const isDiskBEndJoint = lastSeg?.topJoint?.id === joint.id;
        const attachedToDiskId = isDiskAEndJoint
          ? effectiveTwig.contactDiskA.id
          : isDiskBEndJoint
            ? effectiveTwig.contactDiskB.id
            : undefined;

        return (
          <JointRenderer
            key={`joint-${joint.id}`}
            joint={joint}
            color={visuals.color}
            emissive={visuals.emissive}
            emissiveIntensity={visuals.emissiveIntensity}
            selectedColor={visuals.selectedColor}
            isInteractable={isInteractable}
            isParentSelected={isSelected}
            attachedToDiskId={attachedToDiskId}
          />
        );
      })}
    </group>
  );
});

TwigRenderer.displayName = 'TwigRenderer';

// Invisible pick-only tube hugging a bezier twig segment. Lives inside the
// twig's pickRef so the GPU picker registers hits on it as twig hits (for
// hover, select) and shaft hits with segmentId in userData (for brace
// placement when Alt is held). BezierRenderer's own pick mesh is parent-
// selected-only, so without this an unselected bezier twig is unpickable.
function BezierTwigPickShell({ pick }: {
  pick: {
    id: string;
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    control1: { x: number; y: number; z: number };
    control2: { x: number; y: number; z: number };
    resolution: number;
    radiusStart: number;
    radiusEnd: number;
  };
}) {
  const geometry = React.useMemo(() => {
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(pick.start.x, pick.start.y, pick.start.z),
      new THREE.Vector3(pick.control1.x, pick.control1.y, pick.control1.z),
      new THREE.Vector3(pick.control2.x, pick.control2.y, pick.control2.z),
      new THREE.Vector3(pick.end.x, pick.end.y, pick.end.z),
    );
    const tubularSegments = Math.max(8, Math.min(48, pick.resolution ?? 16));
    const radialSegments = 10;
    // Match BraceRenderer / BezierRenderer's pick generosity so glancing
    // clicks on a thin curved twig still hit.
    const PICK_RADIUS_MULTIPLIER = 1.9;
    const MIN_PICK_RADIUS_MM = 0.45;
    const maxR = Math.max(pick.radiusStart, pick.radiusEnd);
    const pickRadius = Math.max(maxR * PICK_RADIUS_MULTIPLIER, MIN_PICK_RADIUS_MM);
    const g = new THREE.TubeGeometry(curve, tubularSegments, 1, radialSegments, false);

    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const ringSize = radialSegments + 1;
    const ringCount = tubularSegments + 1;
    for (let i = 0; i < ringCount; i++) {
      const u = i / tubularSegments;
      const center = curve.getPointAt(u);
      const localR = THREE.MathUtils.lerp(pick.radiusStart, pick.radiusEnd, u);
      const r = Math.max(localR * PICK_RADIUS_MULTIPLIER, pickRadius);
      for (let j = 0; j < ringSize; j++) {
        const idx = i * ringSize + j;
        const x = pos.getX(idx);
        const y = pos.getY(idx);
        const z = pos.getZ(idx);
        const v = new THREE.Vector3(x, y, z);
        const dir = v.sub(center);
        const len = dir.length();
        if (len > 0) dir.multiplyScalar(1 / len);
        const nv = center.clone().add(dir.multiplyScalar(r));
        pos.setXYZ(idx, nv.x, nv.y, nv.z);
      }
    }
    pos.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }, [
    pick.start.x, pick.start.y, pick.start.z,
    pick.end.x, pick.end.y, pick.end.z,
    pick.control1.x, pick.control1.y, pick.control1.z,
    pick.control2.x, pick.control2.y, pick.control2.z,
    pick.radiusStart, pick.radiusEnd, pick.resolution,
  ]);

  React.useEffect(() => {
    return () => { geometry.dispose(); };
  }, [geometry]);

  // Dispatch the same shaft-hover / shaft-click / shaft-leave window events
  // BezierRenderer fires from its own pick mesh, so brace + leaf placement
  // (which listen for these events to capture {segmentId, point}) still get
  // the data they need when the raycast lands on this shell instead of on
  // BezierRenderer's own pick mesh.
  const dispatchShaftEvent = (eventName: 'shaft-hover' | 'shaft-click' | 'shaft-leave', e: any) => {
    const detail: Record<string, unknown> = { segmentId: pick.id };
    if (eventName !== 'shaft-leave') {
      detail.point = e?.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null;
      detail.intersection = e;
    }
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  };

  return (
    <mesh
      userData={{ supportPrimitiveType: 'shaft', segmentId: pick.id }}
      onPointerMove={(e) => { dispatchShaftEvent('shaft-hover', e); }}
      onPointerOut={(e) => { dispatchShaftEvent('shaft-leave', e); }}
      onClick={(e) => { dispatchShaftEvent('shaft-click', e); }}
    >
      <primitive object={geometry} attach="geometry" />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
