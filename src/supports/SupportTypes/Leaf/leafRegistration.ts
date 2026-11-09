import * as THREE from 'three';
import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, appendConeGeometry } from '../../exportGeometry/helpers';
import { registerSettingsInference } from '../../supportTypeRegistry';
import { mergeSettingsWithDefaults, type SupportSettings } from '../../Settings/types';
import type { Leaf } from '../../types';
import './leafProxyGeometry';
import './leafMarqueeShape';

function inferSettingsFromLeaf(leaf: Leaf, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = leaf.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;

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
    };
}

registerSettingsInference<Leaf, SupportSettings, SupportSettings>('leaf', inferSettingsFromLeaf);

// A leaf carries a contact cone and no shaft of its own, so its export geometry
// is the cone and the disk under it.
registerSupportExportGroup<Leaf>('leaf', (leaf, context) => {
    const modelId = leaf.modelId ?? context.modelIdOf(leaf.parentKnotId);
    const group = new THREE.Group();
    addModelMetadata(group, modelId);
    appendConeGeometry(group, leaf.contactCone);
    return group;
});

// Registered here rather than in the store's own list: a leaf reshapes its contact cone, which the generic path does not do.
import './leafSettle';
