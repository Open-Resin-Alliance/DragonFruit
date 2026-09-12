import { useContactDiskDragSession } from '../useContactDiskDragSession';
import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import type { Anchor, Roots, Vec3 } from '../../types';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, type ContactDiskDragHit } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { getSnapshot, updateAnchor } from '../../state';

interface AnchorRendererProps {
    anchor: Anchor;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    isHovered?: boolean;
    suppressHover?: boolean;
    isInteractable?: boolean;
    baseColor?: string;
    deferContactConesToSceneBatch?: boolean;
    onContactDiskHudHoverChange?: (hovered: boolean) => void;
}

export const AnchorRenderer = React.memo(function AnchorRenderer({
    anchor,
    isSelected,
    selectedId,
    dimNonSelected,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
    baseColor = '#ff8800',
    deferContactConesToSceneBatch = false,
    onContactDiskHudHoverChange,
}: AnchorRendererProps) {
    const { camera, scene, gl } = useThree();


    const { pickRef, visuals, isPickingHovered } = useHighlight({
        id: anchor.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    });

    // Build a synthetic Roots entity so RootsRenderer handles raft offset, sphere top, etc.
    const syntheticRoot: Roots = useMemo(() => ({
        id: `${anchor.id}:root`,
        modelId: anchor.modelId,
        transform: { pos: anchor.rootPos, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: anchor.rootBaseDiameter,
        diskHeight: 0.1,
        coneHeight: anchor.rootHeight,
    }), [anchor.id, anchor.modelId, anchor.rootPos, anchor.rootBaseDiameter, anchor.rootHeight]);

    const handleClick = (e: any) => {
        handleSupportClick(e, anchor.id, !!isInteractable);
    };

    const socketAnchorRef = React.useRef<Vec3 | undefined>(undefined);
    const typeId = anchor.typeId ?? 'anchor';

    const tipDrag = useContactDiskDragSession<ContactCone>(typeId, {
        onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
            const latest = getSnapshot().anchors[anchor.id];
            if (!latest?.contactCone) return null;
            return recomputeContactConeForMovedDisk(
                latest.contactCone, point, surfaceNormal, socketAnchorRef.current, mesh,
            );
        },
        onCommit: (cone) => {
            const latest = getSnapshot().anchors[anchor.id];
            if (latest) updateAnchor({ ...latest, contactCone: cone });
        },
    });

    const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
        if (!isSelected || !anchor.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        socketAnchorRef.current = getFinalSocketPosition(anchor.contactCone);
        tipDrag.start({
            event: e, camera, domElement: gl.domElement, scene,
            modelId: anchor.modelId,
            placementSurface: anchor.contactCone?.placementSurface,
        });
    }, [anchor.contactCone, anchor.modelId, camera, gl.domElement, isSelected, scene, tipDrag]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        tipDrag.stop();
    }, [tipDrag]);

    // Render contact cone
    const effectiveCone = tipDrag.preview ?? anchor.contactCone;
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
        <group onClick={handleClick} ref={pickRef as any}>
            <RootsRenderer
                root={syntheticRoot}
                shaftDiameter={anchor.rootTopDiameter}
                color={visuals.color}
                emissive={visuals.emissive}
                emissiveIntensity={visuals.emissiveIntensity}
            />
            {coneRender}
        </group>
    );
});

AnchorRenderer.displayName = 'AnchorRenderer';
