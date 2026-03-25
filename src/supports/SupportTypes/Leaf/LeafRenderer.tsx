import React, { useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { getSnapshot, subscribe, updateLeaf } from '../../state';
import { Leaf, Knot } from '../../types';
import { ContactConeRenderer, getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { isPrimaryPointerPress, startContactDiskDragSession, type ContactDiskDragHit, type ContactDiskDragSession } from '../../SupportPrimitives/ContactDisk/contactDiskDragController';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { useHighlight } from '../../interaction/useHighlight';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { branchPlacementStore } from '../Branch/branchPlacementState';

interface LeafRendererProps {
    leaf: Leaf;
    parentKnot: Knot;
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
    const supportState = useSyncExternalStore(subscribe, getSnapshot);
    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;
    const dragSessionRef = React.useRef<ContactDiskDragSession | null>(null);
    const liveDragConeRef = React.useRef<import('../../SupportPrimitives/ContactCone/types').ContactCone | null>(null);
    const [, setDragTick] = React.useState(0);

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

    const handleContactDiskHudPointerDown = React.useCallback((e: LeafRendererPointerEvent) => {
        if (!isSelected || !leaf.contactCone) return;
        if (!isPrimaryPointerPress(e)) return;

        const socketAnchor = getFinalSocketPosition(leaf.contactCone);

        dragSessionRef.current?.stop();
        dragSessionRef.current = startContactDiskDragSession({
            camera,
            domElement: gl.domElement,
            scene,
            initialEvent: e,
            modelId: leaf.modelId,
            onHit: ({ point, surfaceNormal }: ContactDiskDragHit) => {
                const latest = getSnapshot().leaves[leaf.id];
                if (!latest?.contactCone) return;
                liveDragConeRef.current = recomputeContactConeForMovedDisk(latest.contactCone, point, surfaceNormal, socketAnchor);
                setDragTick(t => t + 1);
            },
            onEnd: () => {
                if (liveDragConeRef.current) {
                    const latest = getSnapshot().leaves[leaf.id];
                    if (latest) updateLeaf({ ...latest, contactCone: liveDragConeRef.current });
                }
                liveDragConeRef.current = null;
                dragSessionRef.current = null;
            },
        });
    }, [camera, gl.domElement, isSelected, leaf.id, leaf.contactCone, leaf.modelId, scene]);

    const handleContactDiskHudPointerUp = React.useCallback(() => {
        dragSessionRef.current?.stop();
        dragSessionRef.current = null;
    }, []);
    return (
        <group onClick={handleClick}>
            <group ref={pickRef}>
                {(() => {
                    const effectiveCone = liveDragConeRef.current ?? leaf.contactCone;
                    if (!effectiveCone || deferContactConesToSceneBatch) return null;
                    const isConeSelected = !!effectiveCone.id && supportState.selectedId === effectiveCone.id;
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
