import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@lingui/react';
import type { MessageDescriptor } from '@lingui/core';
import { i18n } from '../../i18n';
import type { AutoSupportSettings, ForestReport, SizingDebugInfo } from '@/supports/autoSupport';
import type { AutoSupportPreset } from '@/supports/Settings/autoSupportPresets';
import type { AutoSupportSettingsBodyProps } from '@/components/controls/autoSupport/AutoSupportSettingsBody';
import type { AutoSupportRunDiagnosticsProps } from '@/components/controls/autoSupport/AutoSupportRunDiagnostics';
import type { AutoSupportSectionDef } from '@/components/controls/autoSupport/autoSupportPanelTabs';
import { getSettings, updateAutoSupportSettings } from '@/supports/Settings/state';
import {
  createAutoSupportPreset,
  getActiveAutoSupportPresetId,
  getAutoSupportPreset,
  getAutoSupportPresets,
} from '@/supports/Settings/autoSupportPresets';
import { KNOBS, KNOBS_BY_SECTION } from '@/components/controls/autoSupport/autoSupportPanelTabs';
import { AUTO_SUPPORT_CONSTRAINTS } from '@/supports/autoSupport/settings';
import {
  modelHasExistingSupports,
  prepareReplaceSupports,
  handleReplaceSupportsOutcome,
  handleReplaceSupportsError,
} from '@/components/controls/AutoSupportPanel';
import { clearHistory, getUndoCount, undo } from '../../history/historyStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { commitAutoPlacePlan } from '../autoSupport/autoPlace';
import { resetStore, getSnapshot, setSnapshot } from '../state';
import type { SupportState } from '../types';

/**
 * The panel's settings dialog, mounted without a DOM.
 *
 * `AutoSupportSettingsBody` is the dialog's whole surface (the preset strip, the
 * field cards, the disclosure and the footer), so rendering it is the panel's
 * settings surface under test. There is no jsdom in this repo — component tests
 * render to static markup — which the body supports by construction: it is
 * store-free, taking the draft it edits plus the last run's diagnostics as props.
 *
 * The Lingui macros are stubbed for every unit test by `scripts/test-unit/register.mjs`.
 */

let AutoSupportSettingsBody: React.ComponentType<AutoSupportSettingsBodyProps>;
let AutoSupportRunDiagnostics: React.ComponentType<AutoSupportRunDiagnosticsProps>;
let selectAutoSupportPreset: (id: string, setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>) => void;
let deleteActiveAutoSupportPreset: (setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>) => void;
let autoSupportPresetOptions: (
  presets: readonly AutoSupportPreset[],
  activeId: string | null,
  translate: (descriptor: MessageDescriptor) => string,
) => Array<{ value: string; label: string; disabled?: boolean; rightContent: string }>;
let AutoSupportPresetRow: React.ComponentType<{
  presets: readonly AutoSupportPreset[];
  activeId: string | null;
  onSelect: (id: string) => void;
  activeHint?: MessageDescriptor;
  autoLift: boolean;
  onAutoLiftChange: (enabled: boolean) => void;
}>;
let autoSupportSections: ReadonlyArray<AutoSupportSectionDef>;
let policySections: ReadonlyArray<AutoSupportSectionDef>;
let diagnosticToggles: ReadonlyArray<{ key: string }>;
let togglesBySection: { debug: ReadonlyArray<{ key: string }> };
let tierHints: Record<string, MessageDescriptor>;

before(async () => {
  ({ AutoSupportSettingsBody } = await import('@/components/controls/autoSupport/AutoSupportSettingsBody'));
  ({ AutoSupportRunDiagnostics } = await import('@/components/controls/autoSupport/AutoSupportRunDiagnostics'));
  ({ selectAutoSupportPreset, deleteActiveAutoSupportPreset } = await import('@/components/controls/autoSupport/AutoSupportPresets'));
  ({ autoSupportPresetOptions } = await import('@/components/controls/autoSupport/AutoSupportPresetSelect'));
  ({ AutoSupportPresetRow } = await import('@/components/controls/autoSupport/AutoSupportPresetRow'));
  ({
    AUTO_SUPPORT_SECTIONS: autoSupportSections,
    AUTO_SUPPORT_POLICY_SECTIONS: policySections,
    DIAGNOSTIC_TOGGLES: diagnosticToggles,
    TOGGLES_BY_SECTION: togglesBySection,
    TIER_HINTS: tierHints,
  } = await import('@/components/controls/autoSupport/autoSupportPanelTabs'));
});

/** The calibration surface, which is the one thing behind a disclosure. */
const CALIBRATION_MARKERS = [
  'Advanced (calibration)',
  'Model-Scale Sizing',
  'Tip Fit Margin',
  // The tooltip names the value the engine ships with; there is no sub-label.
  'The default, 0.9',
];

/** The diagnostics card: the debug switches, and the switch that shows the run's report. */
const DIAGNOSTICS_MARKERS = [
  'Origin Colors',
  'No Brace',
  'Simplified',
  'Debug Mode',
];

const SIZING_DEBUG: SizingDebugInfo = {
  modelVolumeMm3: 12_345,
  estimatedWeightG: 13.2,
  totalCandidates: 187,
  weightPerSupportG: 0.07,
  modelSizeMm: 82,
  loadShareG: 0.06,
  sizeFactor: 1.12,
  loadFactor: 1.0,
  avgIslandAreaMm2: 3.4,
  standaloneHosts: 41,
  gridInfillHosts: 44,
  shaftDiameterRange: { min: 0.98, max: 1.21, avg: 1.04 },
  tipContactRange: { min: 0.28, max: 0.42, avg: 0.34 },
};

const BODY_PROPS = {
  setDraft: () => {},
  debugSimpleRender: false,
  onToggleDebugSimpleRender: () => {},
  diagnostics: { debugSupportOriginColors: false, debugSkipAutoBracing: false },
  onToggleDiagnostic: () => {},
  debugMode: false,
  onToggleDebugMode: () => {},
  presetLocked: false,
} satisfies Omit<AutoSupportSettingsBodyProps, 'draft'>;

/** What a run hands the panel's diagnostics. */
const FOREST_REPORT = {
  hostCount: 56,
  leafCount: 70,
  branchCount: 12,
  trees: [{}, {}],
} as unknown as ForestReport;

function renderBody(
  draft: AutoSupportSettings = getSettings().autoSupport,
  overrides: Partial<AutoSupportSettingsBodyProps> = {},
): string {
  // `createElement` rather than JSX so this stays a `.ts` file, which is the
  // glob the supports suite is run with.
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(AutoSupportSettingsBody, { ...BODY_PROPS, draft, ...overrides }),
    ),
  );
  // Static markup escapes text ("Density &amp; Sizing"); the assertions read labels.
  return markup.replace(/&amp;/g, '&');
}

function renderRunDiagnostics(
  // Defaults, not `??`: an explicit `null` is the "no run yet" case.
  sizingDebug: SizingDebugInfo | null = SIZING_DEBUG,
  forestReport: ForestReport | null = FOREST_REPORT,
): string {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(AutoSupportRunDiagnostics, {
        sizingDebug,
        forestReport,
        onShowForestReport: () => {},
      }),
    ),
  );
  return markup.replace(/&amp;/g, '&');
}

test('every card renders, all of them visible, with calibration framed as a warning', () => {
  const markup = renderBody();

  for (const section of autoSupportSections) {
    assert.ok(markup.includes(String(section.label.message)), `the dialog is missing the "${section.label.message}" section`);
  }
  for (const section of policySections) {
    assert.ok(section.subtitle, `the "${section.label.message}" card is missing its one-liner`);
    assert.ok(markup.includes(String(section.subtitle.message)), `the "${section.label.message}" card is missing its one-liner`);
  }

  // Nothing is behind a disclosure any more: every control is on screen.
  assert.ok(!markup.includes('<details'), 'the dialog still has a disclosure');

  for (const marker of DIAGNOSTICS_MARKERS) {
    assert.ok(markup.includes(marker), `"${marker}" must be on screen`);
  }

  // The last run's report is the *panel's*, not the dialog's: the card here
  // carries the switch that shows it and nothing of the report itself.
  assert.ok(!markup.includes('Sizing Debug'), 'the dialog must not carry the sizing debug disclosure');
  assert.ok(!markup.includes('Show Forest Report'), 'the dialog must not carry the report button');

  // `Debug Mode` is a cell of the switches' own grid, the one beside
  // `Simplified`, not a row of its own further down the card.
  assert.ok(
    markup.indexOf('Simplified') < markup.indexOf('Debug Mode'),
    'the debug switch must sit beside the Simplified toggle',
  );
  assert.ok(
    markup.indexOf('Debug Mode') < markup.indexOf('Advanced (calibration)'),
    'the debug switch must sit in the diagnostics card, not past the calibration card',
  );

  for (const marker of CALIBRATION_MARKERS) {
    assert.ok(markup.includes(marker), `"${marker}" must be on screen`);
  }

  // The calibration card carries the warning tone instead of a callout: the amber
  // border/background the material modal's warning banner uses.
  assert.ok(markup.includes('color-mix(in srgb, #d97706, var(--border-subtle) 36%)'), 'no warning-toned border');
  assert.ok(markup.includes('color-mix(in srgb, #d97706, var(--surface-1) 92%)'), 'no warning-toned surface');

  // No callout text, no "measured" claim, no reset action: the tooltips carry the
  // explanation of what each value does.
  assert.ok(!markup.includes('measured'));
  assert.ok(!markup.includes('Reset to measured defaults'));
  assert.ok(!markup.includes('Calibration, not preferences'));
});

test('the run diagnostics are the panel\'s: the sizing inputs and the report button', () => {
  const markup = renderRunDiagnostics();

  // Both halves of the last run's report, where the run was started.
  assert.ok(markup.includes('Sizing Debug'), 'the sizing inputs must be on the panel');
  assert.ok(markup.includes('Show Forest Report'), 'the report button must be on the panel');
  assert.ok(markup.includes('56H 70L 12B · 2 trees'), 'the report button must carry the last run tally');

  // Disclosed, not dumped: the sizing numbers are behind the caret until it opens.
  assert.ok(!markup.includes('Model volume'), 'the sizing inputs must start disclosed, not open');

  // Nothing run yet renders neither, rather than two empty frames.
  assert.equal(
    renderRunDiagnostics(null, null),
    '',
    'a panel with no run yet must render no diagnostics',
  );
});

test('every debug toggle is a declared diagnostic', () => {
  // The card renders `DIAGNOSTIC_TOGGLES`, typed as the block's diagnostics. A
  // debug switch added to the catalogue but not to `DIAGNOSTIC_AUTO_SUPPORT_KEYS`
  // would silently vanish from the card (and would be staged for Save again), so
  // the two lists have to stay the same list.
  assert.deepEqual(
    diagnosticToggles.map((toggle) => toggle.key),
    togglesBySection.debug.map((toggle) => toggle.key),
    'the debug section and the diagnostics list have drifted apart',
  );
});

test('the diagnostic switches read the store, not the dialog’s draft', () => {
  // The draft says both are off while the store has Origin Colors on. A
  // diagnostic is applied the moment it is toggled, so the card must show the
  // store's state: reading the draft here is what made these switches look like
  // unsaved edits the user had to save or discard.
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(AutoSupportSettingsBody, {
        ...BODY_PROPS,
        draft: { ...getSettings().autoSupport, debugSupportOriginColors: false, debugSkipAutoBracing: false },
        diagnostics: { debugSupportOriginColors: true, debugSkipAutoBracing: false },
      }),
    ),
  );

  const switchAfter = (label: string) => /aria-checked="(true|false)"/.exec(markup.slice(markup.indexOf(label)))?.[1];
  assert.equal(switchAfter('Origin Colors'), 'true', 'Origin Colors must show what the store holds');
  assert.equal(switchAfter('No Brace'), 'false', 'No Brace must show what the store holds');
});

test('a built-in’s fields are locked, and each says to duplicate it', () => {
  const unlocked = renderBody(undefined, { presetLocked: false });
  const locked = renderBody(undefined, { presetLocked: true });

  // Every field control — a knob's input, a toggle's switch, the tier's trigger —
  // is disabled. The dialog's preset selector is *not* a field in this sense: it is
  // preset management, and it stays live so Duplicate can be reached at all, so the
  // fields are matched by the class only they carry, and the sweep stops at the
  // diagnostics card, whose switches are deliberately still live.
  const fieldControls = (markup: string) => markup.match(/<(?:input|button)[^>]*ui-input w-full h-\[36px\][^>]*>/g) ?? [];
  // The *attribute*, not the substring: every field carries the class
  // `disabled:pointer-events-none`, so `includes('disabled')` is always true.
  const editable = (markup: string) => fieldControls(markup).filter((tag) => !/\sdisabled=""/.test(tag));
  const policyRegion = (markup: string) => markup.slice(0, markup.indexOf('Origin Colors'));

  assert.ok(
    editable(policyRegion(unlocked)).length > 0,
    'a preset of the user’s own must offer fields to edit',
  );
  assert.equal(
    editable(policyRegion(locked)).length,
    0,
    'nothing the user could edit on their own preset may stay editable on a built-in',
  );

  // The tier is one of those fields; its trigger is the dropdown that follows the
  // tier label, which is how it is found without also catching the selector's.
  const tierTrigger = (markup: string) => {
    const at = markup.indexOf('Sizing Tier');
    return markup.slice(at, markup.indexOf('</button>', at));
  };
  assert.match(tierTrigger(locked), /\sdisabled=""/, 'the sizing tier must lock with the fields');
  assert.doesNotMatch(tierTrigger(unlocked), /\sdisabled=""/, 'and be editable on a custom preset');

  // The lock's text reaches both affordances — the ⓘ's accessible name, which is in
  // the markup, and the hover popover, whose content is a prop and only mounts on
  // hover. What a static render can prove is the first; the second is the same
  // string handed to the app's tooltip.
  assert.ok(locked.includes('Duplicate it and edit the copy'), 'a locked field must say how to edit it');
  assert.ok(!unlocked.includes('Duplicate it and edit the copy'), 'an editable field must not claim to be locked');

  // The two switches that are not run policy stay live: a diagnostic is a view
  // switch, excluded from the preset's dirtiness, and reading the scene with one has
  // nothing to do with which preset is selected.
  const diagnosticsCard = (markup: string) => markup.slice(markup.indexOf('Origin Colors'), markup.indexOf('Advanced (calibration)'));
  assert.doesNotMatch(
    diagnosticsCard(locked),
    /\sdisabled=""/,
    'the diagnostics must stay usable while a built-in is selected',
  );
});

test('a numeric knob is a labelled field with its unit and a stepper, never a slider', () => {
  const markup = renderBody();

  // No slider survives anywhere in the dialog.
  assert.ok(!markup.includes('type="range"'), 'a slider is still rendered');

  // The unit rides inside the field (Support Studio's convention), so the label is
  // the name alone. The visible text is what proves the label half: the carets'
  // accessible names still carry the unit, which is the other half of this.
  const visibleText = markup.replace(/<[^>]*>/g, ' ');
  assert.ok(visibleText.includes('Min Island Size'), 'the name is the label');
  assert.ok(!visibleText.includes('Min Island Size (mm²)'), 'the unit must not ride on the label');
  assert.ok(!visibleText.includes('Self-Support Angle (°)'), 'nor on this one');
  assert.ok(markup.includes('>mm²</span>'), 'the unit renders inside the field');
  assert.ok(markup.includes('>°</span>'), 'and each field carries its own');
  // The stepper is the field's own, and its two carets name the field — unit and all.
  assert.ok(markup.includes('aria-label="Increase Min Island Size (mm²)"'));
  assert.ok(markup.includes('aria-label="Decrease Min Island Size (mm²)"'));

  // A toggle is the pill the material editor's switches use, not a slider.
  assert.ok(markup.includes('role="switch"'));
  assert.ok(markup.includes('aria-checked="true"'));
});

test('the preset strip carries the reference actions, and the footer the commit pair', () => {
  const markup = renderBody();
  const visibleText = markup.replace(/<[^>]*>/g, ' ');

  // The strip sits above the fields: the selector, then exactly the three
  // actions the reference keeps beside it.
  assert.ok(markup.includes('aria-label="Auto-support preset"'));
  assert.ok(markup.indexOf('Auto-support preset') < markup.indexOf('Detection'), 'the preset strip must sit above the sections');
  for (const action of ['Rename', 'Duplicate', 'Export', 'Import']) {
    assert.ok(visibleText.includes(action), `the preset strip is missing the "${action}" action`);
  }

  // `New` is the dropdown's own menu entry, not a button in the strip; there is no
  // second row of collection actions and no factory restore.
  assert.ok(!visibleText.includes('New'), 'the strip still shows a New control');
  assert.ok(!visibleText.includes('Restore factory presets'), 'the dropped restore action is still rendered');

  // The footer is the reference's: Delete on the left, Reset + Save on the right,
  // with no separate Apply.
  for (const action of ['Delete', 'Reset', 'Save']) {
    assert.ok(visibleText.includes(action), `the dialog footer is missing the "${action}" action`);
  }
  assert.ok(!visibleText.includes('Apply'), 'the footer still shows an Apply action');
  assert.ok(!visibleText.includes('unsaved changes'), 'the removed dirty strip is still rendered');

  const builtIns = getAutoSupportPresets().filter((preset) => preset.isBuiltIn);
  assert.deepEqual(builtIns.map((preset) => preset.id), ['light', 'medium', 'heavy']);
});

test('the modified marker rides on the dirty preset name, and only when it is dirty', () => {
  // Clean: a preset applied and untouched is not marked.
  selectAutoSupportPreset('light', () => {});
  const clean = renderBody();
  assert.ok(clean.includes('aria-label="Auto-support preset"'), 'a clean preset must not be announced as modified');
  assert.ok(!clean.includes('aria-label="Auto-support preset, modified"'));
  assert.ok(!clean.includes('Light *'), 'a clean preset must not carry the star');

  // A knob edit staged in the draft — the store is still clean — marks the name,
  // because that is what a user means by "this preset is modified".
  const edited = renderBody({ ...getSettings().autoSupport, areaPerSupportMm2: 7 });
  assert.ok(edited.includes('Light *'), 'a staged knob edit must mark the preset name');
  assert.ok(
    edited.includes('aria-label="Auto-support preset, modified"'),
    'the modified state must be exposed to assistive tech',
  );
  assert.ok(edited.includes('The settings no longer match this preset'), 'the trigger must explain the marker');

  // And so does a live block that has drifted from the preset.
  updateAutoSupportSettings({ areaPerSupportMm2: 8 });
  const drifted = renderBody();
  assert.ok(drifted.includes('Light *'), 'a drifted live block must mark the preset name');
});


test('selecting a preset applies it to the settings and to the dialog draft', () => {
  assert.ok(getAutoSupportPreset('light'));

  let draft = getSettings().autoSupport;
  selectAutoSupportPreset('light', (next) => {
    draft = typeof next === 'function' ? next(draft) : next;
  });

  // The store's own contract — the applied block, normalized — is its tests';
  // what matters here is that the dialog's draft is what was just applied, so
  // the fields show it.
  assert.equal(getActiveAutoSupportPresetId(), 'light');
  assert.deepEqual(draft, getSettings().autoSupport);
});

test('deleting the selected preset falls back to the balanced built-in', () => {
  const mine = createAutoSupportPreset('Mine');
  assert.equal(getActiveAutoSupportPresetId(), mine.id);

  deleteActiveAutoSupportPreset(() => {});

  // The store's own contract is "nothing selected"; the dialog's fallback is what
  // keeps a run policy on screen, so it is what is asserted here.
  assert.equal(getActiveAutoSupportPresetId(), 'medium');
  assert.ok(!getAutoSupportPresets().some((preset) => preset.id === mine.id), 'the deleted preset is gone');
});

test('Save refuses a built-in preset and is offered for a custom one', () => {
  const saveButton = (markup: string) => {
    const end = markup.indexOf('>Save</button>');
    if (end < 0) return '';
    return markup.slice(markup.lastIndexOf('<button', end), end);
  };

  // Something to save either way, so the preset's kind is the only difference.
  selectAutoSupportPreset('light', () => {});
  updateAutoSupportSettings({ areaPerSupportMm2: 7 });

  const builtIn = renderBody();
  assert.ok(saveButton(builtIn).includes('disabled=""'), 'Save must be refused while a built-in is selected');
  assert.ok(
    builtIn.includes('A built-in preset cannot be saved over'),
    'the refusal must say how to keep the edits',
  );

  createAutoSupportPreset('Mine');
  updateAutoSupportSettings({ areaPerSupportMm2: 8 });

  const custom = renderBody();
  assert.ok(!saveButton(custom).includes('disabled=""'), 'Save must be offered for a custom preset');
});

/** The panel's own preset row, mounted without a DOM like the dialog's body. */
function renderPresetRow(activeId: string | null, autoLift = false): string {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(AutoSupportPresetRow, {
        presets: getAutoSupportPresets(),
        activeId,
        onSelect: () => {},
        autoLift,
        onAutoLiftChange: () => {},
      }),
    ),
  );
}

test('the panel’s selector offers the profiles a user saved, not only the built-ins', () => {
  // Named apart from the preset the Save test makes, whose name is taken.
  const mine = createAutoSupportPreset('Panel Profile');
  const options = autoSupportPresetOptions(
    getAutoSupportPresets(),
    getActiveAutoSupportPresetId(),
    (descriptor) => i18n._(descriptor),
  );

  // The row the panel used to render was `filter(isBuiltIn)`, so a saved profile
  // was unreachable from the panel at all. The built-ins lead, the user's follow.
  assert.deepEqual(
    options.slice(0, 3).map((option) => option.value),
    ['light', 'medium', 'heavy'],
    'the built-ins lead the list',
  );
  assert.ok(
    options.some((option) => option.value === mine.id && option.label === 'Panel Profile'),
    'a saved profile must be offered under the name it was saved with',
  );
  assert.equal(options.find((option) => option.value === 'light')?.label, 'Light', 'built-in names stay translated');
  assert.equal(
    options.find((option) => option.value === mine.id)?.rightContent,
    'Custom',
    'a saved profile is marked as the user’s own',
  );
  assert.equal(
    options.find((option) => option.value === 'light')?.rightContent,
    'Built-in',
    'and a shipped one as built in',
  );

  // The trigger renders the selected option's label, so a custom profile being
  // active is what the panel reads while it is selected.
  const markup = renderPresetRow(mine.id);
  assert.ok(markup.includes('aria-label="Auto-support preset"'));
  assert.ok(markup.includes('Panel Profile'), 'the panel must show the custom profile it is on');

  // The tier hint stays with the built-ins it describes.
  const onBuiltIn = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { i18n },
      React.createElement(AutoSupportPresetRow, {
        presets: getAutoSupportPresets(),
        activeId: 'light',
        onSelect: () => {},
        activeHint: tierHints.light,
        autoLift: false,
        onAutoLiftChange: () => {},
      }),
    ),
  );
  assert.ok(onBuiltIn.includes('Sparse supports'), 'selecting a built-in must explain what it is for');
});

test('the panel’s preset row is the selector and the Auto-Lift toggle, one to one', () => {
  const off = renderPresetRow(null, false);
  const on = renderPresetRow(null, true);

  // The toggle is the row's last button (the dropdown renders its trigger and, while
  // closed, nothing else), so its own markup is what the state assertions read.
  const toggle = (markup: string) => markup.slice(markup.lastIndexOf('<button'));

  // A toggle button in the app's standard shape: the pressed state is the
  // accessibility fact, the accent fill is what carries it visually, and the label
  // says which way the flag is set.
  assert.ok(off.includes('Auto-Lift OFF'), 'the off label must state the state');
  assert.ok(on.includes('Auto-Lift ON'), 'the on label must state the state');
  assert.ok(off.includes('aria-pressed="false"'), 'auto-lift off must be announced as not pressed');
  assert.ok(on.includes('aria-pressed="true"'), 'auto-lift on must be announced as pressed');
  assert.ok(
    toggle(on).includes('color-mix(in srgb, var(--accent), var(--surface-1) 85%)'),
    'the accent fill is what marks the toggle as on',
  );
  assert.ok(
    !toggle(off).includes('color-mix(in srgb, var(--accent), var(--surface-1) 85%)'),
    'the off state must not carry the accent fill',
  );

  // Off keeps the lighter fill the dropdown beside it uses, so the row holds
  // together. Nothing is struck through: the state is in the words.
  assert.ok(toggle(off).includes('background:var(--surface-1)'), 'off takes the dropdown’s lighter fill');
  assert.ok(toggle(on).includes('background:color-mix'), 'on takes the accent fill instead');
  assert.ok(!off.includes('line-through'), 'the label must not be crossed out');
  assert.ok(
    off.includes('Lift the selected models to this distance'),
    'the toggle must say what lifting the model does for a run',
  );

  // Sentence case: the upper-case pill it started as reads as shouting beside a
  // quiet dropdown.
  assert.ok(!off.includes('uppercase'), 'the label must not be all caps');

  // The dropdown keeps the Auto Orientation panel's objective-dropdown theme: the
  // lighter surface-1 fill rather than the input's own, content centred.
  assert.ok(off.includes('background:var(--surface-1)'), 'the selector takes the surface-1 fill');
  assert.ok(off.includes('text-align:center'), 'the row follows the centred Auto Orientation dropdown');
});

test('the panel’s selector names the unselected state instead of rendering an empty trigger', () => {
  const options = autoSupportPresetOptions(
    getAutoSupportPresets(),
    null,
    (descriptor) => i18n._(descriptor),
  );

  assert.equal(options[0].value, '', 'the placeholder is the unmatched value the trigger falls back to');
  assert.equal(options[0].disabled, true, 'the state itself is not a choice');
  assert.equal(options[0].label, 'Custom — not a preset');
  assert.ok(renderPresetRow(null).includes('Custom — not a preset'));
});

test('MED-03[b] every numeric knob in KNOBS and KNOBS_BY_SECTION aligns with AUTO_SUPPORT_CONSTRAINTS', () => {
  for (const knob of KNOBS) {
    const constraint = AUTO_SUPPORT_CONSTRAINTS[knob.key];
    assert.ok(constraint, `Constraint must exist for knob ${knob.key}`);
    assert.equal(knob.min, constraint.min, `Knob ${knob.key} min should match constraint min`);
    assert.equal(knob.max, constraint.max, `Knob ${knob.key} max should match constraint max`);
    assert.equal(knob.step, constraint.step, `Knob ${knob.key} step should match constraint step`);
  }

  for (const [sectionKey, sectionKnobs] of Object.entries(KNOBS_BY_SECTION)) {
    for (const knob of sectionKnobs) {
      const constraint = AUTO_SUPPORT_CONSTRAINTS[knob.key];
      assert.ok(constraint, `Constraint must exist for knob ${knob.key} in section ${sectionKey}`);
      assert.equal(knob.min, constraint.min, `Knob ${knob.key} min in section ${sectionKey} should match constraint min`);
      assert.equal(knob.max, constraint.max, `Knob ${knob.key} max in section ${sectionKey} should match constraint max`);
      assert.equal(knob.step, constraint.step, `Knob ${knob.key} step in section ${sectionKey} should match constraint step`);
    }
  }
});

test('MED-03[b] modelHasExistingSupports detects all support types per model', () => {
  resetStore();
  const baseSnap = getSnapshot();

  // False when store is empty
  assert.equal(modelHasExistingSupports(baseSnap, 'model-1'), false);

  // False when supports exist for a different model
  const otherModelSnap: SupportState = {
    ...baseSnap,
    stumps: {
      stump1: { id: 'stump1', modelId: 'model-2', typeId: 'stump' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(otherModelSnap, 'model-1'), false);
  assert.equal(modelHasExistingSupports(otherModelSnap, 'model-2'), true);

  // True when model has ONLY stumps
  const stumpsOnly: SupportState = {
    ...baseSnap,
    stumps: {
      stump1: { id: 'stump1', modelId: 'model-1', typeId: 'stump' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(stumpsOnly, 'model-1'), true);

  // True when model has ONLY sticks
  const sticksOnly: SupportState = {
    ...baseSnap,
    sticks: {
      stick1: { id: 'stick1', modelId: 'model-1', typeId: 'stick' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(sticksOnly, 'model-1'), true);

  // True when model has ONLY twigs
  const twigsOnly: SupportState = {
    ...baseSnap,
    twigs: {
      twig1: { id: 'twig1', modelId: 'model-1', typeId: 'twig' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(twigsOnly, 'model-1'), true);

  // True when model has braces
  const bracesOnly: SupportState = {
    ...baseSnap,
    braces: {
      brace1: { id: 'brace1', modelId: 'model-1', typeId: 'brace' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(bracesOnly, 'model-1'), true);

  // True when model has kickstands
  const kickstandsOnly: SupportState = {
    ...baseSnap,
    kickstands: {
      ks1: { id: 'ks1', modelId: 'model-1', typeId: 'kickstand' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(kickstandsOnly, 'model-1'), true);

  // True when entity references a root owned by model-1
  const rootOnly: SupportState = {
    ...baseSnap,
    roots: {
      root1: { id: 'root1', modelId: 'model-1' } as any,
    },
    trunks: {
      trunk1: { id: 'trunk1', rootId: 'root1', typeId: 'trunk' } as any,
    },
  };
  assert.equal(modelHasExistingSupports(rootOnly, 'model-1'), true);
});

test('MED-03[b] Replace all orchestration pushes exactly 1 history entry and undo() restores pre-replace supports', () => {
  const disposeHandlers = registerSupportHistoryHandlers();
  try {
    clearHistory();
    resetStore();

    // 1. Set up an existing support in the snapshot
    const initialTrunk = {
      id: 'pre-existing-trunk',
      modelId: 'model-1',
      typeId: 'trunk',
      contactCone: { pos: { x: 0, y: 0, z: 10 } },
    } as any;
    setSnapshot({
      ...getSnapshot(),
      trunks: { [initialTrunk.id]: initialTrunk },
    });

    assert.equal(modelHasExistingSupports(getSnapshot(), 'model-1'), true);
    assert.equal(getUndoCount(), 0);

    // Immediate replace: prepareReplaceSupports removes supports and captures replaceBefore
    const prep = prepareReplaceSupports('model-1');
    assert.equal(prep.removedCount, 1);
    assert.ok(prep.replaceBefore);
    assert.equal(getUndoCount(), 0, 'Must NOT push history during prepare/removal');
    assert.equal(modelHasExistingSupports(getSnapshot(), 'model-1'), false);

    // Simulate successful auto-place with replaceBefore override
    const newTrunk = {
      id: 'new-auto-trunk',
      modelId: 'model-1',
      typeId: 'trunk',
      contactCone: { pos: { x: 5, y: 5, z: 10 } },
    } as any;
    const fakePlan: any = {
      before: getSnapshot(),
      support: { ...getSnapshot(), trunks: { [newTrunk.id]: newTrunk } },
      analytics: { timings: {} },
      result: { changed: true, placed: { trunks: 1 }, rejected: 0, status: 'success' },
    };

    const res = commitAutoPlacePlan(fakePlan, prep.replaceBefore);
    handleReplaceSupportsOutcome(prep.replaceBefore, res);

    // Assert EXACTLY 1 history entry pushed
    assert.equal(getUndoCount(), 1, 'Replace all must push exactly 1 history entry');
    assert.ok(getSnapshot().trunks['new-auto-trunk'], 'New trunk should be live');
    assert.ok(!getSnapshot().trunks['pre-existing-trunk'], 'Old trunk should be replaced');

    // Single undo() restores pre-replace state
    undo();
    assert.equal(getUndoCount(), 0);
    assert.ok(getSnapshot().trunks['pre-existing-trunk'], 'Old trunk must be restored on single undo');
    assert.ok(!getSnapshot().trunks['new-auto-trunk'], 'New trunk must be undone');

    // 2. Deferred post-scan replace where 0 islands placed (!changed)
    clearHistory();
    const prep2 = prepareReplaceSupports('model-1');
    assert.equal(prep2.removedCount, 1);
    assert.equal(getUndoCount(), 0);

    // simulate no islands / no changes
    handleReplaceSupportsOutcome(prep2.replaceBefore, { changed: false } as any);
    assert.equal(getUndoCount(), 1, 'Even when unchanged, stripping supports must push exactly 1 edit history entry');
    assert.equal(modelHasExistingSupports(getSnapshot(), 'model-1'), false);

    // Single undo() restores pre-replace state
    undo();
    assert.equal(getUndoCount(), 0);
    assert.ok(getSnapshot().trunks['pre-existing-trunk'], 'Old trunk must be restored on single undo after 0-islands/unchanged');

    // 3. Error case restores state cleanly
    clearHistory();
    const prep3 = prepareReplaceSupports('model-1');
    assert.equal(prep3.removedCount, 1);
    handleReplaceSupportsError(prep3.replaceBefore, new Error('placement failed'));
    assert.equal(getUndoCount(), 0, 'No history entry on error');
    assert.ok(getSnapshot().trunks['pre-existing-trunk'], 'Pre-replace supports restored on error');
  } finally {
    disposeHandlers();
  }
});

