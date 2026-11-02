import type { MaterialProfile } from './profileStore';

/**
 * The three values a Multi-Tank print needs identical across every tank: they decide
 * how many films a print has and when burn-in ends, so two tanks disagreeing would
 * give the same model two different layer stacks.
 */
export type TankMaterialShape = {
    layerHeightMm: number;
    initialLayers: number;
    transitionLayers: number;
};

type TankMaterialSource = Pick<
    MaterialProfile,
    'layerHeightMm' | 'bottomLayerCount' | 'localSettingsByOutput'
>;

const TRANSITION_LAYER_KEYS = ['traLayers', 'transitionLayers', 'transitionLayerCount'];

function transitionLayersFor(material: TankMaterialSource, outputFormat?: string): number {
    const byOutput = material.localSettingsByOutput;
    if (!byOutput) return 0;
    const normalized = outputFormat?.trim();
    const settings = (normalized ? byOutput[normalized] : undefined)
        ?? (normalized ? byOutput[normalized.replace(/^\./, '')] : undefined)
        ?? {};
    for (const key of TRANSITION_LAYER_KEYS) {
        const value = Number(settings[key]);
        if (Number.isFinite(value)) return value;
    }
    return 0;
}

export function tankMaterialShape(
    material: TankMaterialSource,
    outputFormat?: string,
): TankMaterialShape {
    return {
        layerHeightMm: Number(material.layerHeightMm),
        initialLayers: Number(material.bottomLayerCount),
        transitionLayers: transitionLayersFor(material, outputFormat),
    };
}

function closeEnough(left: number, right: number): boolean {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-6;
}

/** Whether two assigned tank materials would produce the same layer stack. */
export function tankMaterialsDisagree(
    left: TankMaterialSource,
    right: TankMaterialSource,
    outputFormat?: string,
): boolean {
    const a = tankMaterialShape(left, outputFormat);
    const b = tankMaterialShape(right, outputFormat);
    return !closeEnough(a.layerHeightMm, b.layerHeightMm)
        || !closeEnough(a.initialLayers, b.initialLayers)
        || !closeEnough(a.transitionLayers, b.transitionLayers);
}
