import type { NanoDlpAdvancedSectionDef } from './types';

/**
 * Athena NanoDLP advanced-field classification module.
 *
 * Responsibilities:
 * - decide which raw NanoDLP keys are editable advanced controls,
 * - map those keys into section buckets for UI presentation,
 * - provide user-facing help text for advanced controls.
 */

/**
 * Keyword allowlist for "sensible" advanced fields.
 *
 * Purpose: avoid exposing noisy metadata keys as editable controls while still
 * admitting printer-specific advanced tuning parameters.
 */
const NANODLP_ADVANCED_ALLOWED_KEYWORDS = [
  'slowlift',
  'slowretract',
  'liftspeed',
  'retractspeed',
  'antialias',
  'elephant',
  'middle',
  'multicure',
  'adapt',
  'peel',
  'crash',
  'dynamicwait',
  'resinlevel',
  'heater',
  'temperature',
  'pw',
  'pwm',
  'detect',
  'slope',
  'threshold',
  'mode',
  'gap',
  'pass',
  'fss',
  'hatch',
  'erode',
  'autolevel',
  'flow',
  'cd',
  'efm',
];

/**
 * Metadata keys that should never appear as editable controls.
 */
const NANODLP_NON_EDITABLE_META_KEYS = new Set([
  'id',
  'profileid',
  'profile_id',
  'name',
  'resinname',
  'title',
  'desc',
  'description',
  'path',
  'file',
  'price',
  'brand',
  'type',
  'locked',
]);

/**
 * Named section buckets for organizing advanced controls in the modal UI.
 */
export const NANODLP_ADVANCED_SECTIONS: NanoDlpAdvancedSectionDef[] = [
  {
    id: 'speed',
    title: 'Lift / Retract Speeds',
    keywords: ['lift', 'retract', 'speed', 'slow', 'full'],
  },
  {
    id: 'detection',
    title: 'Detection & Safety',
    keywords: ['detect', 'crash', 'peel', 'resinlevel', 'threshold', 'slope', 'mode', 'fss', 'autolevel'],
  },
  {
    id: 'slicer',
    title: 'Slicer & Quality',
    keywords: ['antialias', 'adapt', 'multicure', 'gap', 'pass', 'middle', 'hatch', 'elephant', 'erode'],
  },
  {
    id: 'timing',
    title: 'Advanced Timing',
    keywords: ['dynamicwait', 'wait', 'time', 'exposure', 'flow'],
  },
  {
    id: 'thermal',
    title: 'Thermal / Heater',
    keywords: ['heater', 'temperature', 'temp'],
  },
];

/**
 * Decide whether a raw profile key should be treated as an editable advanced
 * parameter.
 */
export function isSensibleNanoDlpAdvancedField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_\-\s]+/g, '');
  if (!normalized) return false;
  if (NANODLP_NON_EDITABLE_META_KEYS.has(normalized)) return false;
  return NANODLP_ADVANCED_ALLOWED_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Resolve section id for an advanced key based on keyword matching.
 */
export function resolveNanoDlpAdvancedSectionId(key: string): string {
  const normalized = key.toLowerCase().replace(/[_\-\s]+/g, '');
  const matched = NANODLP_ADVANCED_SECTIONS.find((section) => (
    section.keywords.some((keyword) => normalized.includes(keyword))
  ));
  return matched?.id ?? 'other';
}

/**
 * Human-friendly helper text for advanced controls.
 *
 * These descriptions are intentionally concise and safety-oriented, guiding
 * users to validate changes with test prints.
 */
export function getNanoDlpFieldHelpText(fieldKey: string): string {
  const key = fieldKey.toLowerCase().replace(/[_\-\s]+/g, '');

  if (key.includes('antialias')) return 'Anti-aliasing smooths edges and curved surfaces; higher smoothing can increase processing time.';
  if (key.includes('elephant')) return 'Elephant-foot options compensate for base over-cure that can widen first layers.';
  if (key.includes('multicure') || key.includes('pass')) return 'Multi-cure controls multiple exposure passes per layer for quality vs speed tuning.';
  if (key.includes('adapt')) return 'Adaptive slicing adjusts layer strategy by geometry to balance detail and speed.';
  if (key.includes('lift') || key.includes('retract') || key.includes('speed')) return 'Movement parameters control peel mechanics; too aggressive values can increase failure risk.';
  if (key.includes('dynamicwait') || key.includes('wait') || key.includes('time')) return 'Timing controls resin settle and peel recovery; adjust for reliability and surface quality.';
  if (key.includes('detect') || key.includes('crash') || key.includes('peel') || key.includes('resinlevel')) return 'Detection settings affect safety checks and automatic failure handling behavior.';
  if (key.includes('heater') || key.includes('temp')) return 'Thermal settings manage resin preheat and stabilization before or during prints.';
  if (key.includes('threshold') || key.includes('slope')) return 'Threshold/slope values tune trigger sensitivity for detection systems.';

  return 'Advanced parameter from the printer profile. Change carefully and validate with a small test print.';
}