/**
 * The Auto Support settings dialog, read as questions rather than as pipeline
 * phases.
 *
 * This module is the catalogue: the sections a control belongs to, the label and
 * tooltip of every control, and the two derived tables the dialog renders from.
 * It is the single place the control-to-section mapping is written down — move or
 * add a control here, never by editing the dialog's JSX.
 *
 * It imports nothing from React and nothing from the store, which is what lets a
 * component test read the same tables the dialog renders.
 */
import type { CSSProperties } from 'react';
import { msg } from '@lingui/core/macro';
import { DIAGNOSTIC_AUTO_SUPPORT_KEYS, type AutoSupportDiagnosticKey } from '@/supports/autoSupport/settings';
import type { MessageDescriptor } from '@lingui/core';
import {
  AUTO_SUPPORT_CONSTRAINTS,
  type NumericAutoSupportSettingKey,
} from '@/supports/autoSupport/settings';

/** The panel's inset card, shared by the floating panel and the settings dialog. */
export const AUTO_SUPPORT_SECTION_CARD: CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-1)',
};

/**
 * The dialog's sections, in reading order. `debug` is the last one and renders
 * as a collapsed disclosure, so a user changing how supports are made never
 * scrolls past a debug switch to reach the fields they came for.
 */
export type AutoSupportSectionKey =
  | 'detection'
  | 'distribution'
  | 'density'
  | 'stability'
  | 'postProcessing'
  | 'debug';

export type AutoSupportSectionDef = {
  key: AutoSupportSectionKey;
  label: MessageDescriptor;
  /** The card's one-line description, under the uppercase header. Optional: the
   *  calibration card carries none. */
  subtitle?: MessageDescriptor;
  /** The long form of the subtitle, kept as the header's `title`. */
  hint: MessageDescriptor;
};

/** The sections that hold the ordinary run policy, in reading order. */
const POLICY_SECTIONS: ReadonlyArray<AutoSupportSectionDef> = [
  {
    key: 'detection',
    label: msg`Detection`,
    subtitle: msg`What needs support, and how close is too close`,
    hint: msg`What counts as a support-needing surface, and how tightly neighbouring detections merge`,
  },
  {
    key: 'distribution',
    label: msg`Distribution`,
    subtitle: msg`Where contacts land, and how far members fan`,
    hint: msg`How a region's contacts scatter across it, and how far leaves fan out from a trunk`,
  },
  {
    key: 'density',
    label: msg`Density & Sizing`,
    subtitle: msg`How many supports, and how thick`,
    hint: msg`How dense and how thick the supports are`,
  },
  {
    key: 'stability',
    label: msg`Stability`,
    subtitle: msg`Held against toppling and peel`,
    hint: msg`How the part is held against toppling and peel — self-support angle, stabilization anchors and minima reinforcement`,
  },
  {
    key: 'postProcessing',
    label: msg`Post-processing`,
    subtitle: msg`The passes after placement`,
    hint: msg`Passes that run after placement — how much one trunk may carry, and the coverage the gap-filler must reach`,
  },
];

/**
 * The calibration group — the last card in the dialog, framed in the warning tone
 * rather than hidden. The debug switches and the run diagnostics are a card of
 * their own (`DEBUG_DIAGNOSTICS_HEADING`); this is the sizing constants.
 */
export const AUTO_SUPPORT_ADVANCED_SECTION: AutoSupportSectionDef = {
  key: 'debug',
  label: msg`Advanced (calibration)`,
  hint: msg`The sizing constants the engine ships with. They are stored per preset.`,
};

/** Every section, in reading order — the policy cards, then the disclosure. */
export const AUTO_SUPPORT_SECTIONS: ReadonlyArray<AutoSupportSectionDef> = [
  ...POLICY_SECTIONS,
  AUTO_SUPPORT_ADVANCED_SECTION,
];

/** The policy sections the dialog renders as field cards, in reading order. */
export const AUTO_SUPPORT_POLICY_SECTIONS = POLICY_SECTIONS;

export type KnobDef = {
  key: NumericAutoSupportSettingKey;
  /** Which section answers the question this knob belongs to. */
  section: AutoSupportSectionKey;
  label: MessageDescriptor;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: MessageDescriptor;
};

export type ToggleDef = {
  key: BooleanAutoSupportSettingKey;
  section: AutoSupportSectionKey;
  label: MessageDescriptor;
  hint: MessageDescriptor;
};

/** The `autoSupport` block's boolean keys the dialog exposes. */
export type BooleanAutoSupportSettingKey =
  | 'enabled'
  | 'prioritizeIntersection'
  | 'stabilizationEnabled'
  | 'minimaReinforcementEnabled'
  | 'debugSupportOriginColors'
  | 'debugSkipAutoBracing'
  | 'modelScaleEnabled';

/** The numeric half of the six Advanced calibration keys. */
export const ADVANCED_CALIBRATION_NUMERIC_KEYS = [
  'tipContactMarginScale',
  'memberHostShaftRatio',
  'modelSizeFactorCap',
  'modelLoadFactorCap',
  'heightFactorCap',
] as const satisfies readonly NumericAutoSupportSettingKey[];

const KNOBS: readonly KnobDef[] = [
  // Detection — what needs support.
  { key: 'minIslandAreaMm2', section: 'detection', label: msg`Min Island Size`, min: 0.01, max: 2, step: 0.01, unit: 'mm²', hint: msg`Skip detected areas smaller than this — tiny specks rarely need supports` },
  { key: 'tipInfluenceRadiusMm', section: 'detection', label: msg`Merge Radius`, min: 0.1, max: 10, step: 0.1, unit: 'mm', hint: msg`A candidate within this 3D distance of an existing support merges into it instead of starting a new trunk` },
  // Distribution — where contacts land and how members fan out.
  { key: 'leafFanRadiusMm', section: 'distribution', label: msg`Fan Reach`, min: 2, max: 15, step: 0.5, unit: 'mm', hint: msg`Max horizontal distance a fan-out leaf may span from a trunk shaft` },
  { key: 'leafFanMaxAngleDeg', section: 'distribution', label: msg`Fan Angle`, min: 20, max: 80, step: 5, unit: '°', hint: msg`Max angle from vertical for fan-out leaves` },
  // Density & Sizing — how many and how thick.
  { key: 'areaPerSupportMm2', section: 'density', label: msg`Support Density`, min: 1, max: 30, step: 0.5, unit: 'mm²', hint: msg`Projected area each support carries — smaller = more, tighter supports (grid spacing ≈ √value)` },
  { key: 'sizeScale', section: 'density', label: msg`Support Size`, min: 0.5, max: 2, step: 0.05, unit: '×', hint: msg`Master multiplier over the preset sizing bands — thicker or thinner everywhere` },
  { key: 'gridAreaThresholdMm2', section: 'density', label: msg`Grid Threshold`, min: 5, max: 200, step: 5, unit: 'mm²', hint: msg`Flat regions at/above this area get a full grid; smaller regions get a single support` },
  { key: 'flatDensityBoost', section: 'density', label: msg`Flat Boost`, min: 0.5, max: 1, step: 0.05, unit: '×', hint: msg`Grid spacing on flat ceilings — lower = denser supports on anchor surfaces (0.7 = ~2× the supports)` },
  { key: 'slopeRelaxFactor', section: 'density', label: msg`Slope Relax`, min: 1, max: 2, step: 0.1, unit: '×', hint: msg`Grid spacing on slopes at the self-support angle — higher = sparser` },
  { key: 'suctionAreaExponent', section: 'density', label: msg`Suction Scale`, min: 0, max: 0.4, step: 0.05, unit: '', hint: msg`How strongly flat density grows with region area — large shallow ceilings carry more peel. 0 = off` },
  // Stability — will it stay put, and stay straight.
  { key: 'overhangSelfSupportAngleDeg', section: 'stability', label: msg`Self-Support Angle`, min: 20, max: 75, step: 5, unit: '°', hint: msg`Surfaces flatter than this angle get supports (resin standard: 45°). Higher = fewer, mostly on the steepest parts.` },
  // Post-processing — the passes after placement.
  { key: 'maxAttachmentsPerTrunk', section: 'postProcessing', label: msg`Branches per Column`, min: 2, max: 50, step: 1, unit: '', hint: msg`Max branches + leaves one trunk may carry before new trunks are started — the cap on chunk consolidation` },
  { key: 'coverageTargetPercent', section: 'postProcessing', label: msg`Coverage Target`, min: 75, max: 100, step: 5, unit: '%', hint: msg`How much of each region's footprint the grid must cover before gap-filling stops` },
];

/**
 * The Advanced (calibration) fields. Bounds come from `AUTO_SUPPORT_CONSTRAINTS`,
 * and each field's tooltip names the value the engine ships with, so the number a
 * reader sees and the number the engine reads cannot drift apart.
 */
const CALIBRATION_KNOB_SOURCE: ReadonlyArray<{
  key: NumericAutoSupportSettingKey;
  label: MessageDescriptor;
  hint: MessageDescriptor;
}> = [
  { key: 'tipContactMarginScale', label: msg`Tip Fit Margin`, hint: msg`How much of the free width a contact tip may occupy. The default, 0.9, keeps the disc just inside the feature it lands on; lower values shrink every tip on a feature narrower than the band tip.` },
  { key: 'memberHostShaftRatio', label: msg`Member / Host Ratio`, hint: msg`Least diameter a branch or leaf takes as a fraction of the trunk it grows from. The default, 0.7, keeps a hosted member a step below its host instead of a needle beside it.` },
  { key: 'modelSizeFactorCap', label: msg`Model Size Cap`, hint: msg`Ceiling of the size factor derived from the model's bounding-box diagonal. The default, 1.45, bounds how much a large part's shafts thicken.` },
  { key: 'modelLoadFactorCap', label: msg`Model Load Cap`, hint: msg`Ceiling of the load factor derived from resin mass per support. The default, 1.3, bounds how much a heavy part's shafts thicken.` },
  { key: 'heightFactorCap', label: msg`Height Factor Cap`, hint: msg`Ceiling of the height factor for a tall column, whose buckling load falls with height. The default, 1.35, bounds how much a tall support thickens.` },
];

export const ADVANCED_CALIBRATION_KNOBS: readonly KnobDef[] = CALIBRATION_KNOB_SOURCE.map((knob) => {
  const constraint = AUTO_SUPPORT_CONSTRAINTS[knob.key];
  return {
    ...knob,
    section: 'debug' as const,
    min: constraint.min,
    max: constraint.max,
    step: constraint.step,
    unit: '',
  };
});

const TOGGLES: readonly ToggleDef[] = [
  { key: 'enabled', section: 'detection', label: msg`Enabled`, hint: msg`Generate supports automatically on scan` },
  { key: 'prioritizeIntersection', section: 'detection', label: msg`Prioritize Dual`, hint: msg`Islands found by BOTH the slice and mesh scans are placed first (they are the most certain)` },
  { key: 'stabilizationEnabled', section: 'stability', label: msg`Stabilization Anchors`, hint: msg`Add contacts along the edge or corner a pose bears on, so a leaning part is held against toppling and peel (default on)` },
  { key: 'minimaReinforcementEnabled', section: 'stability', label: msg`Minima Reinforcement`, hint: msg`Ring each mesh minima with contacts on its own flank, so a section starts on a base instead of a needle (default on)` },
  { key: 'debugSupportOriginColors', section: 'debug', label: msg`Origin Colors`, hint: msg`Debug: color supports by origin — stump (red), overhang (orange), island (blue), standalone (purple), reinforcement (teal)` },
  { key: 'debugSkipAutoBracing', section: 'debug', label: msg`No Brace`, hint: msg`Debug: skip automatic bracing for this run` },
];

/**
 * The sixth calibration key, and the only boolean one: it belongs in the
 * Advanced group beside the five caps it switches off, not with the debug
 * toggles or the ordinary preferences.
 */
export const ADVANCED_CALIBRATION_TOGGLE: ToggleDef = {
  key: 'modelScaleEnabled',
  section: 'debug',
  label: msg`Model-Scale Sizing`,
  hint: msg`Master switch for the run-level size, load and height factors. Off pins all three to ×1, so sizing is the active band plus the local terms alone (default: on).`,
};

/** The controls of one section, in table order, with every section key present. */
function groupBySection<T extends { section: AutoSupportSectionKey }>(items: readonly T[]): Record<AutoSupportSectionKey, T[]> {
  const grouped = Object.fromEntries(
    AUTO_SUPPORT_SECTIONS.map((section) => [section.key, [] as T[]]),
  ) as Record<AutoSupportSectionKey, T[]>;
  for (const item of items) grouped[item.section].push(item);
  return grouped;
}

export const KNOBS_BY_SECTION = groupBySection(KNOBS);
export const TOGGLES_BY_SECTION = groupBySection(TOGGLES);

/**
 * The debug section's toggles, typed as the block's diagnostics.
 *
 * The Diagnostics card renders these straight from the store rather than from
 * the dialog's draft (they apply the moment they are flipped), so the card needs
 * the narrow key type. The two lists are the same list by construction: the
 * panel test fails if a debug toggle is added that is not a diagnostic, rather
 * than letting it disappear from the card.
 */
export const DIAGNOSTIC_TOGGLES: ReadonlyArray<ToggleDef & { key: AutoSupportDiagnosticKey }> =
    TOGGLES_BY_SECTION.debug.filter(
        (toggle): toggle is ToggleDef & { key: AutoSupportDiagnosticKey } =>
            (DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes(toggle.key),
    );

/** The diagnostics card's header — the debug switches and the last run's report. */
export const DEBUG_DIAGNOSTICS_HEADING = msg`Diagnostics`;

/** Tooltips for the tier row, by built-in preset id (the built-ins the store ships). */
export const TIER_HINTS: Record<string, MessageDescriptor> = {
  light: msg`Sparse supports — the detail sizing band`,
  medium: msg`Balanced supports — the structure sizing band`,
  heavy: msg`Dense supports — the anchor sizing band`,
};

/** The Sizing Tier control's own label and tooltip. */
export const SIZING_TIER_FIELD = {
  label: msg`Sizing Tier`,
  hint: msg`The Support Studio preset whose tip, shaft and root numbers size this run. Editing that preset changes what auto-support prints — Duplicate it first if you only want to change the run.`,
} as const;

/**
 * Why a built-in profile's fields are locked, shown on hover.
 *
 * A built-in cannot be saved over — the store refuses — so an edit made on one
 * could never be kept. The fields are disabled and say this instead of collecting a
 * change that saving would then silently drop. Shared by every locked control in the
 * dialog, and carried by the *wrapping* element as well as the control: a disabled
 * input receives no pointer events, so its own tooltip never appears.
 */
export const LOCKED_PROFILE_HINT = msg`This is a built-in profile, so its fields are fixed. Duplicate it and edit the copy — custom settings belong in a custom profile.`;
