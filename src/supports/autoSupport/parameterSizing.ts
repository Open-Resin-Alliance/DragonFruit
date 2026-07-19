import type { CandidatePoint } from './types';
import type { SupportSettings } from '../Settings/types';
import { createDefaultSettings } from '../Settings/types';

// ---------------------------------------------------------------------------
// Preset definitions — mirrors the built-in presets from
// src/supports/Settings/presets.ts.  Inlined so auto-placement doesn't
// depend on the preset store / React runtime.
// ---------------------------------------------------------------------------

/** Thin supports for fine details and small islands (≤ 0.15 mm²). */
const DETAIL_SETTINGS: SupportSettings = {
    ...createDefaultSettings(),
    tip: {
        shape: 'cone',
        type: 'disk',
        contactDiameterMm: 0.22,
        bodyDiameterMm: 0.8,
        lengthMm: 2.5,
        penetrationMm: 0,
        coneAngleMode: 'adaptive',
        adaptiveConeAngleOffsetDeg: 60,
        coneAngleDeg: 100,
        breakpointMm: 0,
    },
    shaft: {
        shape: 'cylinder',
        diameterMm: 0.8,
        secondaryDiameterMm: 0.8,
        isStraight: true,
        maxAngleDeg: 80,
    },
    roots: {
        shape: 'cylinder',
        diameterMm: 2.0,
        diskHeightMm: 0.5,
        coneHeightMm: 1.0,
        neckDiameterMm: 0.8,
        neckBlend: 0.7,
    },
    baseFlare: {
        enabled: true,
        diameterMm: 2.5,
        heightMm: 1.2,
    },
};

/** Balanced supports for medium islands (0.15 – 0.50 mm²). */
const STRUCTURE_SETTINGS: SupportSettings = {
    ...createDefaultSettings(),
    tip: {
        ...createDefaultSettings().tip,
        contactDiameterMm: 0.28,
        lengthMm: 2.5,
    },
    shaft: {
        ...createDefaultSettings().shaft,
        diameterMm: 1.0,
        secondaryDiameterMm: 1.0,
    },
    roots: {
        ...createDefaultSettings().roots,
        diameterMm: 2.0,
        diskHeightMm: 0.5,
        coneHeightMm: 1.0,
    },
};

/** Heavy supports for large overhangs (> 0.50 mm²). */
const ANCHOR_SETTINGS: SupportSettings = {
    ...createDefaultSettings(),
    tip: {
        shape: 'cone',
        type: 'disk',
        contactDiameterMm: 0.4,
        bodyDiameterMm: 1.2,
        lengthMm: 2.5,
        penetrationMm: 0,
        coneAngleMode: 'adaptive',
        adaptiveConeAngleOffsetDeg: 60,
        coneAngleDeg: 100,
        breakpointMm: 0,
    },
    shaft: {
        shape: 'cylinder',
        diameterMm: 1.2,
        secondaryDiameterMm: 1.2,
        isStraight: true,
        maxAngleDeg: 80,
    },
    roots: {
        shape: 'cylinder',
        diameterMm: 2.0,
        diskHeightMm: 0.5,
        coneHeightMm: 1.0,
        neckDiameterMm: 1.5,
        neckBlend: 0.7,
    },
    baseFlare: {
        enabled: true,
        diameterMm: 4.0,
        heightMm: 2.0,
    },
};

// ---------------------------------------------------------------------------
// Override type
// ---------------------------------------------------------------------------

export interface SizeOverrides {
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    tipBodyDiameterMm?: number;
    tipLengthMm?: number;
    tipPenetrationMm?: number;
    rootsDiameterMm?: number;
    rootsDiskHeightMm?: number;
    rootsConeHeightMm?: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const DETAIL_MAX_AREA_MM2 = 0.15;
const STRUCTURE_MAX_AREA_MM2 = 0.50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select support dimensions using the same presets as the manual
 * placement toolbar (Detail / Structure / Anchor).
 *
 * | Island area       | Preset    | Tip Ø  | Shaft Ø | Use case        |
 * |-------------------|-----------|--------|---------|-----------------|
 * | ≤ 0.15 mm²        | Detail    | 0.22   | 0.8     | fine features   |
 * | 0.15 – 0.50 mm²   | Structure | 0.28   | 1.0     | general use     |
 * | > 0.50 mm²        | Anchor    | 0.40   | 1.2     | large overhangs |
 */
export function sizeParameters(candidate: CandidatePoint): SizeOverrides {
    const settings = selectPreset(candidate);
    return {
        shaftDiameterMm: settings.shaft.diameterMm,
        tipContactDiameterMm: settings.tip.contactDiameterMm,
        tipBodyDiameterMm: settings.tip.bodyDiameterMm,
        tipLengthMm: settings.tip.lengthMm,
        tipPenetrationMm: settings.tip.penetrationMm,
        rootsDiameterMm: settings.roots.diameterMm,
        rootsDiskHeightMm: settings.roots.diskHeightMm,
        rootsConeHeightMm: settings.roots.coneHeightMm,
    };
}

function selectPreset(candidate: CandidatePoint): SupportSettings {
    const area = candidate.islandAreaMm2;
    if (area <= DETAIL_MAX_AREA_MM2) return DETAIL_SETTINGS;
    if (area <= STRUCTURE_MAX_AREA_MM2) return STRUCTURE_SETTINGS;
    return ANCHOR_SETTINGS;
}
