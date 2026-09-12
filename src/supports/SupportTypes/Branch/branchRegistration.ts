import { registerSettingsInference } from '../../supportTypeRegistry';
import { mergeSettingsWithDefaults, type SupportSettings } from '../../Settings/types';
import type { Branch } from '../../types';

function inferSettingsFromBranch(branch: Branch, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = branch.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;
    const shaftDiameter = branch.segments[0]?.diameter ?? merged.shaft.diameterMm;

    return {
        ...merged,
        tip: {
            ...merged.tip,
            contactDiameterMm: coneProfile?.contactDiameterMm ?? merged.tip.contactDiameterMm,
            bodyDiameterMm: coneProfile?.bodyDiameterMm ?? merged.tip.bodyDiameterMm,
            lengthMm: coneProfile?.lengthMm ?? merged.tip.lengthMm,
            penetrationMm: coneProfile?.penetrationMm ?? merged.tip.penetrationMm,
            diskThicknessMm: diskConeProfile?.diskThicknessMm ?? merged.tip.diskThicknessMm,
            maxStandoffMm: diskConeProfile?.maxStandoffMm ?? merged.tip.maxStandoffMm,
            standoffAngleThreshold: diskConeProfile?.standoffAngleThreshold ?? merged.tip.standoffAngleThreshold,
        },
        shaft: {
            ...merged.shaft,
            diameterMm: shaftDiameter,
            secondaryDiameterMm: shaftDiameter,
        },
    };
}

registerSettingsInference<Branch, SupportSettings, SupportSettings>('branch', inferSettingsFromBranch);
