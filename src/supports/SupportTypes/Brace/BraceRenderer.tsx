import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Brace, Knot } from '../../types';
import { useHighlight } from '../../interaction/useHighlight';
import { handleSupportClick } from '../../interaction/clickHandlers';
import { KnotRenderer } from '../../SupportPrimitives/Knot/KnotRenderer';
import { ShaftRenderer } from '../../SupportPrimitives/Shaft/ShaftRenderer';
import { BezierRenderer } from '../../Renderers/BezierRenderer';
import { usePicking } from '@/components/picking';
import { setSelectedId } from '../../state';

interface BraceRendererProps {
    brace: Brace;
    startKnot: Knot;
    endKnot: Knot;
    isSelected?: boolean;
    dimNonSelected?: boolean;
    showKnots?: boolean;
    isHovered?: boolean;
    suppressHover?: boolean;
    isInteractable?: boolean;
}

export function BraceRenderer({
    brace,
    startKnot,
    endKnot,
    isSelected,
    dimNonSelected,
    showKnots,
    isHovered: propHovered,
    suppressHover,
    isInteractable = true,
}: BraceRendererProps) {
    const segmentId = `braceSegment:${brace.id}`;

    const isBezierSelected = !!isSelected && brace.curve?.type === 'bezier';

    const { pickRef, visuals } = useHighlight({
        id: brace.id,
        category: 'support',
        isSelected,
        suppressHover,
        externalHover: propHovered,
        baseColor: dimNonSelected && !isSelected ? '#666666' : '#ff8800',
        selectedColor: '#80fffd',
    });

    const shaftColor = isBezierSelected ? '#ff00ff' : visuals.color;

    const segmentRef = useRef<THREE.Group>(null);
    const pickIdRef = useRef<number | null>(null);
    const { register, unregister } = usePicking();

    useEffect(() => {
        if (!segmentRef.current) return;
        segmentRef.current.userData.segmentId = segmentId;

        pickIdRef.current = register({
            category: 'segment',
            objectId: segmentId,
            object: segmentRef.current,
        });

        return () => {
            if (pickIdRef.current !== null) {
                unregister(pickIdRef.current);
                pickIdRef.current = null;
            }
        };
    }, [register, unregister, segmentId]);

    const startVec = useMemo(() => new THREE.Vector3(startKnot.pos.x, startKnot.pos.y, startKnot.pos.z), [startKnot.pos.x, startKnot.pos.y, startKnot.pos.z]);
    const endVec = useMemo(() => new THREE.Vector3(endKnot.pos.x, endKnot.pos.y, endKnot.pos.z), [endKnot.pos.x, endKnot.pos.y, endKnot.pos.z]);

    const uniformBraceDiameter = Math.max(0.001, brace.profile?.diameter ?? 1.0);

    const handleClick = (e: any) => {
        // Alt+click should behave like a shaft click for placement tools (Brace/Branch/etc.)
        if (e?.nativeEvent?.altKey || e?.altKey) {
            e.stopPropagation();
            if (e.nativeEvent) {
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
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
                e.nativeEvent.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
            }
            setSelectedId(segmentId);
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
        <group onClick={handleClick}>
            <group ref={pickRef as any}>
                <group ref={segmentRef}>
                    {brace.curve?.type === 'bezier' ? (
                        <BezierRenderer
                            id={segmentId}
                            start={startKnot.pos}
                            end={endKnot.pos}
                            control1={brace.curve.controlPoint1}
                            control2={brace.curve.controlPoint2}
                            diameter={brace.profile?.diameter ?? 1.0}
                            diameterStart={uniformBraceDiameter}
                            diameterEnd={uniformBraceDiameter}
                            resolution={brace.curve.resolution}
                            color={shaftColor}
                            emissive={visuals.emissive}
                            emissiveIntensity={visuals.emissiveIntensity}
                            isParentSelected={!!isSelected}
                            isSelected={false}
                            onClick={() => setSelectedId(segmentId)}
                        />
                    ) : (
                        <ShaftRenderer
                            id={segmentId}
                            start={startKnot.pos}
                            end={endKnot.pos}
                            diameter={brace.profile?.diameter ?? 1.0}
                            diameterStart={uniformBraceDiameter}
                            diameterEnd={uniformBraceDiameter}
                            color={shaftColor}
                            emissive={visuals.emissive}
                            emissiveIntensity={visuals.emissiveIntensity}
                            isParentSelected={!!isSelected}
                            isSelected={false}
                            onClick={() => setSelectedId(segmentId)}
                        />
                    )}
                </group>
            </group>

            {showKnots !== false && (
                <KnotRenderer
                    knot={startKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isInteractable={isInteractable}
                    isParentSelected={!!isSelected}
                />
            )}
            {showKnots !== false && (
                <KnotRenderer
                    knot={endKnot}
                    color={visuals.color}
                    emissive={visuals.emissive}
                    emissiveIntensity={visuals.emissiveIntensity}
                    isInteractable={isInteractable}
                    isParentSelected={!!isSelected}
                />
            )}
        </group>
    );
}
