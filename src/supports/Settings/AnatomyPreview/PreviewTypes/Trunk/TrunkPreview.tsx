import React from 'react';
import * as THREE from 'three';
import { SupportBuilder, type SupportData } from '@/supports/rendering/SupportBuilder';
import { ANATOMY_CONFIG } from '../../AnatomyPreviewConfig';
import type { SupportSettings } from '../../../types';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '@/supports/SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '@/supports/SupportTypes/Leaf/leafBuilder';
import { buildStick } from '@/supports/SupportTypes/Stick/stickBuilder';
import { buildTwig } from '@/supports/SupportTypes/Twig/twigBuilder';
import { resolveConeAxisPolicy } from '@/supports/PlacementLogic/ConeAxisPolicy';
import type { SupportTipProfile } from '@/supports/SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SidebarPanel } from '../../../sidebarPanels';
import {
    getSupportTypeDescriptor,
    SIDEBAR_PANEL_TYPE_IDS,
    type SupportTypeDescriptor,
} from '../../../../supportTypeRegistry';

interface TrunkPreviewProps {
    settings: any;
    liveConfig: any;
    activePanel: SidebarPanel;
    previewState: any;
    anatomyOverrides: any;
}

/** The tip geometry the memo solved once, shared by every diagram below. */
interface PreviewContext {
    settings: SupportSettings;
    /** The live preview values the canvas publishes while a setting is focused. */
    liveConfig: {
        previewHeightMm: number;
        coneAngleDeg: number;
        tipContactDiameterMm: number;
        tipLengthMm: number;
        shaftDiameterMm: number;
        rootsDiameterMm: number;
        rootsDiskHeightMm: number;
        rootsConeHeightMm: number;
    };
    tipPos: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
}

type PreviewDataBuilder = (context: PreviewContext) => SupportData;

/** The standard support diagram, also used by the raft page. */
const buildStandardDiagramData: PreviewDataBuilder = ({ liveConfig, tipPos, tipNormal }) =>
    buildTrunkData({
        tipPos,
        tipNormal,
        modelId: 'anatomy-preview',
        overrides: {
            rootsDiameterMm: liveConfig.rootsDiameterMm,
            rootsDiskHeightMm: liveConfig.rootsDiskHeightMm,
            rootsConeHeightMm: liveConfig.rootsConeHeightMm,
            shaftDiameterMm: liveConfig.shaftDiameterMm,
            tipContactDiameterMm: liveConfig.tipContactDiameterMm,
            tipBodyDiameterMm: liveConfig.shaftDiameterMm,
            tipLengthMm: liveConfig.tipLengthMm,
        },
    }).supportData;

/** A shaft hanging off a host knot. */
const buildKnotShaftDiagramData: PreviewDataBuilder = ({ settings, liveConfig, tipNormal }) =>
    buildBranchData({
        tipPos: { x: 2.5, y: 0, z: liveConfig.previewHeightMm },
        tipNormal,
        modelId: 'anatomy-preview',
        parentKnot: {
            id: 'anatomy-preview-knot',
            parentShaftId: 'anatomy-preview-shaft',
            pos: { x: 0, y: 0, z: 8 },
            diameter: settings.shaft.diameterMm + 0.1,
        },
    }).supportData;

/** A bare contact hanging off a host knot. */
const buildKnotContactDiagramData: PreviewDataBuilder = ({ settings, liveConfig, tipNormal }) =>
    buildLeafData({
        tipPos: { x: 2.2, y: 0, z: liveConfig.previewHeightMm },
        surfaceNormal: tipNormal,
        modelId: 'anatomy-preview',
        parentKnot: {
            id: 'anatomy-preview-knot',
            parentShaftId: 'anatomy-preview-shaft',
            pos: { x: 0, y: 0, z: 8 },
            diameter: settings.shaft.diameterMm + 0.1,
        },
        hostDiameterMm: settings.shaft.diameterMm,
    }).supportData;

/** A span propped between two model contacts, on disks. */
const buildDiskSpanDiagramData: PreviewDataBuilder = () => {
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
};

/** The same span, drawn with cones. */
const buildConeSpanDiagramData: PreviewDataBuilder = () => {
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
};

/** The preview shape a type declares: what sits at each end, and what joins them. */
type PreviewShape = 'plateShaft' | 'knotShaft' | 'knotContact' | 'coneSpan' | 'diskSpan';

function previewShapeOf(descriptor: SupportTypeDescriptor): PreviewShape | null {
    const { lower, upper } = descriptor;
    if (lower.kind === 'cone' && upper.kind === 'cone') return 'coneSpan';
    if (lower.kind === 'disk' && upper.kind === 'disk') return 'diskSpan';
    if (lower.kind === 'knot') return descriptor.hasSegments ? 'knotShaft' : 'knotContact';
    if (lower.kind === 'plateRoot' && descriptor.hasSegments) return 'plateShaft';
    return null;
}

/** How each preview shape is drawn. */
const PREVIEW_DATA_BY_SHAPE: Record<PreviewShape, PreviewDataBuilder> = {
    plateShaft: buildStandardDiagramData,
    knotShaft: buildKnotShaftDiagramData,
    knotContact: buildKnotContactDiagramData,
    coneSpan: buildConeSpanDiagramData,
    diskSpan: buildDiskSpanDiagramData,
};

/**
 * What draws each panel. A panel with no entry falls through to the disk-span
 * diagram.
 */
const PREVIEW_DATA_BY_PANEL: Partial<Record<SidebarPanel, PreviewDataBuilder>> = {
    raft: buildStandardDiagramData,
    ...Object.fromEntries(
        SIDEBAR_PANEL_TYPE_IDS.flatMap((typeId) => {
            const shape = previewShapeOf(getSupportTypeDescriptor(typeId));
            const builder = shape ? PREVIEW_DATA_BY_SHAPE[shape] : undefined;
            return builder ? [[typeId, builder] as const] : [];
        }),
    ),
};

export function TrunkPreview({
    settings,
    liveConfig,
    activePanel,
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

        const buildPreviewData = PREVIEW_DATA_BY_PANEL[activePanel] ?? buildDiskSpanDiagramData;
        return buildPreviewData({ settings, liveConfig, tipPos, tipNormal });
    }, [activePanel, settings, liveConfig]);

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
