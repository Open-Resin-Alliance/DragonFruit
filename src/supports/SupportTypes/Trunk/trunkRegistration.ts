import * as THREE from 'three';

import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, raftSettingsFor, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import { registerSettingsInference } from '../../supportTypeRegistry';
import { mergeSettingsWithDefaults, type SupportSettings } from '../../Settings/types';
import { getRootById } from '../../state';
import type { Roots, Trunk } from '../../types';

import './trunkProxyGeometry';
import './trunkMarqueeShape';

// A trunk's export geometry is its plate root plus the shaft above it. The root
// is looked up from the live store rather than carried on the entity, so a
// trunk whose root is gone exports nothing.
registerSupportExportGroup<Trunk>('trunk', (trunk, context) => {
    const root = context.supportState.roots[trunk.rootId];
    if (!root) return null;

    const modelId = trunk.modelId ?? root.modelId ?? null;
    const group: THREE.Group = SupportGeometryGenerator.generateSupportGroup(
        {
            id: trunk.id,
            roots: root,
            segments: trunk.segments,
            contactCone: trunk.contactCone,
        },
        raftSettingsFor(modelId),
    );
    addModelMetadata(group, modelId);
    return group;
});

function inferSettingsFromTrunk(trunk: Trunk, root: Roots | null, base?: SupportSettings): SupportSettings {
    const merged = mergeSettingsWithDefaults(base);
    const coneProfile = trunk.contactCone?.profile;
    const diskConeProfile = coneProfile?.type === 'disk' ? coneProfile : undefined;
    const shaftDiameter = trunk.baseDiameterMm ?? trunk.segments[0]?.diameter ?? merged.shaft.diameterMm;

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
        roots: {
            ...merged.roots,
            diameterMm: root?.diameter ?? merged.roots.diameterMm,
            diskHeightMm: root?.diskHeight ?? merged.roots.diskHeightMm,
            coneHeightMm: root?.coneHeight ?? merged.roots.coneHeightMm,
        },
    };
}

// A trunk's settings come partly from the plate root it owns, which the store
// holds separately -- hence the lookup rather than a pure read off the entity.
registerSettingsInference<Trunk, SupportSettings, SupportSettings>(
    'trunk',
    (trunk, base) => inferSettingsFromTrunk(trunk, getRootById(trunk.rootId) ?? null, base),
);
