import type { NanoDlpBasicSection, NanoDlpPrimaryEditField } from './types';

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
export const NANODLP_PRIMARY_EDIT_FIELDS: NanoDlpPrimaryEditField[] = [
  {
    key: 'Depth',
    label: 'Layer Thickness (μm)',
    aliases: ['Depth', 'depth', 'LayerHeight', 'layerHeight', 'SliceHeight', 'sliceHeight'],
    defaultValue: 50,
    description: 'Thickness of each printed layer. Lower values increase detail but add print time.',
  },
  {
    key: 'SupportCureTime',
    label: 'Burn-In Layer Cure Time (s)',
    aliases: ['SupportCureTime', 'supportCureTime', 'burn_in_cure_time', 'BurnInCureTime', 'BottomCureTime'],
    defaultValue: 10,
    description: 'Exposure time used for the first burn-in layers to ensure plate adhesion.',
  },
  {
    key: 'SupportLayerNumber',
    label: 'Burn-In Layer Count',
    aliases: ['SupportLayerNumber', 'supportLayerNumber', 'burn_in_count', 'BottomLayerCount'],
    defaultValue: 3,
    description: 'How many initial layers use burn-in exposure settings.',
  },
  {
    key: 'TransitionalLayer',
    label: 'Transitional Layers',
    aliases: ['TransitionalLayer', 'transitionalLayer', 'TransitionLayerCount'],
    defaultValue: 0,
    description: 'Number of blend layers between burn-in and normal exposure.',
  },
  {
    key: 'LightPWM',
    label: 'UV-LED PWM Value (%)',
    aliases: ['LightPWM', 'lightPWM', 'Pwm', 'PWM'],
    defaultValue: 100,
    description: 'Relative UV power level. Lower values reduce intensity and can require longer exposure.',
  },
  {
    key: 'SupportBeforeWait',
    label: 'Bottom Wait Before Print (s)',
    aliases: ['SupportBeforeWait', 'supportBeforeWait', 'BottomWaitBeforePrint'],
    defaultValue: 0,
    description: 'Pause before exposing burn-in layers, useful for resin settling.',
  },
  {
    key: 'SupportWaitAfterPrint',
    label: 'Bottom Wait After Print (s)',
    aliases: ['SupportWaitAfterPrint', 'supportWaitAfterPrint', 'BottomWaitAfterPrint'],
    defaultValue: 1,
    description: 'Pause after burn-in exposure and before movement.',
  },
  {
    key: 'SupportWaitAfterLift',
    label: 'Bottom Wait After Lift (s)',
    aliases: ['SupportWaitAfterLift', 'supportWaitAfterLift', 'BottomWaitAfterLift'],
    defaultValue: 0,
    description: 'Pause after lifting burn-in layers and before the next step.',
  },
  {
    key: 'SupportWaitHeight',
    label: 'Bottom Lift Distance (mm)',
    aliases: ['SupportWaitHeight', 'supportWaitHeight', 'BottomLiftDistance', 'BottomLiftHeight'],
    defaultValue: 6,
    description: 'Lift height used for burn-in layers after exposure.',
  },
  {
    key: 'CureTime',
    label: 'Normal Layer Cure Time (s)',
    aliases: ['CureTime', 'cureTime', 'normal_cure_time', 'NormalExposure', 'normalExposure'],
    defaultValue: 8,
    description: 'Exposure time used for standard (non burn-in) layers.',
  },
  {
    key: 'BeforeWait',
    label: 'Wait Before Print (s)',
    aliases: ['BeforeWait', 'beforeWait', 'WaitBeforePrint'],
    defaultValue: 0,
    description: 'Pause before normal layer exposure.',
  },
  {
    key: 'WaitAfterPrint',
    label: 'Wait After Print (s)',
    aliases: ['WaitAfterPrint', 'waitAfterPrint', 'wait_after_print'],
    defaultValue: 0,
    description: 'Pause after normal exposure and before lift/retract.',
  },
  {
    key: 'WaitAfterLift',
    label: 'Wait After Lift (s)',
    aliases: ['WaitAfterLift', 'waitAfterLift', 'wait_after_life', 'wait_after_lift'],
    defaultValue: 0,
    description: 'Pause after normal lift movement and before next layer.',
  },
  {
    key: 'WaitHeight',
    label: 'Normal Lift Distance (mm)',
    aliases: ['WaitHeight', 'waitHeight', 'lift_after_print', 'LiftAfterPrint', 'ZLiftDistance', 'NormalLiftDistance'],
    defaultValue: 5,
    description: 'Lift height used for normal layers after exposure.',
  },
];

/**
 * Basic-tab layout grouping for curated primary fields.
 */
export const NANODLP_BASIC_SECTIONS: NanoDlpBasicSection[] = [
  {
    id: 'layer',
    title: 'Layer Details',
    keys: ['Depth', 'SupportLayerNumber', 'TransitionalLayer', 'LightPWM'],
  },
  {
    id: 'exposure',
    title: 'Exposure',
    keys: ['SupportCureTime', 'CureTime'],
  },
  {
    id: 'timing',
    title: 'Wait Timing',
    keys: [
      'SupportBeforeWait',
      'SupportWaitAfterPrint',
      'SupportWaitAfterLift',
      'BeforeWait',
      'WaitAfterPrint',
      'WaitAfterLift',
    ],
  },
  {
    id: 'movement',
    title: 'Lift Distances',
    keys: ['SupportWaitHeight', 'WaitHeight'],
  },
];