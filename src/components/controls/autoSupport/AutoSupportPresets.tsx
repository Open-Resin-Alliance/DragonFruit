"use client";

/**
 * The Auto Support settings dialog's preset UI: the strip at the top of the
 * dialog and the actions in its footer, both modelled on the LUT curve editor
 * (`src/features/slicing/components/LutCurveEditor.tsx`).
 *
 * A preset is a named `autoSupport` block: the whole run policy. The collection,
 * the active selection and the file format belong to
 * `@/supports/Settings/autoSupportPresets`; this file is only its UI.
 *
 * The LUT editor's shape, which this copies:
 *
 * - `Rename` / `Export` / `Import` sit beside the selector, and nothing else
 *   does (`LutCurveEditor` 1375-1398).
 * - `New` is the selector's own menu entry — `menuFooterAction` with a plus icon
 *   and the accent tone (1359-1364, and the same idiom in
 *   `src/components/settings/UISettingsTab.tsx` 297-301). It is the only thing in
 *   the menu besides the presets themselves; `Rename`, `Duplicate`, `Export` and
 *   `Import` sit in the row beside the trigger.
 * - The footer is `Delete` alone on the left (in the LUT's own filled-danger
 *   treatment, 1498-1511) and `Reset` + `Save` on the right (1498-1532). The LUT's `Reset` restores the draft from the snapshot taken
 *   when the editor opened (`handleResetDraft`, 1043-1052) — it discards
 *   uncommitted changes, it is not a factory restore — and its `Save` commits the
 *   draft (`handleSave`, 1035-1041). Both are disabled until there is something
 *   to discard or commit (`disabled={!isDirty}`).
 *
 * Two behaviours worth knowing before changing it:
 *
 * - Selecting a preset **applies** it to the live settings. That is the store's
 *   contract, so it cannot be staged in the dialog's draft like a knob edit —
 *   instead the applied block is copied back into the draft, so the fields
 *   immediately show what was applied.
 * - A built-in's name is translated by id at render, so Rename is refused for
 *   them (and Delete too: the format and the tier row are defined in terms of
 *   those ids). A built-in *is* savable over — that is how a user keeps a
 *   tweaked tier.
 *
 * Modified state is the store's `isAutoSupportPresetDirty` and nothing else: the
 * name the trigger shows carries a trailing `*` while it is set, and the trigger's
 * `aria-label` and `title` say so too. There is no notice row to repeat it.
 *
 * Two refusals are deliberate. A built-in cannot be saved over (its name and its
 * block are the factory's; Duplicate is the way to make one yours), so `Save` is
 * disabled while one is selected; and a built-in cannot be deleted, so `Delete`
 * greys out. Deleting the preset you are on falls back to the balanced built-in
 * rather than leaving the dialog with no policy at all — the store's own contract
 * (no selection) is unchanged; the fallback is this UI's.
 */
import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Check, Copy, Download, PenLine, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import type { AutoSupportSettings } from '@/supports/autoSupport';
import {
  commitAutoSupportSettings,
  createAutoSupportPreset,
  deleteAutoSupportPreset,
  duplicateAutoSupportPreset,
  exportAutoSupportPresetToJson,
  getActiveAutoSupportPresetId,
  autoSupportPolicyDiffers,
  getAutoSupportPreset,
  getAutoSupportPresetsServerSnapshot,
  getAutoSupportPresetsSnapshot,
  importAutoSupportPresetFromJson,
  isAutoSupportPresetDirty,
  renameAutoSupportPreset,
  resetToActivePreset,
  setActiveAutoSupportPreset,
  subscribeToAutoSupportPresets,
  type AutoSupportPreset,
} from '@/supports/Settings/autoSupportPresets';
import { translateAutoSupportPresetName } from '@/supports/Settings/autoSupportPresetMessages';
import {
  getSettings,
  subscribeToSettings,
} from '@/supports/Settings/state';
import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  pickOpenFilesWithNativeDialog,
  readPrintArtifactBytesFromPath,
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import { sizingTierName, useSupportStudioPresets } from './AutoSupportSizingTierField';
import { NO_ACTIVE_PRESET_LABEL } from '@/supports/Settings/autoSupportPresetMessages';

type Translate = (descriptor: MessageDescriptor) => string;

/** Placeholder and starting value for a new preset's name. */
const NEW_PRESET_NAME = msg`New Preset`;

/** The selector's "add one" entry — the references' `New Curve` / `+ New Theme`. */
const NEW_PRESET_ENTRY = msg`New preset…`;

/** The strip's buttons: the LUT editor's quiet outline row button. */
const STRIP_BUTTON = '!h-8 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1 disabled:opacity-45 disabled:cursor-not-allowed';

/** The footer's buttons: the LUT editor's footer treatment. */
const FOOTER_BUTTON = 'inline-flex items-center gap-1.5 !h-9 px-3 text-[12px] disabled:opacity-45 disabled:cursor-not-allowed';

/** The LUT's `Save`: the accent-secondary action token, filled. */
const SAVE_STYLE = {
  borderColor: 'var(--accent-secondary-action-border)',
  background: 'var(--accent-secondary-action-bg-92)',
  color: 'var(--accent-secondary-action-color)',
} as const;

/**
 * The save's acknowledgement: the app's success treatment, as the updater's
 * up-to-date banner and the notification stack tint theirs. The button already
 * transitions background, border and colour over 140ms, so the swap animates
 * without anything extra here.
 */
const SAVED_STYLE = {
  borderColor: 'color-mix(in srgb, var(--success), var(--border-subtle) 40%)',
  background: 'color-mix(in srgb, var(--success), var(--surface-1) 85%)',
  color: 'var(--success)',
} as const;

/**
 * Interpolating `msg` templates live at module scope: React Compiler renames the
 * interpolated locals inside a component, which desyncs the message id from the
 * compiled catalog in production (see AGENTS.md).
 */
/** Interpolating template — module scope for the same reason as above. */
function formatDeletePresetTitle(presetName: string, translate: Translate): string {
  return translate(msg`Delete "${presetName}"?`);
}

/**
 * Applies a preset and copies the applied block into the dialog's draft, so the
 * fields show what was just selected.
 *
 * Module scope so the panel's tier row and the preset selector drive the same
 * path (and a test can call it without a DOM).
 */
export function selectAutoSupportPreset(
  id: string,
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>,
): void {
  setActiveAutoSupportPreset(id);
  setDraft(getSettings().autoSupport);
}

/**
 * Deletes the selected preset and falls back to `medium`.
 *
 * The store's contract after deleting the active preset is "nothing is selected",
 * and that stays as it is; the dialog is not a place to leave a user with no run
 * policy at all, so the UI picks the balanced built-in for them.
 */
export function deleteActiveAutoSupportPreset(
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>,
): void {
  const activeId = getActiveAutoSupportPresetId();
  if (!activeId) return;
  deleteAutoSupportPreset(activeId);
  selectAutoSupportPreset('medium', setDraft);
}

/**
 * Writes one preset to a file: the native save dialog in the desktop shell, a
 * download otherwise. The `savePrintArtifactWithNativeDialog` mechanism (and its
 * cancel-is-not-an-error rule) matches the theme profile exporter.
 */
async function exportPresetToFile(id: string): Promise<void> {
  const preset = getAutoSupportPreset(id);
  if (!preset) return;

  const json = exportAutoSupportPresetToJson(id);
  const safeName = preset.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fileName = `${safeName || 'auto-support-preset'}.dragonfruit-auto-support.json`;

  if (isTauriRuntime()) {
    const bytes = new TextEncoder().encode(json);
    try {
      await savePrintArtifactWithNativeDialog(bytes, fileName);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message.toLowerCase().includes('cancel')) return;
      throw error;
    }
  }

  const blobUrl = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

/**
 * The collection and the live settings, as the preset UI reads them. Both stores
 * matter: the collection is the list, and the live settings are what
 * `isAutoSupportPresetDirty` compares the active preset against.
 *
 * The active id and the dirty flag are not part of the list snapshot, so each is
 * read through a subscription of its own. React Compiler treats a bare call to
 * an imported function as pure and evaluates it once, which would otherwise
 * freeze both at whatever they were when the component mounted — a selection
 * that never updates and a footer whose Save never enables.
 */
function useAutoSupportPresetState(): {
  presets: readonly AutoSupportPreset[];
  activeId: string | null;
  activePreset: AutoSupportPreset | undefined;
  dirty: boolean;
  live: AutoSupportSettings;
} {
  const presets = React.useSyncExternalStore(
    subscribeToAutoSupportPresets,
    getAutoSupportPresetsSnapshot,
    getAutoSupportPresetsServerSnapshot,
  );
  const activeId = React.useSyncExternalStore(
    subscribeToAutoSupportPresets,
    getActiveAutoSupportPresetId,
    getActiveAutoSupportPresetId,
  );
  const dirty = React.useSyncExternalStore(
    subscribeToAutoSupportPresets,
    isAutoSupportPresetDirty,
    isAutoSupportPresetDirty,
  );
  const live = React.useSyncExternalStore(subscribeToSettings, getSettings, getSettings).autoSupport;

  return {
    presets,
    activeId,
    activePreset: React.useMemo(() => (activeId ? getAutoSupportPreset(activeId) : undefined), [activeId]),
    dirty,
    live,
  };
}

type AutoSupportPresetSelectorProps = {
  /** The dialog's draft: what the modified marker is measured against. */
  draft: AutoSupportSettings;
  /** The dialog's draft setter, so a selection can be reflected in the fields. */
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
};

/**
 * The dialog's top strip: the selector, the three actions the reference keeps
 * beside it, and the dirty notice. Managing the collection is the selector's own
 * menu — there is no second surface to open.
 */
export function AutoSupportPresetSelector({ draft, setDraft }: AutoSupportPresetSelectorProps) {
  const { _ } = useLingui();
  const { presets, activeId, activePreset } = useAutoSupportPresetState();
  // The tier a preset names lives in Support Studio's collection, so the rows
  // resolve it from there — a renamed manual preset renames the row here too.
  const supportStudioPresets = useSupportStudioPresets();
  // "Modified" is everything uncommitted — a knob edit staged in the draft counts,
  // which is the case a user means when they say the preset is modified.
  const modified = useAutoSupportDialogChanges(draft);

  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  /** The name dialog, in the two modes the references' own dialog has. */
  const [nameDialog, setNameDialog] = React.useState<{ mode: 'create' | 'rename'; name: string } | null>(null);
  /** Import/export failures of any kind; the store's messages are shown verbatim. */
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const isBuiltIn = activePreset?.isBuiltIn === true;

  const presetOptions = presets.map((preset) => ({
    value: preset.id,
    // The trigger shows this label, so the modified marker rides on the name of
    // the preset that is actually dirty — and nowhere else.
    label: `${translateAutoSupportPresetName(preset, _)}${preset.id === activeId && modified ? ' *' : ''}`,
    // The active preset is the one the trigger is showing; the dropdown tints the
    // selected row, and the check names it in a list of same-shaped rows.
    icon: preset.id === activeId ? <Check className="h-3.5 w-3.5" /> : undefined,
    // The references label the type on the right (`Built-in` / `Custom`); the tier
    // the preset sizes with is the other fact a user picks by, so both ride there.
    rightContent: `${sizingTierName(preset.settings.sizingPreset, supportStudioPresets)} · ${preset.isBuiltIn ? _(msg`Built-in`) : _(msg`Custom`)}`,
  }));

  const applyImportedText = (text: string) => {
    try {
      importAutoSupportPresetFromJson(text);
      setErrorMessage(null);
      setDraft(getSettings().autoSupport);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const importFromFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void file.text().then(applyImportedText);
  };

  const importFromNativeDialog = async () => {
    try {
      const picked = await pickOpenFilesWithNativeDialog('bundle', false);
      const sourcePath = picked[0]?.path?.trim();
      if (!sourcePath) return;
      applyImportedText(new TextDecoder().decode(await readPrintArtifactBytesFromPath(sourcePath)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('cancel')) return;
      setErrorMessage(message);
    }
  };

  const confirmNameDialog = () => {
    if (!nameDialog) return;
    const name = nameDialog.name.trim();
    if (name.length === 0) return;
    if (nameDialog.mode === 'create') {
      createAutoSupportPreset(name);
    } else if (activePreset && !activePreset.isBuiltIn) {
      renameAutoSupportPreset(activePreset.id, name);
    }
    setNameDialog(null);
    setDraft(getSettings().autoSupport);
  };

  return (
    <section
      className="rounded-xl border p-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
    >
      {/* One row: the selector, then the three actions the reference keeps
          beside it. `New` is the menu's own entry. */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SelectDropdown
            value={activeId ?? ''}
            options={activeId
              ? presetOptions
              : [{ value: '', label: _(NO_ACTIVE_PRESET_LABEL), disabled: true }, ...presetOptions]}
            onChange={(id) => selectAutoSupportPreset(id, setDraft)}
            ariaLabel={modified ? _(msg`Auto-support preset, modified`) : _(msg`Auto-support preset`)}
            title={modified
              ? _(msg`The settings no longer match this preset. Save overwrites it; Reset reloads it.`)
              : _(msg`The saved run policy the settings below are. Selecting one applies it immediately; the rest of the dialog stays staged until you save.`)}
            className="space-y-0"
            selectClassName="w-full !h-8 pl-2.5 pr-10 leading-tight text-[12px]"
            menuClassName="max-w-[26rem]"
            menuFooterAction={{
              label: _(NEW_PRESET_ENTRY),
              icon: <Plus className="h-3.5 w-3.5" />,
              tone: 'accent',
              onClick: () => setNameDialog({ mode: 'create', name: _(NEW_PRESET_NAME) }),
            }}

          />
        </div>

        <Button
          onClick={() => {
            if (activePreset && !activePreset.isBuiltIn) {
              setNameDialog({ mode: 'rename', name: activePreset.name });
            }
          }}
          disabled={!activePreset || isBuiltIn}
          variant="secondary"
          size="auto"
          className={STRIP_BUTTON}
          title={isBuiltIn
            ? _(msg`A built-in's name is translated and cannot be renamed`)
            : _(msg`Rename the selected preset`)}
        >
          <PenLine className="h-3.5 w-3.5" />
          {_(msg`Rename`)}
        </Button>
        <Button
          onClick={() => {
            if (activeId) duplicateAutoSupportPreset(activeId);
          }}
          disabled={!activeId}
          variant="secondary"
          size="auto"
          className={STRIP_BUTTON}
          title={_(msg`Copy the selected preset under a new name`)}
        >
          <Copy className="h-3.5 w-3.5" />
          {_(msg`Duplicate`)}
        </Button>
        <Button
          onClick={() => {
            if (!activeId) return;
            void exportPresetToFile(activeId).catch((error: unknown) => {
              setErrorMessage(error instanceof Error ? error.message : String(error));
            });
          }}
          disabled={!activeId}
          variant="secondary"
          size="auto"
          className={STRIP_BUTTON}
          title={_(msg`Export the selected preset as a JSON file`)}
        >
          <Download className="h-3.5 w-3.5" />
          {_(msg`Export`)}
        </Button>
        <Button
          onClick={() => {
            if (isTauriRuntime()) {
              void importFromNativeDialog();
              return;
            }
            importInputRef.current?.click();
          }}
          variant="secondary"
          size="auto"
          className={STRIP_BUTTON}
          title={_(msg`Import a preset from a JSON file, and apply it`)}
        >
          <Upload className="h-3.5 w-3.5" />
          {_(msg`Import`)}
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          onChange={importFromFile}
          className="hidden"
          aria-label={_(msg`Auto-support preset file`)}
        />
      </div>

      {errorMessage && (
        <div
          className="mt-2 rounded-md border px-2 py-1.5"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
            color: 'var(--danger)',
          }}
          role="alert"
        >
          <span className="text-[10px] leading-snug break-words">{errorMessage}</span>
        </div>
      )}

      <StructuredDialogModal
        open={nameDialog != null}
        ariaLabel={nameDialog?.mode === 'create' ? _(msg`Create preset`) : _(msg`Rename preset`)}
        title={nameDialog?.mode === 'create' ? _(msg`New Preset`) : _(msg`Rename Preset`)}
        subtitle={nameDialog?.mode === 'create'
          ? _(msg`The current settings are saved under this name, and it becomes the selected preset.`)
          : _(msg`The selected preset is renamed; its settings are not touched.`)}
        icon={<PenLine className="h-4 w-4" />}
        iconTone="accent"
        onClose={() => setNameDialog(null)}
        onBackdropClick={() => setNameDialog(null)}
        actions={
          <>
            <Button
              onClick={() => setNameDialog(null)}
              variant="secondary"
              size="md"
              title={_(msg`Leave the collection as it is`)}
            >
              {_(msg`Cancel`)}
            </Button>
            <Button
              onClick={confirmNameDialog}
              disabled={(nameDialog?.name.trim().length ?? 0) === 0}
              size="md"
              className="inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
              style={SAVE_STYLE}
              title={nameDialog?.mode === 'create'
                ? _(msg`Create the preset and select it`)
                : _(msg`Rename the selected preset`)}
            >
              <Check className="h-3.5 w-3.5" />
              {nameDialog?.mode === 'create' ? _(msg`Create`) : _(msg`Save Name`)}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <label
            className="block text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--text-muted)' }}
          >
            {_(msg`Preset name`)}
          </label>
          <input
            type="text"
            value={nameDialog?.name ?? ''}
            onChange={(event) => setNameDialog((current) => (current ? { ...current, name: event.target.value } : current))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation();
                confirmNameDialog();
              }
            }}
            className="ui-input h-9 w-full text-xs"
            placeholder={_(NEW_PRESET_NAME)}
            aria-label={_(msg`Preset name`)}
          />
        </div>
      </StructuredDialogModal>
    </section>
  );
}

/**
 * Whether the dialog holds anything uncommitted: the live settings have drifted
 * from the active preset, or the draft differs from the live settings — a knob
 * edit lives in the draft until Save writes it, so the preset's own dirty flag is
 * not the whole question.
 *
 * Exported because the shell's close path asks the same question before it
 * discards the draft, and the footer's Save/Reset key off it.
 */
export function useAutoSupportDialogChanges(draft: AutoSupportSettings): boolean {
  const { dirty, live } = useAutoSupportPresetState();
  // Policy keys only: a flipped diagnostic is a view switch, not an edit, so it
  // never puts the dialog in the "save or discard?" state (see
  // `DIAGNOSTIC_AUTO_SUPPORT_KEYS`).
  const draftDiffersFromLive = React.useMemo(
    () => autoSupportPolicyDiffers(draft, live),
    [draft, live],
  );
  return dirty || draftDiffersFromLive;
}

type AutoSupportSettingsFooterActionsProps = {
  /** The dialog's draft — what Save commits and Reset discards. */
  draft: AutoSupportSettings;
  setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>>;
};

/**
 * The dialog footer's actions, in the reference's arrangement: the destructive
 * one alone on the left, `Reset` and `Save` on the right.
 *
 * `Save` is the dialog's commit — it writes the settings *and* the active preset
 * when the draft has drifted from it (one call, `commitAutoSupportSettings`), the
 * way the material editor's `Save Material` commits its own draft. It leaves the
 * dialog open and acknowledges with the button itself, because the preset list is
 * behind the dialog: a save that closed the dialog would leave the user to find out
 * later whether the star cleared. `Reset` is the LUT's: it discards the dialog's
 * uncommitted changes by reloading the active preset. Both are enabled only when
 * there is something to commit or discard, which includes an edit that is staged in
 * the draft but not yet written anywhere.
 */
export function AutoSupportSettingsFooterActions({
  draft,
  setDraft,
}: AutoSupportSettingsFooterActionsProps) {
  const { _ } = useLingui();
  const { activePreset, dirty } = useAutoSupportPresetState();
  const [pendingDelete, setPendingDelete] = React.useState(false);
  /**
   * The save's acknowledgement. The dialog stays open after a commit — the preset
   * list is where the result shows, and a dialog that vanishes leaves the star it
   * was supposed to clear to be discovered later — so the button is what says the
   * write landed. Two seconds of it, then back to the button.
   */
  const [saved, setSaved] = React.useState(false);
  const savedTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
  }, []);

  const isBuiltIn = activePreset?.isBuiltIn === true;
  const hasChanges = useAutoSupportDialogChanges(draft);

  const handleSave = React.useCallback(() => {
    // One call: the live settings and the preset they belong to are one decision
    // (see `commitAutoSupportSettings`).
    commitAutoSupportSettings(draft);
    setDraft(getSettings().autoSupport);
    setSaved(true);
    if (savedTimeoutRef.current !== null) window.clearTimeout(savedTimeoutRef.current);
    savedTimeoutRef.current = window.setTimeout(() => {
      setSaved(false);
      savedTimeoutRef.current = null;
    }, 2000);
  }, [draft, setDraft]);

  return (
    <>
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 shrink-0"
        style={{
          borderTop: '1px solid var(--border-subtle)',
          background: 'color-mix(in srgb, var(--surface-1), transparent 10%)',
        }}
      >
        <Button
          onClick={() => setPendingDelete(true)}
          disabled={!activePreset || isBuiltIn}
          variant="tinted-danger"
          size="md"
          className="inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed"
          title={isBuiltIn
            ? _(msg`Built-in presets cannot be deleted`)
            : _(msg`Delete the selected preset`)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {_(msg`Delete`)}
        </Button>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              resetToActivePreset();
              setDraft(getSettings().autoSupport);
            }}
            disabled={!hasChanges}
            variant="secondary"
            size="auto"
            className={FOOTER_BUTTON}
            title={_(msg`Discard the edits made in this dialog and reload the selected preset`)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {_(msg`Reset`)}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isBuiltIn}
            size="md"
            className="inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed"
            style={saved ? SAVED_STYLE : (!hasChanges || isBuiltIn ? undefined : SAVE_STYLE)}
            title={saved
              ? _(msg`Saved`)
              : isBuiltIn
                ? _(msg`A built-in preset cannot be saved over — Duplicate it to make it yours`)
                : dirty
                  ? _(msg`Write these settings, and overwrite the selected preset with them`)
                  : _(msg`Write these settings to the auto-support settings`)}
          >
            {saved && <Check className="h-3.5 w-3.5" />}
            {saved ? _(msg`Saved!`) : _(msg`Save`)}
          </Button>
        </div>
      </div>

      <StructuredDialogModal
        open={pendingDelete && activePreset != null}
        ariaLabel={_(msg`Delete preset`)}
        title={activePreset ? formatDeletePresetTitle(activePreset.name, _) : ''}
        subtitle={_(msg`This cannot be undone.`)}
        iconTone="danger"
        onClose={() => setPendingDelete(false)}
        onBackdropClick={() => setPendingDelete(false)}
        actions={
          <>
            <Button
              onClick={() => setPendingDelete(false)}
              variant="secondary"
              size="md"
              title={_(msg`Keep the preset`)}
            >
              {_(msg`Cancel`)}
            </Button>
            <Button
              onClick={() => {
                deleteActiveAutoSupportPreset(setDraft);
                setPendingDelete(false);
              }}
              size="md"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--danger), var(--surface-1) 88%)',
                color: 'var(--danger)',
              }}
              title={_(msg`Delete the preset`)}
            >
              {_(msg`Delete`)}
            </Button>
          </>
        }
      >
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {_(msg`The preset is removed from the list. The current settings are left as they are.`)}
        </p>
      </StructuredDialogModal>

    </>
  );
}
