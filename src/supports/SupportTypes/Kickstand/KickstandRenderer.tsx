import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Knot, Roots } from '../../types';
import { selectPrimitiveById } from '../../interaction/shared/selection/selectionController';
import { useHighlight } from '../../interaction/useHighlight';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { InstancedShaftGroup, type InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import type { Kickstand } from './types';

interface KickstandRendererProps {
    kickstand: Kickstand;
    root: Roots;
    hostKnot: Knot;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    showKnot?: boolean;
    suppressHover?: boolean;
    isHovered?: boolean;
    isInteractable?: boolean;
    deferStraightShaftsToSceneBatch?: boolean;
    deferInteractionToSceneBatch?: boolean;
    hidePlateContactPrimitives?: boolean;
    baseColor?: string;
    hoverColor?: string;
    selectedColor?: string;
}

export const KickstandRenderer = React.memo(function KickstandRenderer({
    kickstand,
    root,
    hostKnot,
    isSelected,
    selectedId,
    dimNonSelected,
    showKnot = true,
    suppressHover,
    isHovered: propHovered,
    isInteractable = true,
    deferStraightShaftsToSceneBatch = false,
    deferInteractionToSceneBatch = false,
    hidePlateContactPrimitives = false,
    baseColor = '#ff8800',
    hoverColor,
    selectedColor = '#80fffd',
}: KickstandRendererProps) {
    const highDetailPrimitiveSegments = 24;
    const lowDetailPrimitiveSegments = 8;
    const useLowDetailPrimitives = !isSelected && !propHovered;

    const { pickRef, visuals } = useHighlight({
        id: kickstand.id,
        category: 'support',
        enabled: !!isInteractable && !suppressHover && !deferInteractionToSceneBatch && !isSelected,
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : baseColor,
        selectedColor,
        hoverColor,
    });

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        handleSupportClick(e, kickstand.id, !!isInteractable);
    };

    const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
    const startZ = root.diskHeight + root.coneHeight;

    let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, startZ));

    const shafts: React.ReactNode[] = [];
    const batchedStraightShafts: InstancedShaft[] = [];
    const joints: React.ReactNode[] = [];

    kickstand.segments.forEach((segment, index) => {
        const isLast = index === kickstand.segments.length - 1;

        const endPoint = segment.topJoint
            ? new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z)
            : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);

        const start = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
        const end = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

        const segmentSelected = selectedId === segment.id;

        const diameterStart = isLast ? kickstand.profile.terminalStartDiameterMm : undefined;
        const diameterEnd = isLast ? kickstand.profile.terminalEndDiameterMm : undefined;
        const isUniformDiameter = (diameterStart == null && diameterEnd == null)
            || (diameterStart != null && diameterEnd != null && Math.abs(diameterStart - diameterEnd) < 1e-6);
        const canBatchShaft = !isSelected && !deferStraightShaftsToSceneBatch && segment.type !== 'bezier' && isUniformDiameter;

        if (canBatchShaft) {
            batchedStraightShafts.push({
                id: segment.id,
                start,
                end,
                diameter: segment.diameter,
            });
        } else if (segment.type === 'bezier') {
            const bezierColor = isSelected ? '#ff00ff' : visuals.color;
            shafts.push(
                <BezierRenderer
                    key={`shaft-${segment.id}`}
                    id={segment.id}
                    start={start}
                    end={end}
                    control1={segment.controlPoint1}
                    control2={segment.controlPoint2}
                    diameter={segment.diameter}
                    diameterStart={diameterStart}
                    diameterEnd={diameterEnd}
                    resolution={segment.resolution}
                    color={bezierColor}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isParentSelected={isSelected}
                    isSelected={segmentSelected}
                    onClick={() => selectPrimitiveById(segment.id)}
                />,
            );
        } else if (!deferStraightShaftsToSceneBatch || isSelected) {
            shafts.push(
                <ShaftRenderer
                    key={`shaft-${segment.id}`}
                    id={segment.id}
                    start={start}
                    end={end}
                    diameter={segment.diameter}
                    diameterStart={diameterStart}
                    diameterEnd={diameterEnd}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isParentSelected={isSelected}
                    isSelected={segmentSelected}
                    onClick={() => selectPrimitiveById(segment.id)}
                />,
            );
        }

        if (isSelected && segment.topJoint) {
            joints.push(
                <JointRenderer
                    key={`joint-${segment.topJoint.id}`}
                    joint={segment.topJoint}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />,
            );
        }

        currentStart = endPoint;
    });

    const shaftDiameter = kickstand.segments[0]?.diameter ?? kickstand.profile.bodyDiameterMm;

    return (
        <group
            onClick={handleClick}
        >
            {!hidePlateContactPrimitives && (
                <RootsRenderer
                    root={root}
                    shaftDiameter={shaftDiameter}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    radialSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                    sphereSegments={useLowDetailPrimitives ? lowDetailPrimitiveSegments : highDetailPrimitiveSegments}
                />
            )}

            <group ref={pickRef as React.RefObject<THREE.Group | null>}>
                <InstancedShaftGroup
                    shafts={batchedStraightShafts}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                />
                {shafts}
            </group>

            {showKnot && isSelected && (
                <KnotRenderer
                    knot={hostKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    selectedColor={visuals.selectedColor}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />
            )}

            {joints}
        </group>
    );
});

KickstandRenderer.displayName = 'KickstandRenderer';
