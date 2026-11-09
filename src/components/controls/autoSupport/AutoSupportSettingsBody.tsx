"use client";

/**
 * The body of the Auto Support settings dialog: one scrolling surface of field
 * cards, the preset strip above them, and the dialog's footer.
 *
 * It is deliberately presentational — the draft it edits plus the last run's
 * diagnostics arrive as props and it owns no settings state — so the panel shell
 * can keep the dialog, the draft and the reports where they already were. Which
 * control belongs to which section is the catalogue in `autoSupportPanelTabs.ts`,
 * not this file.
 *
 * Two layout rules are load-bearing:
 *
 * - There is no tab row and no rail. With every knob a compact field instead of
 *   a slider the whole policy fits in one scroll, so navigation between sections
 *   would be a second way to reach something already on screen. The sections
 *   still order the cards, which is what keeps the dialog readable.
 * - Debug & Advanced is a closed `<details>`, last. It holds every debug switch,
 *   every diagnostic and the calibration constants, so a user changing how
 *   supports are made never scrolls past any of it.
 */
import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { CSSProperties } from 'react';
import { LabeledNumberInput, LabeledToggleInput } from '@/components/settings/profileFormAtoms';
import type { AutoSupportSettings, AutoSupportDiagnosticKey } from '@/supports/autoSupport';
import { AutoSupportPresetSelector, AutoSupportSettingsFooterActions } from './AutoSupportPresets';
import { AutoSupportSizingTierField } from './AutoSupportSizingTierField';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  ADVANCED_CALIBRATION_KNOBS,
  ADVANCED_CALIBRATION_TOGGLE,
  AUTO_SUPPORT_ADVANCED_SECTION,
  AUTO_SUPPORT_POLICY_SECTIONS,
  DEBUG_DIAGNOSTICS_HEADING,
  DIAGNOSTIC_TOGGLES,
  KNOBS_BY_SECTION,
  LOCKED_PROFILE_HINT,
  TOGGLES_BY_SECTION,
  type AutoSupportSectionDef,
  type KnobDef,
  type ToggleDef,
} from './autoSupportPanelTabs';

/** The dialog's card, the material editor's shape: uppercase header, fields under it. */
const FIELD_CARD_STYLE: CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-2)',
};

/** The number of decimals a knob's step implies. */
const decimalsForStep = (step: number) => (step < 0.1 ? 2 : step < 1 ? 1 : 0);

/**
 * A field's value as the dialog will store it: inside the range the field offers,
 * rounded to the decimals its step implies. The settings store clamps to
 * `AUTO_SUPPORT_CONSTRAINTS` on write; this keeps a typed number from showing as
 * one value and landing as another.
 */
function normalizeFieldValue(min: number, max: number, step: number, raw: number): number {
  const clamped = Math.min(max, Math.max(min, raw));
  return Number(clamped.toFixed(decimalsForStep(step)));
}

/** One numeric knob: a labelled field with the stepper, never a slider. */
function NumberField({
  knob,
  draft,
  setDraft,
  locked,
}: {
  knob: KnobDef;
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  /** The active preset is a built-in, so this field cannot be edited. */
  locked?: boolean;
}) {
  const { _ } = useLingui();
  const hint = _(knob.hint);
  const label = _(knob.label);
  // Locked, the field's help *is* the lock's: the ⓘ carries it for assistive tech,
  // the hover popover carries it for the pointer, and the browser's own `title` is
  // left off so there is one tooltip rather than two.
  const help = locked ? _(LOCKED_PROFILE_HINT) : hint;

  const field = (
    <LabeledNumberInput
      label={label}
      // The unit rides inside the field (Support Studio's convention), so the label
      // is the name alone. A knob with no unit passes none, rather than an empty box.
      unit={knob.unit || undefined}
      helpText={help}
      title={locked ? undefined : hint}
      disabled={locked}
      value={draft[knob.key]}
      step={knob.step}
      onChange={(value) => setDraft((current) => ({
        ...current,
        [knob.key]: normalizeFieldValue(knob.min, knob.max, knob.step, value),
      }))}
    />
  );

  if (!locked) return <div className="space-y-1">{field}</div>;
  // The app's own tooltip, on the whole field: a locked control is dead to the
  // pointer (hence `disabled:pointer-events-none` on it), so the wrapper is what
  // receives the hover. `[&>*]:w-full` is load-bearing: the wrapper is a flex
  // container, so without it the field's label would be a content-sized flex item and
  // the input would shrink to its intrinsic width.
  return <Tooltip content={help} fullWidth wrapperClassName="w-full [&>*]:w-full">{field}</Tooltip>;
}

/** One boolean knob, as the pill the material editor's switches use. */
function ToggleField({
  toggle,
  draft,
  setDraft,
  locked,
}: {
  toggle: ToggleDef;
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  /** The active preset is a built-in, so this field cannot be edited. */
  locked?: boolean;
}) {
  const { _ } = useLingui();
  const hint = _(toggle.hint);
  const help = locked ? _(LOCKED_PROFILE_HINT) : hint;

  const field = (
    <LabeledToggleInput
      label={_(toggle.label)}
      helpText={help}
      title={locked ? undefined : hint}
      disabled={locked}
      checked={draft[toggle.key]}
      onChange={(next) => setDraft((current) => ({ ...current, [toggle.key]: next }))}
    />
  );

  if (!locked) return <div className="space-y-1">{field}</div>;
  // Same wrapper, same reason as the number field above: the tooltip's wrapper is a
  // flex container, so the child has to be told to fill it.
  return <Tooltip content={help} fullWidth wrapperClassName="w-full [&>*]:w-full">{field}</Tooltip>;
}

/** A card of fields: the section's uppercase header, its one-liner, and a 2-column grid. */
function FieldCard({ section, children }: { section: AutoSupportSectionDef; children: React.ReactNode }) {
  const { _ } = useLingui();

  return (
    <section className="rounded-xl border p-3" style={FIELD_CARD_STYLE}>
      <div className="ui-meta font-semibold uppercase tracking-wide" title={_(section.hint)}>
        {_(section.label)}
      </div>
      {section.subtitle && (
        <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
          {_(section.subtitle)}
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">{children}</div>
    </section>
  );
}

/** The diagnostics card: the debug switches, and the switch that puts the last
 *  run's report on the panel. */
function DiagnosticsCard({
  debugSimpleRender,
  onToggleDebugSimpleRender,
  diagnostics,
  onToggleDiagnostic,
  debugMode,
  onToggleDebugMode,
}: {
  debugSimpleRender: boolean;
  onToggleDebugSimpleRender: () => void;
  /** The diagnostic switches' current state, from the store: they are applied
   *  at once, so the draft is not their home. */
  diagnostics: Record<AutoSupportDiagnosticKey, boolean>;
  onToggleDiagnostic: (key: AutoSupportDiagnosticKey, enabled: boolean) => void;
  debugMode: boolean;
  onToggleDebugMode: () => void;
}) {
  const { _ } = useLingui();
  const simplifiedHint = _(msg`Debug: simplified support render — contact disks/cones plus line vectors instead of full shafts`);
  const debugModeHint = _(msg`Debug: show the last run's sizing factors and forest report in the panel`);

  return (
    <section className="rounded-xl border p-3" style={FIELD_CARD_STYLE}>
      <div className="ui-meta font-semibold uppercase tracking-wide">{_(DEBUG_DIAGNOSTICS_HEADING)}</div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {DIAGNOSTIC_TOGGLES.map((toggle) => (
          <LabeledToggleInput
            key={toggle.key}
            label={_(toggle.label)}
            helpText={_(toggle.hint)}
            title={_(toggle.hint)}
            checked={diagnostics[toggle.key]}
            onChange={(next) => onToggleDiagnostic(toggle.key, next)}
          />
        ))}
        {/* Not an `autoSupport` key: a top-level render switch with its own updater. */}
        <LabeledToggleInput
          label={_(msg`Simplified`)}
          helpText={simplifiedHint}
          title={simplifiedHint}
          checked={debugSimpleRender}
          onChange={onToggleDebugSimpleRender}
        />
        {/* The report's own switch, beside the switches it belongs with. The
            report itself is read on the panel, where a run is started, so this
            toggle is all the dialog carries of it. Session state, not a setting:
            a view switch the panel owns, like the Debug button it replaces. */}
        <LabeledToggleInput
          label={_(msg`Debug Mode`)}
          helpText={debugModeHint}
          title={debugModeHint}
          checked={debugMode}
          onChange={onToggleDebugMode}
        />
      </div>
    </section>
  );
}

/** The six calibration fields plus their master switch, as one grid. */
function CalibrationFields({
  draft,
  setDraft,
  locked,
}: {
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  locked?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <ToggleField toggle={ADVANCED_CALIBRATION_TOGGLE} draft={draft} setDraft={setDraft} locked={locked} />
      {ADVANCED_CALIBRATION_KNOBS.map((knob) => (
        <NumberField key={knob.key} knob={knob} draft={draft} setDraft={setDraft} locked={locked} />
      ))}
    </div>
  );
}

export type AutoSupportSettingsBodyProps = {
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
  debugSimpleRender: boolean;
  onToggleDebugSimpleRender: () => void;
  /** The diagnostic switches (`Origin Colors`, `No Brace`), from the store: they
   *  apply the moment they are toggled and never mark the dialog dirty. */
  diagnostics: Record<AutoSupportDiagnosticKey, boolean>;
  onToggleDiagnostic: (key: AutoSupportDiagnosticKey, enabled: boolean) => void;
  /** Whether the panel shows the last run's diagnostics. Session state the panel owns. */
  debugMode: boolean;
  onToggleDebugMode: () => void;
  /**
   * The active preset is a built-in, whose block the store refuses to save over.
   * Every policy field is then disabled and says why on hover: an edit made here
   * could never be kept, so the dialog does not collect one — `Duplicate` is the
   * way out, and it selects the copy it makes.
   *
   * The diagnostics stay live: they are view switches rather than run policy, they
   * are excluded from the preset's dirtiness, and needing one to read the scene has
   * nothing to do with which preset is selected.
   */
  presetLocked: boolean;
}

export function AutoSupportSettingsBody({
  draft,
  setDraft,
  debugSimpleRender,
  onToggleDebugSimpleRender,
  diagnostics,
  onToggleDiagnostic,
  debugMode,
  onToggleDebugMode,
  presetLocked,
}: AutoSupportSettingsBodyProps) {
  const { _ } = useLingui();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 space-y-3">
        <AutoSupportPresetSelector draft={draft} setDraft={setDraft} />

        {/* The cards stretch to their row's height — the anti-aliasing section's
            idiom (`profileFormAtoms.tsx`): a plain grid, whose items stretch by
            default, so a short card leaves no dead space beside a tall one. Six
            cards fill three rows exactly; the disclosure below spans both columns. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {AUTO_SUPPORT_POLICY_SECTIONS.map((section) => (
            <FieldCard key={section.key} section={section}>
              {TOGGLES_BY_SECTION[section.key].map((toggle) => (
                <ToggleField key={toggle.key} toggle={toggle} draft={draft} setDraft={setDraft} locked={presetLocked} />
              ))}
              {section.key === 'density' && (
                <AutoSupportSizingTierField draft={draft} setDraft={setDraft} disabled={presetLocked} />
              )}
              {KNOBS_BY_SECTION[section.key].map((knob) => (
                <NumberField key={knob.key} knob={knob} draft={draft} setDraft={setDraft} locked={presetLocked} />
              ))}
            </FieldCard>
          ))}

          {/* Diagnostics is a card like the others: the switches are always on
              screen, not behind a disclosure. */}
          <DiagnosticsCard
            debugSimpleRender={debugSimpleRender}
            onToggleDebugSimpleRender={onToggleDebugSimpleRender}
            diagnostics={diagnostics}
            onToggleDiagnostic={onToggleDiagnostic}
            debugMode={debugMode}
            onToggleDebugMode={onToggleDebugMode}
          />

          {/* Advanced (calibration) is always visible too, but framed in the
              app's warning tone (the material modal's official-profile banner:
              `#d97706` mixed into the border and the surface) so it reads as the
              tuning constants rather than another preference. No callout text: the
              fields' tooltips carry it. */}
          <section
            className="lg:col-span-2 rounded-xl border p-3"
            style={{
              borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 36%)',
              background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
            }}
          >
            <div className="ui-meta font-semibold uppercase tracking-wide" title={_(AUTO_SUPPORT_ADVANCED_SECTION.hint)}>
              {_(AUTO_SUPPORT_ADVANCED_SECTION.label)}
            </div>
            <div className="mt-2">
              <CalibrationFields draft={draft} setDraft={setDraft} locked={presetLocked} />
            </div>
          </section>
        </div>
      </div>

      {/* The footer's actions are the preset's, in the reference's arrangement:
          Delete alone on the left, Reset and Save on the right. Save is the
          dialog's commit, so there is no separate Apply, and it leaves the dialog
          open — the preset list behind it is where the result shows. */}
      <AutoSupportSettingsFooterActions
        draft={draft}
        setDraft={setDraft}
      />
    </div>
  );
}
