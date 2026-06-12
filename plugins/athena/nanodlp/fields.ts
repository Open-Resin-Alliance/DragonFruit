import nanoDlpMaterialSettings from './materialSettings.json';
import type { NanoDlpBasicSection, NanoDlpPrimaryEditField, NanoDlpRemoteMaterialSettingsSchema } from './types';

/**
 * Athena NanoDLP curated field catalog.
 *
 * This module is the source of truth for:
 * - Basic-tab editable controls,
 * - per-field aliases/defaults/descriptions,
 * - basic grouping layout used by settings UI.
 */

/**
 * Curated Basic-tab field definitions.
 *
 * These are intentionally high-value controls that most users need frequently.
 * Advanced and vendor-specific parameters are handled separately.
 */
const schema = nanoDlpMaterialSettings as NanoDlpRemoteMaterialSettingsSchema;

export const NANODLP_PRIMARY_EDIT_FIELDS: NanoDlpPrimaryEditField[] = schema.primaryEditFields;

/**
 * Basic-tab layout grouping for curated primary fields.
 */
export const NANODLP_BASIC_SECTIONS: NanoDlpBasicSection[] = schema.basicSections;