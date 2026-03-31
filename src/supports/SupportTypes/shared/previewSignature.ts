import type { Vec3 } from '../../types';

const PREVIEW_SIGNATURE_SCALE = 1000;

export function quantizePreviewValue(value: number) {
    return Math.round(value * PREVIEW_SIGNATURE_SCALE) / PREVIEW_SIGNATURE_SCALE;
}

export function previewVecKey(vec: Vec3 | null | undefined) {
    if (!vec) return 'null';
    return `${quantizePreviewValue(vec.x)}:${quantizePreviewValue(vec.y)}:${quantizePreviewValue(vec.z)}`;
}

export function previewNormalKey(vec: Vec3 | null | undefined) {
    return previewVecKey(vec);
}
