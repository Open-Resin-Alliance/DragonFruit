/**
 * Loads each type's renderer, which registers its detail renderer into the
 * seam. Kept as one import site so the shared renderer pulls in the whole set
 * at once -- and so a test can wire the seam without importing the whole
 * renderer. Mirrors `previewGeometry/registerBuiltinPreviewBuilders`.
 *
 * Loaded by the RENDERER, not the store: each entry closes over live scene
 * state, and pulling render-layer modules into the store's load reaches back
 * into the store it is still building.
 *
 * The imports are generated from the type folders, so no type's name is written
 * here in a path.
 */
import { detailRenderersMissingTypes } from './seam';
import './generatedDetailRendererImports';

// Every declared type must have registered. One that has not draws nothing and
// reports nothing, so this fails the load instead.
const missingRenderers = detailRenderersMissingTypes();
if (missingRenderers.length > 0) {
    throw new Error(
        `support types have no registered detail renderer: ${missingRenderers.join(', ')}. `
        + 'Add an import above -- a module nothing imports never registers.',
    );
}
