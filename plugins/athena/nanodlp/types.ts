/**
 * Shared Athena NanoDLP type definitions.
 *
 * These types are intentionally UI-facing and used to keep Profile Settings
 * rendering logic aligned with plugin field semantics.
 */

/**
 * Canonical definition for a primary (Basic tab) NanoDLP editable field.
 *
 * - `key`: canonical outgoing key used when persisting edits.
 * - `aliases`: incoming lookup keys observed in NanoDLP profile payloads.
 * - `defaultValue`: fallback used when profile data omits this field.
 */
export type NanoDlpPrimaryEditField = {
  key: string;
  label: string;
  aliases: string[];
  defaultValue: number;
  description?: string;
};

/**
 * Material-process values consumed by DragonFruit material/profile sync flows.
 */
export type NanoDlpMaterialProcessValues = {
  layerHeightMm?: number;
  normalExposureSec?: number;
  bottomExposureSec?: number;
  bottomLayerCount?: number;
};

/**
 * Grouping model for Basic-tab field presentation.
 */
export type NanoDlpBasicSection = {
  id: string;
  title: string;
  keys: string[];
};

/**
 * Grouping model for Advanced-tab field presentation.
 */
export type NanoDlpAdvancedSectionDef = {
  id: string;
  title: string;
  keywords: string[];
};