import React, { useMemo } from 'react';
import * as THREE from 'three';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import type { Brace, Knot } from '../../types';
import { useHighlight } from '../../interaction/useHighlight';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { getSupportPlacementModifierState, isSupportPlacementBindingSatisfiedByModifierState } from '../../interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { branchPlacementStore } from '../Branch/branchPlacementState';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';

const DEBUG_SECTION_COLORS: Record<string, string> = {
    initial: '#00ff00',
    repeating: '#00e5ff',
};

interface BraceRendererProps {
    brace: Brace;
    startKnot: Knot;
    endKnot: Knot;
    isSelected?: boolean;
    ghosted?: boolean;
    ghostOpacity?: number;
    dimNonSelected?: boolean;
    showKnots?: boolean;
    isHovered?: boolean;
    suppressHover?: boolean;
    isInteractable?: boolean;
    deferStraightShaftToSceneBatch?: boolean;
    deferInteractionToSceneBatch?: boolean;
    debugSectionColors?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
}

interface BraceRendererClickEvent {
    point?: { x: number; y: number; z: number };
    nativeEvent?: {
        stopPropagation?: () => void;
        stopImmediatePropagation?: () => void;
    };
    stopPropagation: () => void;
}

export const BraceRenderer = React.memo(function BraceRenderer({
    brace,
    startKnot,
    endKnot,
    isSelected,
    ghosted = false,
    ghostOpacity = 1,
    dimNonSelected,
    showKnots,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
    deferStraightShaftToSceneBatch = false,
    deferInteractionToSceneBatch = false,
    debugSectionColors = false,
    baseColor = '#ff8800',
    hoverColor = '#66e0ff',
    selectedColor = '#66e0ff',
}: BraceRendererProps) {
    const { getHotkey } = useHotkeyConfig();
    const branchFamilyBinding = getHotkey('SUPPORTS', 'BRANCH_PLACEMENT');
    const segmentId = `braceSegment:${brace.id}`;
    const effectiveInteractable = isInteractable && !ghosted;
    const shaftOpacity = ghosted ? Math.max(0.18, Math.min(ghostOpacity, 0.35)) : 1;
    const shaftTransparent = ghosted ? shaftOpacity < 0.999 : false;
    const debugColor = debugSectionColors && brace.debugSection
        ? DEBUG_SECTION_COLORS[brace.debugSection] ?? baseColor
        : null;

    const { pickRef, visuals } = useHighlight({
        id: brace.id,
        category: 'support',
        enabled: !!effectiveInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: debugColor ?? (dimNonSelected && !isSelected ? '#666666' : baseColor),
        selectedColor,
        hoverColor,
    });

    const shaftColor = visuals.color;

    const startVec = useMemo(() => new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z), [startKnot.pos.x, startKnot.pos.y, startKnot.pos.z]);
    const endVec = useMemo(() => new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z), [endKnot.pos.x, endKnot.pos.y, endKnot.pos.z]);

    const uniformBraceDiameter = Math.max(0.001, brace.profile?.diameter ?? 1.0);
    const startHostDiameter = Math.max(
        0.001,
        (startKnot.diameter ?? (uniformBraceDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
    );
    const endHostDiameter = Math.max(
        0.001,
        (endKnot.diameter ?? (uniformBraceDiameter + JOINT_DIAMETER_OFFSET_MM)) - JOINT_DIAMETER_OFFSET_MM,
    );
    const bezierCurve = brace.curve?.type === 'bezier' ? brace.curve : null;
    const isBezierBrace = !!bezierCurve;
    const isTaperedBrace = Math.abs(startHostDiameter - endHostDiameter) > 1e-4;

    const batchedStraightShafts: InstancedShaft[] = useMemo(() => {
        if (isSelected || isBezierBrace || deferStraightShaftToSceneBatch || isTaperedBrace) return [];
        return [{
            id: segmentId,
            start: startKnot.pos,
            end: endKnot.pos,
            diameter: uniformBraceDiameter,
        }];
    }, [isSelected, isBezierBrace, deferStraightShaftToSceneBatch, isTaperedBrace, segmentId, startKnot.pos, endKnot.pos, uniformBraceDiameter]);

    const shouldRenderDetailedBezier = isBezierBrace && (isSelected || !deferStraightShaftToSceneBatch);
    const shouldRenderDetailedStraight = !isBezierBrace && (isSelected || (!deferStraightShaftToSceneBatch && batchedStraightShafts.length === 0));

    const handleClick = (e: BraceRendererClickEvent) => {
        if (!effectiveInteractable) return;

        const branchFamilyHeld = branchPlacementStore.getSnapshot().altActive
            || isSupportPlacementBindingSatisfiedByModifierState(branchFamilyBinding, getSupportPlacementModifierState(e));
        if (branchFamilyHeld) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation?.();
                e.nativeEvent.stopImmediatePropagation?.();
            }

            window.dispatchEvent(new CustomEvent('shaft-click', {
                detail: {
                    segmentId,
                    point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
                    intersection: e,
                },
            }));
            return;
        }

        // If brace is already selected (or an endpoint is selected), clicking the shaft selects the segment.
        if (isSelected) {
            if (!isInteractable) return;
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation?.();
                e.nativeEvent.stopImmediatePropagation?.();
            }
            selectPrimitiveById(segmentId);
            return;
        }

        handleSupportClick(e, brace.id, !!isInteractable);
    };

    const straight = useMemo(() => {
        const dir = endVec.clone().sub(startVec);
        const len = dir.length();
        return { length: len };
    }, [startVec, endVec]);

    if (straight.length < 0.001) return null;

    return (
        <group
            onClick={handleClick}
        >
            <group ref={pickRef}>
                <group>
                    <InstancedShaftGroup
                        shafts={batchedStraightShafts}
                        color={shaftColor}
                        emissive={visuals.emissive}
                        emissiveIntensity={visuals.emissiveIntensity}
                        transparent={shaftTransparent}
                        opacity={shaftOpacity}
                    />
                    {shouldRenderDetailedBezier ? (
                        <BezierRenderer
                            id={segmentId}
                            start={startKnot.pos}
                            end={endKnot.pos}
                            control1={bezierCurve!.controlPoint1}
                            control2={bezierCurve!.controlPoint2}
                            diameter={Math.max(startHostDiameter, endHostDiameter)}
                            diameterStart={startHostDiameter}
                            diameterEnd={endHostDiameter}
                            resolution={bezierCurve!.resolution}
                            color={isSelected ? '#ff00ff' : shaftColor}
                            emissive={visuals.emissive}
                            emissiveIntensity={visuals.emissiveIntensity}
                            selectedColor={visuals.selectedColor}
                            isParentSelected={!!isSelected}
                            isInteractable={effectiveInteractable}
                            suppressPlacementInteraction={ghosted}
                            isSelected={false}
                            transparent={shaftTransparent}
                            opacity={shaftOpacity}
                            onClick={() => selectPrimitiveById(segmentId)}
                        />
                    ) : shouldRenderDetailedStraight ? (
                        <ShaftRenderer
                            id={segmentId}
                            start={startKnot.pos}
                            end={endKnot.pos}
                            diameter={Math.max(startHostDiameter, endHostDiameter)}
                            diameterStart={startHostDiameter}
                            diameterEnd={endHostDiameter}
                            color={shaftColor}
                            emissive={visuals.emissive}
                            emissiveIntensity={visuals.emissiveIntensity}
                            selectedColor={visuals.selectedColor}
                            isParentSelected={!!isSelected}
                            isInteractable={effectiveInteractable}
                            suppressPlacementInteraction={ghosted}
                            isSelected={false}
                            transparent={shaftTransparent}
                            opacity={shaftOpacity}
                            onClick={() => selectPrimitiveById(segmentId)}
                        />
                    ) : null}
                </group>
            </group>

            {showKnots !== false && isSelected && (
                <KnotRenderer
                    knot={startKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={effectiveInteractable}
                    isParentSelected={!!isSelected}
                    enablePicking={effectiveInteractable}
                    transparent={shaftTransparent}
                    opacity={shaftOpacity}
                />
            )}
            {showKnots !== false && isSelected && (
                <KnotRenderer
                    knot={endKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={effectiveInteractable}
                    isParentSelected={!!isSelected}
                    enablePicking={effectiveInteractable}
                    transparent={shaftTransparent}
                    opacity={shaftOpacity}
                />
            )}
        </group>
    );
});

BraceRenderer.displayName = 'BraceRenderer';
