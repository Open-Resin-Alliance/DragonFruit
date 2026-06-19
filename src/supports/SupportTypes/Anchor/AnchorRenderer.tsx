import React, { useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import type { Anchor, Roots } from '../../types';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { useHighlight } from '../../interaction/useHighlight';
import { getSnapshot, updateAnchor } from '../../state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '../../history/supportEditHistory';

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
    const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);
    const liveDragConeRef = React.useRef<ContactCone | null>(null);
    const beforeHistoryRef = React.useRef<ReturnType<typeof captureSupportEditSnapshot> | null>(null);
    const [, setDragTick] = React.useState(0);

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

    const handleContactDiskHudPointerDown = React.useCallback((e: any) => {
        if (!isSelected || !anchor.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        const socketAnchor = getFinalSocketPosition(anchor.contactCone);
        beforeHistoryRef.current = captureSupportEditSnapshot();

        dragSessionRef.current?.stop();
        dragSessionRef.current = startContactDiskDragSession({
            camera,
            domElement: gl.domElement,
            scene,
            initialEvent: e,
            modelId: anchor.modelId,
            placementSurface: anchor.contactCone?.placementSurface,
            onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
                const latest = getSnapshot().anchors[anchor.id];
                if (!latest?.contactCone) return;
                liveDragConeRef.current = recomputeContactConeForMovedDisk(latest.contactCone, point, surfaceNormal, socketAnchor, mesh);
                setDragTick(t => t + 1);
            },
            onEnd: () => {
                if (liveDragConeRef.current) {
                    const latest = getSnapshot().anchors[anchor.id];
                    if (latest) updateAnchor({ ...latest, contactCone: liveDragConeRef.current });
                    if (beforeHistoryRef.current) {
                        pushSupportEditHistory('Move anchor tip', beforeHistoryRef.current, captureSupportEditSnapshot());
                    }
                }
                liveDragConeRef.current = null;
                dragSessionRef.current = null;
                beforeHistoryRef.current = null;
            },
        });
    }, [camera, gl.domElement, isSelected, scene, anchor.id, anchor.contactCone, anchor.modelId]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        dragSessionRef.current?.stop();
        dragSessionRef.current = null;
    }, []);

    // Render contact cone
    const effectiveCone = liveDragConeRef.current ?? anchor.contactCone;
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
