import type { MaterialAntiAliasingSettings, PrinterBitDepth } from '@/features/profiles/profileStore';

export type DitherPolicyInput = {
    printerProfile: { bitDepth?: PrinterBitDepth };
    materialProfile: { antiAliasingSettings?: MaterialAntiAliasingSettings };
    ditherEnabled?: boolean;
    ditherBitDepth?: number;
    ditherDeviceGamma?: number;
};

export type EffectiveDitherPolicy = {
    ditherEnabled: boolean;
    ditherBitDepth: number;
    ditherDeviceGamma: number;
};

/**
 * Resolves the dithering policy actually handed to the slicing engine.
 *
 * Dithering trades spatial resolution for grey levels the panel cannot emit on
 * its own, so the declared panel bit depth decides it outright:
 *
 *   - below 8 bits: forced on, dithering to the panel's own depth.
 *   - 8 bits or deeper: forced off. The panel already emits the whole 8-bit
 *     ramp, so dithering could only quantize the layer *below* what the
 *     hardware supports — at the default gamma of 3.0, a 7-bit palette doubles
 *     the largest energy step between adjacent levels (1.17% -> 2.33%).
 *   - undeclared: the user's choice, at the configured bit depth.
 */
export function resolveEffectiveDitherPolicy(options: DitherPolicyInput): EffectiveDitherPolicy {
    const materialDitherEnabled = options.materialProfile.antiAliasingSettings?.ditherEnabled ?? false;
    const materialDitherBitDepth = options.materialProfile.antiAliasingSettings?.ditherBitDepth ?? 3;
    const materialDitherGamma = options.materialProfile.antiAliasingSettings?.ditherDeviceGamma ?? 3.0;

    const configuredDitherEnabled = options.ditherEnabled ?? materialDitherEnabled;
    const configuredDitherBitDepth = options.ditherBitDepth ?? materialDitherBitDepth;
    const configuredDitherGamma = options.ditherDeviceGamma ?? materialDitherGamma;

    const printerBitDepthRaw = Number(options.printerProfile.bitDepth?.bits);
    const printerBitDepth = Number.isFinite(printerBitDepthRaw)
        ? Math.round(printerBitDepthRaw)
        : null;

    const hasKnownDisplayBitDepth = printerBitDepth != null && printerBitDepth > 0;
    const displayNeedsDither = hasKnownDisplayBitDepth && printerBitDepth < 8;
    const displayCoversFullGreyscale = hasKnownDisplayBitDepth && printerBitDepth >= 8;

    const derivedBitDepth = displayNeedsDither
        ? Math.max(2, Math.min(7, printerBitDepth as number))
        : Math.max(2, Math.min(7, Math.round(configuredDitherBitDepth)));

    return {
        ditherEnabled: displayNeedsDither
            ? true
            : displayCoversFullGreyscale
                ? false
                : configuredDitherEnabled,
        ditherBitDepth: derivedBitDepth,
        ditherDeviceGamma: Math.max(0.5, Math.min(4.0, Number(configuredDitherGamma))),
    };
}
