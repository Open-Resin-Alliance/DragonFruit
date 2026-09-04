import { computePhysicalAaConfig, type AaPreset } from '@/features/slicing/autoAaPhysics';
import type { MaterialAntiAliasingSettings } from '@/features/profiles/profileStore';

export interface EffectiveAaSettings {
    mode: 'Off' | 'Blur' | '3DAA';
    aaSteps: number;
    blurBrushRadiusPx: number;
    blurBrushKernel: 'box' | 'gaussian';
    blurBrushSigmaX: number;
    blurBrushSigmaY: number;
    zBlurRadiusLayers: number;
    zBlurKernel: 'box' | 'gaussian';
    zBlurSigma: number;
    zBlendLookBack: number;
    aaOnSupports: boolean;
    tipOffsetMm: number;
    tipOffsetMode: 'disabled' | 'auto' | 'manual';
}

/**
 * Resolves effective AA and tip penetration offset parameters from material profile settings,
 * preserving existing physical derivations and autoAaPhysics math.
 */
export function resolveEffectiveAaSettings(
    settings: MaterialAntiAliasingSettings,
    layerHeightMm: number,
    pixelPitchMm: number,
    pixelPitchYMm: number = pixelPitchMm,
    activePreset: AaPreset = 'balanced',
): EffectiveAaSettings {
    const safeLayerH = Math.max(0.001, layerHeightMm);
    const safePitchX = Math.max(0.0001, pixelPitchMm);
    const safePitchY = Math.max(0.0001, pixelPitchYMm);

    // Baseline physical auto configuration
    const autoCfg = computePhysicalAaConfig(activePreset, safePitchX, safeLayerH, safePitchY);

    const enableCustom = Boolean(settings.enableCustomSettings);
    const enableOverride = enableCustom && Boolean(settings.enableOverride);

    // If override is NOT active, return physics-derived auto defaults
    if (!enableOverride) {
        const effZBlur = typeof settings.zBlurRadiusLayers === 'number'
            ? Math.max(0, Math.round(settings.zBlurRadiusLayers))
            : autoCfg.zBlurRadiusLayers;
        const autoTipOffset = settings.tipOffsetMode === 'disabled'
            ? 0.05
            : Number(((2 * effZBlur + 1) * safeLayerH).toFixed(3));
        return {
            mode: autoCfg.aaMode,
            aaSteps: autoCfg.aaSteps,
            blurBrushRadiusPx: autoCfg.blurBrushRadiusPx,
            blurBrushKernel: settings.blurBrushKernel ?? 'gaussian',
            blurBrushSigmaX: 0.5,
            blurBrushSigmaY: 0.5,
            zBlurRadiusLayers: autoCfg.zBlurRadiusLayers,
            zBlurKernel: settings.zBlurKernel ?? 'box',
            zBlurSigma: 0.5,
            zBlendLookBack: autoCfg.zBlendLookBack,
            aaOnSupports: Boolean(settings.aaOnSupports),
            tipOffsetMm: settings.tipOffsetMode === 'manual' ? settings.tipOffsetMm : autoTipOffset,
            tipOffsetMode: settings.tipOffsetMode ?? 'disabled',
        };
    }

    // Override mode active with custom settings:
    // Parse explicit level ('2x', '4x', '8x', '16x') -> step count
    const rawLevel = typeof settings.level === 'string' ? settings.level.trim().toLowerCase() : '4x';
    const parsedSteps = Number(rawLevel.endsWith('x') ? rawLevel.slice(0, -1) : rawLevel);
    const aaSteps = Number.isFinite(parsedSteps) && parsedSteps >= 2 ? Math.round(parsedSteps) : autoCfg.aaSteps;

    const blurBrushRadiusPx = settings.useCustomBlurBrushRadius
        ? Math.max(0, Math.round(settings.blurBrushRadiusPx))
        : autoCfg.blurBrushRadiusPx;

    const blurBrushSigmaX = settings.useCustomBlurBrushRadius
        ? Math.max(0.05, settings.blurBrushSigmaX)
        : 0.5;

    const blurBrushSigmaY = settings.useCustomBlurBrushRadius
        ? Math.max(0.05, settings.blurBrushSigmaY)
        : 0.5;

    const zBlurRadiusLayers = typeof settings.zBlurRadiusLayers === 'number'
        ? Math.max(0, Math.round(settings.zBlurRadiusLayers))
        : autoCfg.zBlurRadiusLayers;

    const zBlurSigma = settings.useCustomZBlurRadius
        ? Math.max(0.05, settings.zBlurSigma)
        : 0.5;

    const zBlendLookBack = typeof settings.zBlendLookBack === 'number'
        ? Math.max(1, Math.round(settings.zBlendLookBack))
        : autoCfg.zBlendLookBack;

    // Auto-calculated tip penetration offset based on effective Z blur radius
    const rawTipOffset = settings.tipOffsetMode === 'manual'
        ? settings.tipOffsetMm
        : settings.tipOffsetMode === 'disabled'
        ? 0.05
        : (2 * zBlurRadiusLayers + 1) * safeLayerH;
    const effectiveTipOffset = Number(rawTipOffset.toFixed(3));

    return {
        mode: settings.mode ?? autoCfg.aaMode,
        aaSteps,
        blurBrushRadiusPx,
        blurBrushKernel: settings.blurBrushKernel ?? 'gaussian',
        blurBrushSigmaX,
        blurBrushSigmaY,
        zBlurRadiusLayers,
        zBlurKernel: settings.zBlurKernel ?? 'box',
        zBlurSigma,
        zBlendLookBack,
        aaOnSupports: Boolean(settings.aaOnSupports),
        tipOffsetMm: effectiveTipOffset,
        tipOffsetMode: settings.tipOffsetMode ?? 'disabled',
    };
}
