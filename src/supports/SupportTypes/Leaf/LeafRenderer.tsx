import React from 'react';
import { useThree } from '@react-three/fiber';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { getSnapshot } from '../../state';
import { updateSupportEntity } from '../../supportTypeRegistry';
import { Leaf, Knot, Vec3 } from '../../types';
import { detailSkippedInSimpleView, registerSupportDetailRenderer } from '../../detailRenderer/seam';
import { ContactConeRenderer, getFinalSocketPosition, type ContactCone } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, type ContactDiskDragHit } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { branchPlacementStore } from '../Branch/branchPlacementState';
import { useContactDiskDragSession } from '../useContactDiskDragSession';

interface LeafRendererProps {
    leaf: Leaf;
    parentKnot: Knot;
    selectedId?: string | null;
    isSelected?: boolean;
    dimNonSelected?: boolean;
    showKnots?: boolean;
    isHovered?: boolean;
    suppressHover?: boolean;
    isInteractable?: boolean;
    deferContactConesToSceneBatch?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
    onContactDiskHudHoverChange?: (hovered: boolean) => void;
}

interface LeafRendererPointerEvent {
    altKey?: boolean;
    button?: number;
    clientX?: number;
    clientY?: number;
    point?: { x: number; y: number; z: number };
    sourceEvent?: {
        button?: number;
        clientX?: number;
        clientY?: number;
    };
    nativeEvent?: {
        altKey?: boolean;
        button?: number;
        clientX?: number;
        clientY?: number;
        stopPropagation?: () => void;
        stopImmediatePropagation?: () => void;
    };
    stopPropagation: () => void;
}

export const LeafRenderer = React.memo(function LeafRenderer({
    leaf,
    parentKnot,
    selectedId,
    isSelected,
    dimNonSelected,
    showKnots,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
    deferContactConesToSceneBatch = false,
    baseColor = '#ff8800',
    hoverColor,
    selectedColor = '#80fffd',
    onContactDiskHudHoverChange,
}: LeafRendererProps) {
    const { camera, scene, gl } = useThree();
    const { getHotkey } = useHotkeyConfig();
    const branchFamilyBinding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');
    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;
    // The entity names its own type; the store stamps it on every write.
    const typeId = leaf.typeId ?? 'leaf';
    // The socket the cone pivots around is fixed at pointer-down, so a drag
    // across a re-hit surface cannot re-socket the leaf mid-flight.
    const dragSocketAnchorRef = React.useRef<Vec3 | undefined>(undefined);

    const { pickRef, visuals } = useHighlight({
        id: leaf.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
        selectedColor,
        hoverColor,
    });

    const handleClick = (e: LeafRendererPointerEvent) => {
        const branchFamilyHeld = branchPlacementStore.getSnapshot().altActive
            || isSupportPlacementBindingSatisfiedByModifierState(branchFamilyBinding, getSupportPlacementModifierState(e));
        if (branchFamilyHeld) {
            // Brace tool: dispatch brace-leaf-click so a brace endpoint can attach
            // to this leaf's cone. (For an unselected leaf the cone is in the batched
            // scene mesh and SupportRenderer dispatches this; a selected leaf renders
            // its own cone here, so dispatch from this handler too.)
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation?.();
                e.nativeEvent.stopImmediatePropagation?.();
            }

            window.dispatchEvent(new CustomEvent('brace-leaf-click', {
                detail: {
                    leafId: leaf.id,
                    point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                    intersection: e,
                },
            }));
            return;
        }

        handleSupportClick(e, leaf.id, !!isInteractable);
    };

    const tipDrag = useContactDiskDragSession<ContactCone>(typeId, {
        onHit: ({ point, surfaceNormal, mesh }: ContactDiskDragHit) => {
            const latest = getSnapshot().leaves[leaf.id];
            const socketAnchor = dragSocketAnchorRef.current;
            if (!latest?.contactCone || !socketAnchor) return null;
            return recomputeContactConeForMovedDisk(latest.contactCone, point, surfaceNormal, socketAnchor, mesh);
        },
        onCommit: (nextCone) => {
            const latest = getSnapshot().leaves[leaf.id];
            // The one-argument form reads the type off the entity, so this does not
            // name the type to write it.
            if (latest) updateSupportEntity({ ...latest, contactCone: nextCone });
        },
    });

    const handleContactDiskHudPointerDown = React.useCallback((e: LeafRendererPointerEvent) => {
        if (!isSelected || !leaf.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        dragSocketAnchorRef.current = getFinalSocketPosition(leaf.contactCone);

        tipDrag.start({
            event: e, camera, domElement: gl.domElement, scene,
            modelId: leaf.modelId,
            placementSurface: leaf.contactCone.placementSurface,
        });
    }, [camera, gl.domElement, isSelected, leaf.contactCone, leaf.modelId, scene, tipDrag]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        tipDrag.stop();
    }, [tipDrag]);
    return (
        <group onClick={handleClick}>
            <group ref={pickRef}>
                {(() => {
                    const effectiveCone = tipDrag.preview ?? leaf.contactCone;
                    if (!effectiveCone || deferContactConesToSceneBatch) return null;
                    const isConeSelected = !!effectiveCone.id && selectedId === effectiveCone.id;
                    return (
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
                            isInteractable={isInteractable}
                            isParentSelected={!!isSelected}
                            isContactDiskSelected={isConeSelected}
                            onDiskHudHoverChange={onContactDiskHudHoverChange}
                            onDiskHudPointerDown={handleContactDiskHudPointerDown}
                            onDiskHudPointerUp={handleContactDiskHudPointerUp}
                        />
                    );
                })()}
            </group>

            {showKnots !== false && (
                <KnotRenderer
                    knot={parentKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={!!isSelected}
                />
            )}
        </group>
    );
});

LeafRenderer.displayName = 'LeafRenderer';

registerSupportDetailRenderer('leaf', (ctx) => ({
    component: LeafRenderer as never,
    hosts: (leaf: Leaf) => {
        const parentKnot = ctx.renderKnotsById[leaf.parentKnotId];
        return parentKnot ? { parentKnot } : null;
    },
    skip: ({ isSelected }) => !isSelected,
    noClipping: () => true,
    extraProps: ({ entity, isSelected }) => ({
        showKnots: !detailSkippedInSimpleView(ctx, isSelected),
        deferContactConesToSceneBatch: !isSelected && !!(entity as Leaf).contactCone,
    }),
}));
