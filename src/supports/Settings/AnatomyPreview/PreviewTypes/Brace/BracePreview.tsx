import React from 'react';
import * as THREE from 'three';
import { SupportBuilder } from '@/supports/rendering/SupportBuilder';
import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import type { SupportKind } from '../../../supportKindState';

interface BracePreviewProps {
    settings: any;
    activeKind: SupportKind;
    previewState: any;
}

const PREVIEW_HEIGHT_MM = 22.95; // 1.7× then −10%

/**
 * Build support data for a single vertical trunk at (posX, posY) using
 * realistic settings (root cones, joint spheres, contact cones, etc.)
 */
function buildTrunkData(
    posX: number,
    posY: number,
    index: number,
    shaftDiameterMm: number,
    rootsDiameterMm: number,
    rootsDiskHeightMm: number,
    rootsConeHeightMm: number,
) {
    const u = (s: string) => `brace-trunk-${index}-${s}`;

    const rootPos = { x: posX, y: posY, z: 0 };

    const root = {
        id: u('root'),
        modelId: `anatomy-preview-brace-trunk-${index}`,
        transform: { pos: rootPos, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: rootsDiameterMm,
        diskHeight: rootsDiskHeightMm,
        coneHeight: rootsConeHeightMm,
    };

    // Roots top-of-cone Z (where shaft starts)
    const rootsTopZ = rootsDiskHeightMm + rootsConeHeightMm;

    // Bottom joint at the top of the root cone
    const bottomJointPos = { x: posX, y: posY, z: rootsTopZ };
    const bottomJoint = {
        id: u('bottomJoint'),
        pos: bottomJointPos,
        diameter: shaftDiameterMm + 0.2,
    };

    // Top joint at the top of the trunk
    const topJointPos = { x: posX, y: posY, z: PREVIEW_HEIGHT_MM };
    const topJoint = {
        id: u('topJoint'),
        pos: topJointPos,
        diameter: shaftDiameterMm + 0.2,
    };

    // Two segments: root→bottomJoint→topJoint for a realistic look with a joint sphere
    const seg1 = {
        id: u('seg1'),
        diameter: shaftDiameterMm,
        topJoint: bottomJoint,
    };

    const seg2 = {
        id: u('seg2'),
        diameter: shaftDiameterMm,
        topJoint,
    };

    // Contact cone pointing upward at the top
    const contactCone = {
        id: u('cone'),
        pos: { x: posX, y: posY, z: PREVIEW_HEIGHT_MM + 2.0 },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: {
            type: 'disk' as const,
            contactDiameterMm: 0.35,
            bodyDiameterMm: shaftDiameterMm,
            lengthMm: 2.0,
            penetrationMm: 0.1,
            diskThicknessMm: 0.1,
            maxStandoffMm: 1.5,
            standoffAngleThreshold: Math.PI / 4,
        },
        socketJointId: u('topJoint'),
    };

    return {
        id: u('trunk'),
        roots: root,
        segments: [seg1, seg2],
        contactCone,
        angle: 0,
    };
}

/**
 * Real auto-bracing pattern for a single pair of trunks at a given rung Z.
 * 
 * Mirrors the production logic in autoBrace.ts:
 * - The "low" end of each brace sits at `anchorZ` on the first trunk.
 * - The "high" end sits at `anchorZ + horizontalDist` on the second trunk
 *   (dzGuess ≈ horizontal distance between the two supports).
 * - singleDiagonal → one brace (a → b)
 * - crossDiagonal   → two braces (a → b and b → a)
 */
function applyPatternToPair(
    result: { start: THREE.Vector3; end: THREE.Vector3; section: 'initial' | 'repeating' }[],
    aX: number,
    aY: number,
    bX: number,
    bY: number,
    horizontalDist: number,
    anchorZ: number,
    pattern: string,
    section: 'initial' | 'repeating',
    trunkTopZ: number,
) {
    const dzGuess = horizontalDist;

    // Real auto-bracing rule: skip if the high end would go past the top joint.
    if (anchorZ + dzGuess >= trunkTopZ - 0.1) return;

    const placeLowHigh = (lowX: number, lowY: number, highX: number, highY: number) => {
        result.push({
            start: new THREE.Vector3(lowX, lowY, anchorZ),
            end: new THREE.Vector3(highX, highY, anchorZ + dzGuess),
            section,
        });
    };

    // singleDiagonal: place(a, b)
    // crossDiagonal:  place(a, b) + place(b, a)
    placeLowHigh(aX, aY, bX, bY);
    if (pattern === 'crossDiagonal') {
        placeLowHigh(bX, bY, aX, aY);
    }
}

/**
 * Brace anatomy preview: 3×3 grid of proper trunks (rendered through SupportBuilder
 * like the Grid preview) with simulated braces between adjacent trunks using
 * the real auto-bracing rules.
 */
export function BracePreview({
    settings,
    activeKind,
    previewState,
}: BracePreviewProps) {
    if (activeKind !== 'stick') return null;

    const autoBracing = settings.autoBracing ?? {};
    const braceDiameter = autoBracing.braceDiameterMm ?? 0.7;
    const initialPattern: string = autoBracing.initialPattern ?? 'singleDiagonal';
    const initialDistance = autoBracing.initialDistanceMm ?? 2.0;
    const repeatingPattern: string = autoBracing.repeatingPattern ?? 'singleDiagonal';
    const patternInterval = autoBracing.patternIntervalMm ?? 10.0;
    const shaftDiameterMm = Math.max(0.5, settings.shaft?.diameterMm ?? 1.0);
    const rootsDiameterMm = settings.roots?.diameterMm ?? 2.0;
    const rootsDiskHeightMm = settings.roots?.diskHeightMm ?? 0.2;
    const rootsConeHeightMm = settings.roots?.coneHeightMm ?? 0.3;
    const braceRadius = braceDiameter / 2;

    const HIGHLIGHT_COLOR = ANATOMY_CONFIG.colors.highlight;
    const DIM_COLOR = ANATOMY_CONFIG.colors.dim;
    const NORMAL_COLOR = ANATOMY_CONFIG.colors.normal;
    const focusKey = previewState.activeSettingKey;
    const isBraceFocused = focusKey?.startsWith('brace') ?? false;
    const isPatternFocused = focusKey === 'initialPattern' || focusKey === 'repeatingPattern';
    const isDiameterFocused = focusKey === 'braceDiameterMm';

    // Three trunks with varying spacing to show different brace distances
    const maxBraceLength = autoBracing.maxBraceLengthMm ?? 10.0;
    const rootsTopZ = rootsDiskHeightMm + rootsConeHeightMm;

    // Positions: left gap 5mm (X only), right gap 10mm (X + Y offset for 3D scenario)
    const trunkPositions: { x: number; y: number; index: number }[] = [
        { x: -7.5, y: 0,  index: 0 },
        { x: -2.5, y: 0,  index: 1 },
        { x: 7.5,  y: 5,  index: 2 },
    ];

    // Build trunk support data (memoised)
    const trunkSupports = React.useMemo(
        () => trunkPositions.map(({ x, y, index }) =>
            buildTrunkData(x, y, index, shaftDiameterMm, rootsDiameterMm, rootsDiskHeightMm, rootsConeHeightMm),
        ),
        [shaftDiameterMm, rootsDiameterMm, rootsDiskHeightMm, rootsConeHeightMm],
    );

    // Anatomy colour overrides for the trunks
    const trunkOverrides = React.useMemo(() => {
        if (isDiameterFocused || isBraceFocused) {
            return {
                roots: DIM_COLOR,
                rootsDisk: DIM_COLOR,
                rootsCone: DIM_COLOR,
                shaft: DIM_COLOR,
                joint: DIM_COLOR,
                tipBody: DIM_COLOR,
                tipDisk: DIM_COLOR,
            };
        }
        return undefined; // default orange
    }, [isDiameterFocused, isBraceFocused, DIM_COLOR]);

    // Brace pairs: one at 5mm (flat X), one at ~11.18mm (3D — X + Y offset)
    type GridPair = { aX: number; aY: number; bX: number; bY: number; dist: number };
    const bracePairs: GridPair[] = [
        { aX: -7.5, aY: 0, bX: -2.5, bY: 0, dist: 5 },
        { aX: -2.5, aY: 0, bX: 7.5,  bY: 5, dist: Math.sqrt(10 * 10 + 5 * 5) },
    ];

    // Build brace geometry using the real auto-bracing ladder logic
    const braces: { start: THREE.Vector3; end: THREE.Vector3; section: 'initial' | 'repeating' }[] = [];

    const ladder: number[] = [rootsTopZ + initialDistance];
    let curr = rootsTopZ + initialDistance + patternInterval;
    const maxZ = PREVIEW_HEIGHT_MM - 1.0;
    while (curr <= maxZ) { ladder.push(curr); curr += patternInterval; }

    ladder.forEach((anchorZ, tierIndex) => {
        const isInitial = tierIndex === 0;
        const pattern = isInitial ? initialPattern : repeatingPattern;
        const section: 'initial' | 'repeating' = isInitial ? 'initial' : 'repeating';

        for (const pair of bracePairs) {
            applyPatternToPair(
                braces,
                pair.aX, pair.aY,
                pair.bX, pair.bY,
                pair.dist,
                anchorZ, pattern, section, PREVIEW_HEIGHT_MM,
            );
        }
    });

    // Colour per section
    const getSectionColor = (s: 'initial' | 'repeating'): string => {
        if (isPatternFocused) return HIGHLIGHT_COLOR;
        if (isDiameterFocused || isBraceFocused) return s === 'initial' ? DIM_COLOR : '#666666';
        return s === 'initial' ? '#00cc66' : '#33aaff';
    };

    return (
        <group>
            <directionalLight position={[0, 0, -20]} intensity={0.6} color="#ffffff" />

            {/* Trunks rendered through SupportBuilder (same pattern as Grid) */}
            {trunkSupports.map((data) => (
                <SupportBuilder
                    key={data.id}
                    data={data}
                    isPreview={ANATOMY_CONFIG.rendering.showAsGhostPreview}
                    raftOverride={{ bottomMode: 'off', thickness: 0 }}
                    anatomyOverrides={trunkOverrides}
                />
            ))}

            {/* Braces simulated between the trunks */}
            {braces.map((brace, i) => {
                const dir = brace.end.clone().sub(brace.start);
                const length = dir.length();
                if (length < 0.001) return null;
                const mid = brace.start.clone().add(dir.clone().multiplyScalar(0.5));
                const quat = new THREE.Quaternion().setFromUnitVectors(
                    new THREE.Vector3(0, 1, 0),
                    dir.clone().normalize(),
                );
                const color = getSectionColor(brace.section);

                return (
                    <group key={`brace-${i}`}>
                        <group position={[mid.x, mid.y, mid.z]} quaternion={quat}>
                            <mesh>
                                <cylinderGeometry args={[braceRadius, braceRadius, length, 8]} />
                                <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} transparent opacity={0.75} />
                            </mesh>
                        </group>
                        <mesh position={[brace.start.x, brace.start.y, brace.start.z]}>
                            <sphereGeometry args={[braceRadius * 1.8, 8, 8]} />
                            <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} transparent opacity={0.75} />
                        </mesh>
                        <mesh position={[brace.end.x, brace.end.y, brace.end.z]}>
                            <sphereGeometry args={[braceRadius * 1.8, 8, 8]} />
                            <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} transparent opacity={0.75} />
                        </mesh>
                    </group>
                );
            })}
        </group>
    );
}
