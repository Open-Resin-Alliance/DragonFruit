import { useContactDiskDragSession } from '../useContactDiskDragSession';
import { updateSupportEntity } from '../../supportTypeRegistry';
import { renderShaftSegment } from '../renderShaftSegment';
import { useShaftSegments } from '../useShaftSegments';
import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Stick, type Vec3 } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, type ContactDiskDragHit } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { usePartDragUpdate } from '../../interaction/partDragPreview';
import { getSnapshot } from '../../state';

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
  // The entity names its own type; the store stamps it on every write.
  const typeId = baseStick.typeId ?? 'stick';
  const previewStick = usePartDragUpdate<Stick>(typeId, baseStick.id);
  const stick = previewStick ?? baseStick;
  
  const { camera, scene, gl } = useThree();
  const highDetailPrimitiveSegments = 24;
  const lowDetailPrimitiveSegments = 8;
  const useLowDetailPrimitives = !isSelected && !propHovered;


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

  const activeConeRef = React.useRef<{ key: 'contactConeA' | 'contactConeB'; anchor: Vec3 } | null>(null);

  const tipDrag = useContactDiskDragSession<{ key: 'contactConeA' | 'contactConeB'; cone: ContactCone }>(typeId, {
    onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
      const active = activeConeRef.current;
      const latestStick = active ? getSnapshot().sticks[stick.id] : null;
      const latestCone = latestStick?.[active!.key] as ContactCone | undefined;
      if (!active || !latestCone) return null;
      return {
        key: active.key,
        cone: recomputeContactConeForMovedDisk(latestCone, point, surfaceNormal, active.anchor, mesh),
      };
    },
    onCommit: ({ key, cone }) => {
      const latestStick = getSnapshot().sticks[stick.id];
      if (latestStick) updateSupportEntity('stick', { ...latestStick, [key]: cone });
    },
  });

  const startConeDrag = React.useCallback((coneKey: 'contactConeA' | 'contactConeB', initialEvent?: any) => {
    const cone = stick[coneKey];
    if (!cone) return;
    activeConeRef.current = { key: coneKey, anchor: getFinalSocketPosition(cone) };

    tipDrag.start({
      event: initialEvent, camera, domElement: gl.domElement, scene,
      modelId: stick.modelId,
      placementSurface: cone.placementSurface,
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
    tipDrag.stop();
  }, [tipDrag]);
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

  const shaftSegments = useShaftSegments(typeId, stick, {});

  shaftSegments.forEach((shaft) => {
    const seg = shaft.segment;

    const isSegSelected = selectedId === seg.id;

    const node = renderShaftSegment({
      shaft,
      visuals,
      isSelected: !!isSelected,
      isSegmentSelected: isSegSelected,
      isInteractable,
      deferStraightShaftsToSceneBatch,
      onSelect: selectPrimitiveById,
      batch: batchedStraightShafts,
    });
    if (node) shafts.push(node);
  });

  const effectiveConeA = (tipDrag.preview?.key === 'contactConeA' ? tipDrag.preview.cone : null) ?? stick.contactConeA;
  const effectiveConeB = (tipDrag.preview?.key === 'contactConeB' ? tipDrag.preview.cone : null) ?? stick.contactConeB;
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
