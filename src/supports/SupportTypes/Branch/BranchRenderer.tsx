import { useContactDiskDragSession } from '../useContactDiskDragSession';
import { updateSupportEntity } from '../../supportTypeRegistry';
import { renderShaftSegment } from '../renderShaftSegment';
import { useShaftSegments } from '../useShaftSegments';
import React from 'react';
import { useThree } from '@react-three/fiber';
import { Branch, Knot } from '../../types';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { ContactConeRenderer } from '../../SupportPrimitives/ContactCone';
import { isPrimaryPointerPress, type ContactDiskDragHit } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { usePartDragUpdate } from '../../interaction/partDragPreview';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { getSnapshot } from '../../state';
import { getSettings } from '../../Settings/state';
import { decodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';
import { buildBranchData, remapBranchGeometryIds } from './branchBuilder';

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
  branch: baseBranch,
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
  const highDetailPrimitiveSegments = 24;
  const lowDetailPrimitiveSegments = 8;
  const useLowDetailPrimitives = !isSelected && !propHovered;
  // The entity names its own type; the store stamps it on every write.
  const typeId = baseBranch.typeId ?? 'branch';
  const previewBranch = usePartDragUpdate<Branch>(typeId, baseBranch.id);
  const branch = previewBranch ?? baseBranch;


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

  const tipDrag = useContactDiskDragSession<Branch>(typeId, {
    onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
      const latest = getSnapshot().branches[branch.id];
      if (!latest?.contactCone) return null;
      // Size the rebuild from the branch's own settings and its existing
      // geometry: moving a tip must not resize the support.
      const ownSettings = (latest.settingsCodeHex
        ? decodeSupportSettingsHex(latest.settingsCodeHex, getSettings())
        : null) ?? getSettings();
      const rebuilt = remapBranchGeometryIds(buildBranchData({
        tipPos: point,
        tipNormal: surfaceNormal,
        modelId: branch.modelId,
        parentKnot,
        mesh,
        settings: ownSettings,
        shaftDiameterMm: latest.segments[0]?.diameter,
        tipProfile: { ...latest.contactCone.profile, lengthMm: ownSettings.tip.lengthMm },
      }).branch, latest);

      return {
        ...rebuilt,
        contactCone: rebuilt.contactCone
          ? { ...rebuilt.contactCone, placementSurface: latest.contactCone.placementSurface }
          : rebuilt.contactCone,
        id: latest.id,
        parentKnotId: latest.parentKnotId,
        settingsCodeHex: latest.settingsCodeHex,
        modelId: latest.modelId,
      };
    },
    onCommit: (next) => updateSupportEntity('branch', next),
  });

  const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
    if (!isSelected || !branch.contactCone) return;
    if (!isPrimaryPointerPress(e)) return;
    tipDrag.start({
      event: e, camera, domElement: gl.domElement, scene,
      modelId: branch.modelId,
      placementSurface: branch.contactCone?.placementSurface,
    });
  }, [branch.contactCone, branch.modelId, camera, gl.domElement, isSelected, scene, tipDrag]);

  const handleContactDiskHudPointerUp = React.useCallback(() => {
    tipDrag.stop();
  }, [tipDrag]);

  const shafts: React.ReactNode[] = [];
  const batchedStraightShafts: InstancedShaft[] = [];
  const joints: React.ReactNode[] = [];

  const effectiveBranch = tipDrag.preview ?? previewBranch ?? branch;
  const shaftSegments = useShaftSegments(typeId, effectiveBranch, { hostKnot: parentKnot });

  shaftSegments.forEach((shaft) => {
    const seg = shaft.segment;

    const isSegSelected = selectedId === seg.id;

    // Add Shaft (straight or bezier)
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
  const effectiveCone = effectiveBranch.contactCone;
  let coneRender = null;
  if (effectiveCone && !deferContactConesToSceneBatch) {
    const isConeSelected = !!effectiveCone.id && selectedId === effectiveCone.id;
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
