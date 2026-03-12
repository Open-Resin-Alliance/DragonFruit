import React from 'react';
import * as THREE from 'three';
import { SupportBuilder } from '@/supports/rendering/SupportBuilder';
import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '@/supports/SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '@/supports/SupportTypes/Leaf/leafBuilder';
import { buildStick } from '@/supports/SupportTypes/Stick/stickBuilder';
import { buildTwig } from '@/supports/SupportTypes/Twig/twigBuilder';
import { resolveConeAxisPolicy } from '@/supports/PlacementLogic/ConeAxisPolicy';
import type { SupportTipProfile } from '@/supports/SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportKind } from '../../../supportKindState';

interface TrunkPreviewProps {
    settings: any;
    liveConfig: any;
    activeKind: SupportKind;
    previewState: any;
    anatomyOverrides: any;
}

export function TrunkPreview({
    settings,
    liveConfig,
    activeKind,
    previewState,
    anatomyOverrides
}: TrunkPreviewProps) {

    // Rebuild support data whenever settings OR liveConfig changes
    const supportData = React.useMemo(() => {
        // Shared camera math for "cone-like" tips
        const lengthMm = settings.tip.lengthMm;

        // Map Display Angle [0, -90] to Internal Trig Angle [0, 90]
        // -90 -> 90 (Vertical Up)
        // 0 -> 0 (Horizontal Right)
        const internalAngle = Math.abs(liveConfig.coneAngleDeg);
        const angleRad = THREE.MathUtils.degToRad(internalAngle);

        const nx = Math.cos(angleRad);
        const nz = Math.sin(angleRad);

        // buildTrunkData/PlacementLogic uses TipNormal + cone-axis policy to find the Socket.
        // socketPos = tipPos + surfaceNormal * diskThickness + coneAxis * lengthMm.
        // 1. To make the cone point UP/RIGHT from Socket to Tip:
        //    Tip must be at +X, +Z relative to Socket.
        //    So TipNormal (from Tip to Socket) must be (-nx, 0, -nz).
        const tipNormal = { x: -nx, y: 0, z: -nz };

        // 2. Keep the trunk centered at X=0 even when cone-angle mode is Locked/Adaptive.
        // In those modes, PlacementLogic may choose a cone axis different from the surface normal.
        // We compute the same cone axis + disk thickness and place the tip so the resulting socket X remains 0.
        const tipProfile: SupportTipProfile = {
            type: 'disk',
            contactDiameterMm: liveConfig.tipContactDiameterMm,
            bodyDiameterMm: liveConfig.shaftDiameterMm,
            lengthMm: liveConfig.tipLengthMm,
            penetrationMm: settings.tip.penetrationMm,
            diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
            maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
            standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? (Math.PI / 4),
        };

        const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
        const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

        const { coneAxis } = resolveConeAxisPolicy({
            surfaceNormal: tipNormal,
            coneAngleMode,
            adaptiveConeAngleOffsetDeg,
        });

        const diskThickness = calculateDiskThickness(tipNormal, coneAxis, tipProfile);
        const tipX = -(tipNormal.x * diskThickness + coneAxis.x * tipProfile.lengthMm);

        const tipPos = { x: tipX, y: 0, z: liveConfig.previewHeightMm };

        if (activeKind === 'trunk' || activeKind === 'raft') {
            return buildTrunkData({
                tipPos: tipPos,
                tipNormal: tipNormal,
                modelId: 'anatomy-preview',
                overrides: {
                    rootsDiameterMm: liveConfig.rootsDiameterMm,
                    rootsDiskHeightMm: liveConfig.rootsDiskHeightMm,
                    rootsConeHeightMm: liveConfig.rootsConeHeightMm,
                    shaftDiameterMm: liveConfig.shaftDiameterMm,
                    tipContactDiameterMm: liveConfig.tipContactDiameterMm,
                    tipBodyDiameterMm: liveConfig.shaftDiameterMm,
                    tipLengthMm: liveConfig.tipLengthMm,
                }
            }).supportData;
        }

        if (activeKind === 'branch') {
            const parentKnot = {
                id: 'anatomy-preview-knot',
                parentShaftId: 'anatomy-preview-shaft',
                pos: { x: 0, y: 0, z: 8 },
                diameter: settings.shaft.diameterMm + 0.1,
            };

            const branchTipPos = { x: 2.5, y: 0, z: liveConfig.previewHeightMm };
            return buildBranchData({
                tipPos: branchTipPos,
                tipNormal: tipNormal,
                modelId: 'anatomy-preview',
                parentKnot,
            }).supportData;
        }

        if (activeKind === 'leaf') {
            const parentKnot = {
                id: 'anatomy-preview-knot',
                parentShaftId: 'anatomy-preview-shaft',
                pos: { x: 0, y: 0, z: 8 },
                diameter: settings.shaft.diameterMm + 0.1,
            };

            const leafTipPos = { x: 2.2, y: 0, z: liveConfig.previewHeightMm };
            return buildLeafData({
                tipPos: leafTipPos,
                surfaceNormal: tipNormal,
                modelId: 'anatomy-preview',
                parentKnot,
                hostDiameterMm: settings.shaft.diameterMm,
            }).supportData;
        }

        if (activeKind === 'stick') {
            const aPos = { x: -2.8, y: 0, z: 10.5 };
            const bPos = { x: 2.8, y: 0, z: 7.5 };
            const aNormal = { x: 0, y: 0, z: 1 };
            const bNormal = { x: 0, y: 0, z: 1 };
            const built = buildStick({ modelId: 'anatomy-preview', aPos, aNormal, bPos, bNormal });
            const seg = built.stick.segments[0];

            return {
                id: built.stick.id,
                startPos: seg.bottomJoint?.pos ?? aPos,
                segments: [seg],
                contactCones: [built.stick.contactConeA, built.stick.contactConeB],
            };
        }

        // twig
        const aPos = { x: -2.8, y: 0, z: 10.5 };
        const bPos = { x: 2.8, y: 0, z: 7.5 };
        const aNormal = { x: 0, y: 0, z: 1 };
        const bNormal = { x: 0, y: 0, z: 1 };
        const built = buildTwig({ modelId: 'anatomy-preview', aPos, aNormal, bPos, bNormal });
        const seg = built.twig.segments[0];

        return {
            id: built.twig.id,
            startPos: seg.bottomJoint?.pos ?? aPos,
            segments: [seg],
            contactDisks: [built.twig.contactDiskA, built.twig.contactDiskB],
        };
    }, [activeKind, settings, liveConfig]);

    // If we're on Raft or Grid, we use those specific previews instead. 
    // BUT the Canvas handles the switching.
    // However, if we're here, we render standard support.

    return (
        <SupportBuilder
            data={supportData}
            isPreview={ANATOMY_CONFIG.rendering.showAsGhostPreview}
            raftOverride={{ bottomMode: 'off', thickness: 0 }}
            anatomyOverrides={anatomyOverrides}
        />
    );
}
