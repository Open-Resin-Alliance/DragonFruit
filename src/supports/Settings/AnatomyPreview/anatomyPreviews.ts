import { getSupportTypeDescriptor } from '../../supportTypeRegistry';
import type { SidebarPanel } from '../sidebarPanels';

// The preview registry lives in `../anatomyPreviewRegistry.ts` -- beside the
// sidebar it serves rather than inside this folder -- so that a panel's facts
// can be derived from it without the Settings layer and the previews importing
// each other in a circle.
export {
    anatomyPreviewFor,
    hasOwnAnatomyPreview,
    registerAnatomyPreview,
    type AnatomyPreviewProps,
} from '../anatomyPreviewRegistry';

/**
 * The settings group a panel's preview highlights, from the registry.
 *
 * Kept here because it is a preview concern: which settings field the anatomy
 * diagram calls out, which follows from the type's declared shape.
 */
export function anatomyPreviewFocusSetting(panel: SidebarPanel): string | null {
    const descriptor = getSupportTypeDescriptor(panel as never);
    if (!descriptor) return null;
    if (descriptor.canBeGridHost) return 'shaft.diameterMm';
    return null;
}
