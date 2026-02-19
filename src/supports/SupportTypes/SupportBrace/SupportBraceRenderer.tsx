import React from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Knot, Roots } from '../../types';
import { setSelectedId } from '../../state';
import { useHighlight } from '../../interaction/useHighlight';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { JointRenderer } from '../../SupportPrimitives/Joint/JointRenderer';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { RootsRenderer } from '../../SupportPrimitives/Roots/RootsRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import type { SupportBrace } from './types';

interface SupportBraceRendererProps {
    supportBrace: SupportBrace;
    root: Roots;
    hostKnot: Knot;
    isSelected?: boolean;
    selectedId?: string | null;
    dimNonSelected?: boolean;
    showKnot?: boolean;
    suppressHover?: boolean;
    isHovered?: boolean;
    isInteractable?: boolean;
    hidePlateContactPrimitives?: boolean;
}

export function SupportBraceRenderer({
    supportBrace,
    root,
    hostKnot,
    isSelected,
    selectedId,
    dimNonSelected,
    showKnot = true,
    suppressHover,
    isHovered: propHovered,
    isInteractable = true,
    hidePlateContactPrimitives = false,
}: SupportBraceRendererProps) {
    const { pickRef, visuals } = useHighlight({
        id: supportBrace.id,
        category: 'support',
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
        selectedColor: '#80fffd',
    });

    const handleClick = (e: ThreeEvent<MouseEvent>) => {
        handleSupportClick(e, supportBrace.id, !!isInteractable);
    };

    const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
    const startZ = root.diskHeight + root.coneHeight;

    let currentStart = basePos.clone().add(new THREE.Vector3(0, 0, startZ));

    const shafts: React.ReactNode[] = [];
    const joints: React.ReactNode[] = [];

    supportBrace.segments.forEach((segment, index) => {
        const isLast = index === supportBrace.segments.length - 1;

        const endPoint = segment.topJoint
            ? new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z)
            : new THREE.Vector3(hostKnot.pos.x, hostKnot.pos.y, hostKnot.pos.z);

        const start = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
        const end = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

        const segmentSelected = selectedId === segment.id;

        if (segment.type === 'bezier') {
            shafts.push(
                <BezierRenderer
                    key={`shaft-${segment.id}`}
                    id={segment.id}
                    start={start}
                    end={end}
                    control1={segment.controlPoint1}
                    control2={segment.controlPoint2}
                    diameter={segment.diameter}
                    diameterStart={isLast ? supportBrace.profile.terminalStartDiameterMm : undefined}
                    diameterEnd={isLast ? supportBrace.profile.terminalEndDiameterMm : undefined}
                    resolution={segment.resolution}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isParentSelected={isSelected}
                    isSelected={segmentSelected}
                    onClick={() => setSelectedId(segment.id)}
                />,
            );
        } else {
            shafts.push(
                <ShaftRenderer
                    key={`shaft-${segment.id}`}
                    id={segment.id}
                    start={start}
                    end={end}
                    diameter={segment.diameter}
                    diameterStart={isLast ? supportBrace.profile.terminalStartDiameterMm : undefined}
                    diameterEnd={isLast ? supportBrace.profile.terminalEndDiameterMm : undefined}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isParentSelected={isSelected}
                    isSelected={segmentSelected}
                    onClick={() => setSelectedId(segment.id)}
                />,
            );
        }

        if (segment.topJoint) {
            joints.push(
                <JointRenderer
                    key={`joint-${segment.topJoint.id}`}
                    joint={segment.topJoint}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />,
            );
        }

        currentStart = endPoint;
    });

    const shaftDiameter = supportBrace.segments[0]?.diameter ?? supportBrace.profile.bodyDiameterMm;

    return (
        <group onClick={handleClick}>
            {!hidePlateContactPrimitives && (
                <RootsRenderer
                    root={root}
                    shaftDiameter={shaftDiameter}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                />
            )}

            <group ref={pickRef as React.RefObject<THREE.Group | null>}>{shafts}</group>

            {showKnot && (
                <KnotRenderer
                    knot={hostKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isInteractable={isInteractable}
                    isParentSelected={isSelected}
                />
            )}

            {joints}
        </group>
    );
}
