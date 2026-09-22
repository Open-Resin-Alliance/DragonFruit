import { useContactDiskDragSession } from '../useContactDiskDragSession';
import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import type { Stump, Roots, Vec3 } from '../../types';
import { registerSupportDetailRenderer } from '../../detailRenderer/seam';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, type ContactDiskDragHit } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { getSnapshot } from '../../state';
import { inlineRootId, updateSupportEntity } from '../../supportTypeRegistry';

interface StumpRendererProps {
    stump: Stump;
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

export const StumpRenderer = React.memo(function StumpRenderer({
    stump,
    isSelected,
    selectedId,
    dimNonSelected,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
    baseColor = '#ff8800',
    deferContactConesToSceneBatch = false,
    onContactDiskHudHoverChange,
}: StumpRendererProps) {
    const { camera, scene, gl } = useThree();


    const { pickRef, visuals, isPickingHovered } = useHighlight({
        id: stump.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
    });

    // Build a synthetic Roots entity so RootsRenderer handles raft offset, sphere top, etc.
    const syntheticRoot: Roots = useMemo(() => ({
        id: inlineRootId(stump.id),
        modelId: stump.modelId,
        transform: { pos: stump.rootPos, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: stump.rootBaseDiameter,
        diskHeight: 0.1,
        coneHeight: stump.rootHeight,
    }), [stump.id, stump.modelId, stump.rootPos, stump.rootBaseDiameter, stump.rootHeight]);

    const handleClick = (e: any) => {
        handleSupportClick(e, stump.id, !!isInteractable);
    };

    const socketAnchorRef = React.useRef<Vec3 | undefined>(undefined);
    const typeId = stump.typeId ?? 'stump';

    const tipDrag = useContactDiskDragSession<ContactCone>(typeId, {
        onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
            const latest = getSnapshot().stumps[stump.id];
            if (!latest?.contactCone) return null;
            return recomputeContactConeForMovedDisk(
                latest.contactCone, point, surfaceNormal, socketAnchorRef.current, mesh,
            );
        },
        onCommit: (cone) => {
            const latest = getSnapshot().stumps[stump.id];
            // The one-argument form reads the type off the entity, so this
            // does not name the type to write it.
            if (latest) updateSupportEntity({ ...latest, contactCone: cone });
        },
    });

    const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
        if (!isSelected || !stump.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        socketAnchorRef.current = getFinalSocketPosition(stump.contactCone);
        tipDrag.start({
            event: e, camera, domElement: gl.domElement, scene,
            modelId: stump.modelId,
            placementSurface: stump.contactCone?.placementSurface,
        });
    }, [stump.contactCone, stump.modelId, camera, gl.domElement, isSelected, scene, tipDrag]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        tipDrag.stop();
    }, [tipDrag]);

    // Render contact cone
    const effectiveCone = tipDrag.preview ?? stump.contactCone;
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
                shaftDiameter={stump.rootTopDiameter}
                color={visuals.color}
                emissive={visuals.emissive}
                emissiveIntensity={visuals.emissiveIntensity}
            />
            {coneRender}
        </group>
    );
});

StumpRenderer.displayName = 'StumpRenderer';

registerSupportDetailRenderer('stump', () => ({
    component: StumpRenderer as never,
}));
