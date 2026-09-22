import * as THREE from 'three';
import { registerSupportExportGroup } from '../../exportGeometry/seam';
import { addModelMetadata, SupportGeometryGenerator } from '../../exportGeometry/helpers';
import { registerSettingsInference } from '../../supportTypeRegistry';
import { mergeSettingsWithDefaults, type SupportSettings } from '../../Settings/types';
import type { Branch } from '../../types';
import './branchProxyGeometry';
import './branchMarqueeShape';

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

// A branch's export geometry starts at the knot it hangs from -- a `hostedBy`
// edge the registry declares -- rather than at a root, so it cannot be built
// without that host.
registerSupportExportGroup<Branch>('branch', (branch, context) => {
    const parentKnot = context.supportState.knots[branch.parentKnotId];
    if (!parentKnot) return null;

    const modelId = branch.modelId ?? context.modelIdOf(branch.parentKnotId);
    const group: THREE.Group = SupportGeometryGenerator.generateSupportGroup({
        id: branch.id,
        startPos: parentKnot.pos,
        segments: branch.segments,
        contactCone: branch.contactCone,
    });
    addModelMetadata(group, modelId);
    return group;
});
