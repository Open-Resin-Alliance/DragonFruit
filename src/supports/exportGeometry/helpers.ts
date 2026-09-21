import * as THREE from 'three';

import { calculateTipOffset } from '../rendering/calculateTipOffset';
import { getRaftSettingsForModel } from '../Rafts/Crenelated/RaftState';
import type { Segment, Vec3 } from '../types';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { SupportGeometryGenerator } from './SupportGeometryGenerator';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone';
import { getActiveMaterialProfile, getActivePrinterProfile } from '@/features/profiles/profileStore';

/**
 * The pieces every type's export geometry shares.
 *
 * One type's builder lives in that type's folder (see `seam.ts`); these are the
 * parts that are the same whatever is being exported.
 */

/** The anti-aliasing standoff applied to a contact primitive, in mm. */
export function globalPenetrationMm(): number {
    const material = getActiveMaterialProfile();
    const printer = getActivePrinterProfile();
    if (material && printer) {
        const pxX = printer.pixelSize?.x
            ? printer.pixelSize.x / 1000
            : (printer.buildVolumeMm?.width ?? 143) / (printer.display?.resolutionX ?? 2560);
        const pxY = printer.pixelSize?.y
            ? printer.pixelSize.y / 1000
            : (printer.buildVolumeMm?.depth ?? 89) / (printer.display?.resolutionY ?? 1620);
        return calculateTipOffset(material.antiAliasingSettings, material.layerHeightMm, pxX, pxY);
    }
    return 0;
}

/** Stamps the model a group belongs to, for the consumer's per-model filtering. */
export function addModelMetadata(object: THREE.Object3D, modelId: string | null | undefined): void {
    object.userData = {
        ...object.userData,
        modelId: modelId ?? null,
    };
}

/** The raft geometry a plate-rooted support stands on, when the model has any. */
export function raftSettingsFor(modelId: string | null | undefined) {
    return modelId ? getRaftSettingsForModel(modelId) : undefined;
}

/** Contact cone plus its disk, as one pair of children. */
export function appendConeGeometry(group: THREE.Group, cone: ContactCone): void {
    const pen = globalPenetrationMm();
    group.add(SupportGeometryGenerator.generateConeMesh(cone, pen));

    const diskGroup = SupportGeometryGenerator.generateContactDiskMesh(cone, pen);
    if (diskGroup.children.length > 0) {
        group.add(diskGroup);
    }
}

/** One segment's shaft, straight or bezier, as the segment declares. */
export function appendShafts(group: THREE.Group, segment: Segment, start: Vec3, end: Vec3): void {
    const meshes = SupportGeometryGenerator.generateSegmentShaftMeshes(
        segment,
        new THREE.Vector3(start.x, start.y, start.z),
        new THREE.Vector3(end.x, end.y, end.z),
    );
    for (const mesh of meshes) {
        group.add(mesh);
    }
}

// The toolkit a type's export builder draws with. Re-exported so a type folder
// has one import for its export geometry rather than four reaching across the
// tree, and so the generator can move without touching eight folders.
export { SupportGeometryGenerator, getFinalSocketPosition };
