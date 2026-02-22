"use client";

import React, { useMemo } from 'react';
import * as THREE from 'three';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import type { Brace, Knot, Roots, Trunk } from '../../types';

type SupportHeightLabelsProps = {
    trunks: Trunk[];
    braces: Brace[];
    rootsById: Record<string, Roots>;
    knotsById: Record<string, Knot>;
    enabled: boolean;
};

type LabelData = {
    id: string;
    text: string;
    position: [number, number, number];
    color: string;
};

const DEBUG_SECTION_COLORS: Record<'top' | 'middle' | 'bottom', string> = {
    top: '#7dd3fc',
    middle: '#7dd3fc',
    bottom: '#76ff03',
};

const SUPPORT_HEIGHT_COLOR = '#fff26b';
const FALLBACK_BRACE_COLOR = '#ff8800';

/**
 * Temporary calibration/debug overlay for support heights.
 * Shows the contact-cone socket joint Z height in mm for each trunk.
 *
 * TO REMOVE: delete this file and remove SupportHeightLabels usage in SupportRenderer.
 */
export function SupportHeightLabels({ trunks, braces, rootsById, knotsById, enabled }: SupportHeightLabelsProps) {
    const labels = useMemo<LabelData[]>(() => {
        if (!enabled) return [];

        const next: LabelData[] = [];
        for (const trunk of trunks) {
            if (!trunk.contactCone) continue;

            const root = rootsById[trunk.rootId];
            if (!root) continue;

            const socketPos = getFinalSocketPosition(trunk.contactCone);
            const heightMm = socketPos.z - root.transform.pos.z;

            next.push({
                id: `support-height-${trunk.id}`,
                text: `${heightMm.toFixed(2)} mm`,
                position: [socketPos.x + 1.1, socketPos.y + 1.1, socketPos.z],
                color: SUPPORT_HEIGHT_COLOR,
            });
        }

        for (const brace of braces) {
            const startKnot = knotsById[brace.startKnotId];
            const endKnot = knotsById[brace.endKnotId];
            if (!startKnot || !endKnot) continue;

            const braceColor = brace.debugSection
                ? DEBUG_SECTION_COLORS[brace.debugSection]
                : FALLBACK_BRACE_COLOR;

            next.push({
                id: `brace-height-start-${brace.id}`,
                text: `${startKnot.pos.z.toFixed(2)} mm`,
                position: [startKnot.pos.x + 0.85, startKnot.pos.y + 0.85, startKnot.pos.z + 0.18],
                color: braceColor,
            });

            next.push({
                id: `brace-height-end-${brace.id}`,
                text: `${endKnot.pos.z.toFixed(2)} mm`,
                position: [endKnot.pos.x + 0.85, endKnot.pos.y + 0.85, endKnot.pos.z + 0.18],
                color: braceColor,
            });
        }

        return next;
    }, [enabled, rootsById, trunks, braces, knotsById]);

    if (!enabled || labels.length === 0) return null;

    return (
        <>
            {labels.map((label) => (
                <SupportHeightLabel key={label.id} text={label.text} position={label.position} color={label.color} />
            ))}
        </>
    );
}

function SupportHeightLabel({ text, position, color }: { text: string; position: [number, number, number]; color: string }) {
    const texture = useMemo(() => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return null;

        canvas.width = 256;
        canvas.height = 64;
        context.clearRect(0, 0, canvas.width, canvas.height);

        context.fillStyle = color;
        context.font = 'Bold 28px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, canvas.width / 2, canvas.height / 2);

        const nextTexture = new THREE.CanvasTexture(canvas);
        nextTexture.needsUpdate = true;
        return nextTexture;
    }, [text, color]);

    if (!texture) return null;

    return (
        <sprite position={position} scale={[3.2, 0.8, 1]}>
            <spriteMaterial
                map={texture}
                transparent
                sizeAttenuation={true}
                depthTest={true}
                depthWrite={false}
            />
        </sprite>
    );
}
