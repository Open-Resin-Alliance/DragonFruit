/**
 * Serializable form of one model's merged support geometry.
 *
 * The merge itself is `buildMergedSupportGeometry`; this module only unwraps
 * the `BufferGeometry` into arrays that can cross a worker boundary. Keeping it
 * separate means the worker and the main-thread fallback run the exact same
 * builder.
 */

import { buildMergedSupportGeometry } from './mergedSupportGeometry';
import type { ProxyModelGeometry } from '@/supports/SupportProxyMeshLayer';

export type MergedSupportGroup = {
    start: number;
    count: number;
    materialIndex: number;
};

export type MergedSupportBuildData = {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    groups: MergedSupportGroup[];
    triangles: number;
    modelId?: string;
    boundingBox?: [number, number, number, number, number, number];
    boundingSphere?: [number, number, number, number];
};

/** Build one model's merged support arrays. Pure apart from the geometry caches. */
export function buildMergedSupportData(model: ProxyModelGeometry): MergedSupportBuildData {
    const built = buildMergedSupportGeometry(model);
    const geometry = built.geometry;
    const position = geometry.getAttribute('position') as { array: Float32Array };
    const normal = geometry.getAttribute('normal') as { array: Float32Array };
    const index = geometry.getIndex() as { array: Uint32Array } | null;
    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;

    return {
        positions: position.array,
        normals: normal.array,
        indices: index?.array ?? new Uint32Array(0),
        groups: geometry.groups.map((group) => ({
            start: group.start,
            count: group.count,
            materialIndex: group.materialIndex ?? 0,
        })),
        triangles: built.triangles,
        ...(built.modelId != null ? { modelId: built.modelId } : {}),
        ...(box ? { boundingBox: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z] as [number, number, number, number, number, number] } : {}),
        ...(sphere ? { boundingSphere: [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius] as [number, number, number, number] } : {}),
    };
}
