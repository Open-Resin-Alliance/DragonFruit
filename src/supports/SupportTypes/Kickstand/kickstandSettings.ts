import * as THREE from 'three';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { getSettings } from '../../Settings';
import type { KickstandPlacementLayout } from './types';

type NumericConstraint = {
    min: number;
    max: number;
    step: number;
    defaultValue: number;
};

export const KICKSTAND_LAYOUT_CONSTRAINTS = {
    firstJointHeightRatio: { min: 0.1, max: 0.75, step: 0.01, defaultValue: 0.35 },
    secondJointHeightRatio: { min: 0.3, max: 0.95, step: 0.01, defaultValue: 0.72 },
    minJointSpacingMm: { min: 0.1, max: 5, step: 0.1, defaultValue: 0.6 },
    minTerminalClearanceMm: { min: 0.1, max: 5, step: 0.1, defaultValue: 0.25 },
} satisfies Record<keyof KickstandPlacementLayout, NumericConstraint>;

function clampConstraint(value: number, constraint: NumericConstraint): number {
    return THREE.MathUtils.clamp(value, constraint.min, constraint.max);
}

export function resolveKickstandLayout(
    overrides?: Partial<KickstandPlacementLayout>,
): KickstandPlacementLayout {
    const firstJointHeightRatio = clampConstraint(
        overrides?.firstJointHeightRatio ?? KICKSTAND_LAYOUT_CONSTRAINTS.firstJointHeightRatio.defaultValue,
        KICKSTAND_LAYOUT_CONSTRAINTS.firstJointHeightRatio,
    );

    const secondJointHeightRatioRaw = clampConstraint(
        overrides?.secondJointHeightRatio ?? KICKSTAND_LAYOUT_CONSTRAINTS.secondJointHeightRatio.defaultValue,
        KICKSTAND_LAYOUT_CONSTRAINTS.secondJointHeightRatio,
    );

    const minJointSpacingMm = clampConstraint(
        overrides?.minJointSpacingMm ?? KICKSTAND_LAYOUT_CONSTRAINTS.minJointSpacingMm.defaultValue,
        KICKSTAND_LAYOUT_CONSTRAINTS.minJointSpacingMm,
    );

    const minTerminalClearanceMm = clampConstraint(
        overrides?.minTerminalClearanceMm ?? KICKSTAND_LAYOUT_CONSTRAINTS.minTerminalClearanceMm.defaultValue,
        KICKSTAND_LAYOUT_CONSTRAINTS.minTerminalClearanceMm,
    );

    // Keep second joint above first joint in ratio space.
    const minSecond = Math.min(
        KICKSTAND_LAYOUT_CONSTRAINTS.secondJointHeightRatio.max,
        firstJointHeightRatio + KICKSTAND_LAYOUT_CONSTRAINTS.secondJointHeightRatio.step,
    );

    return {
        firstJointHeightRatio,
        secondJointHeightRatio: Math.max(secondJointHeightRatioRaw, minSecond),
        minJointSpacingMm,
        minTerminalClearanceMm,
    };
}

export function getKickstandBodyDiameterMm(): number {
    return getSettings().shaft.diameterMm;
}

export function getKickstandRootProfile(): { diameter: number; diskHeight: number; coneHeight: number } {
    const settings = getSettings();
    return {
        diameter: settings.roots.diameterMm,
        diskHeight: settings.roots.diskHeightMm,
        coneHeight: settings.roots.coneHeightMm,
    };
}

export function getKickstandKnotDiameterMm(hostDiameterMm: number): number {
    return Math.max(0.001, hostDiameterMm) + JOINT_DIAMETER_OFFSET_MM;
}

export const KICKSTAND_DEFAULT_HOST_OFFSET_MM = 4;

export function getKickstandPlacementOffsetMm(): number {
    return KICKSTAND_DEFAULT_HOST_OFFSET_MM;
}
