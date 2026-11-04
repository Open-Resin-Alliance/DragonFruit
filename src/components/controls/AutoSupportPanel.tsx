"use client";

import React from 'react';
import type * as THREE from 'three';
import { createPortal } from 'react-dom';
import { Settings, Settings2, X } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { forestReportToText, runAutoPlaceInWorker } from '@/supports/autoSupport';
import type { SizingDebugInfo, ForestReport } from '@/supports/autoSupport';
import { getSettings, subscribeToSettings, updateAutoSupportDiagnostic, updateDebugSimpleSupportRender } from '@/supports/Settings/state';
import {
  getActiveAutoSupportPresetId,
  getAutoSupportPresetsServerSnapshot,
  getAutoSupportPresetsSnapshot,
  subscribeToAutoSupportPresets,
} from '@/supports/Settings/autoSupportPresets';
import { getSnapshot, removeSupportEntitiesForModel } from '@/supports/state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { REPLACE_SUPPORTS_LABEL } from '@/supports/history/supportHistoryLabels';
import { AutoSupportSettingsBody } from './autoSupport/AutoSupportSettingsBody';
import { AutoSupportRunDiagnostics } from './autoSupport/AutoSupportRunDiagnostics';
import { AutoSupportPresetRow } from './autoSupport/AutoSupportPresetRow';
import { selectAutoSupportPreset, useAutoSupportDialogChanges } from './autoSupport/AutoSupportPresets';
import { AUTO_SUPPORT_SECTION_CARD, TIER_HINTS } from './autoSupport/autoSupportPanelTabs';
/** Set to true while auto-support is busy (scanning or placing).
 *  Page-level overlay reads this to show the "Generating Supports"
 *  full-screen modal, matching the native island-scan modal style. */
let _autoSupportBusy = false;
const _busyListeners = new Set<() => void>();

export function getAutoSupportBusy(): boolean { return _autoSupportBusy; }
export function subscribeAutoSupportBusy(fn: () => void): () => void {
  _busyListeners.add(fn);
  return () => _busyListeners.delete(fn);
}
function setAutoSupportBusy(v: boolean) {
  if (_autoSupportBusy !== v) {
    _autoSupportBusy = v;
    // The progress belongs to the run, so it goes when the run does.
    if (!v) setAutoSupportProgress(null);
    for (const fn of _busyListeners) fn();
  }
}

/** What the worker last reported, for the modal's progress bar. `null` while
 *  nothing is known (before the run starts, or after it ends). */
export type AutoSupportProgress = { phase: string; done: number; total: number };
let _autoSupportProgress: AutoSupportProgress | null = null;
const _progressListeners = new Set<() => void>();

export function getAutoSupportProgress(): AutoSupportProgress | null { return _autoSupportProgress; }
export function subscribeAutoSupportProgress(fn: () => void): () => void {
  _progressListeners.add(fn);
  return () => _progressListeners.delete(fn);
}
export function setAutoSupportProgress(p: AutoSupportProgress | null) {
  _autoSupportProgress = p;
  for (const fn of _progressListeners) fn();
}

/** Set to true while auto-support is driving its own scan, so the
 *  native island-scan overlay can be suppressed. */
export let autoSupportDrivingScan = false;

interface AutoSupportPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  activeModelId?: string;
  /** Auto-lift: the app's one flag for holding the model clear of the plate, so a
   *  support can stand under it. Owned by the transform manager and shared with
   *  the Prepare panel's own toggle (see `useTransformManager`). */
  autoLift: boolean;
  onAutoLiftChange: (enabled: boolean) => void;
  /** Resolve unapplied hollowing / hole punches before generating. Resolves
   *  false when the user went off to apply them first — the run is abandoned. */
  onBeforeRun?: () => Promise<boolean>;
  /** Resolve the model's cavity (void boundary) at run time. Read after
   *  `onBeforeRun` has applied any pending hollowing, so it must be a getter
   *  rather than a prop value captured when the panel rendered. */
  getCavityGeometry?: (modelId: string) => THREE.BufferGeometry | null;
}

export function AutoSupportPanel({ islands, hasGeometry, activeModelId, autoLift, onAutoLiftChange, onBeforeRun, getCavityGeometry }: AutoSupportPanelProps) {
  const { _ } = useLingui();
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showDiscardSettingsDialog, setShowDiscardSettingsDialog] = React.useState(false);
  const [showReplaceDialog, setShowReplaceDialog] = React.useState(false);
  // The last run's diagnostics are a view switch, not a setting: Debug mode in
  // the settings dialog is what shows them here, where a run is started. Panel
  // state, like the Debug button that used to sit in the debug row.
  const [debugMode, setDebugMode] = React.useState(false);
  const [sizingDebug, setSizingDebugState] = React.useState<SizingDebugInfo | null>(null);
  const [showForestReport, setShowForestReport] = React.useState(false);
  const [forestReport, setForestReportState] = React.useState<ForestReport | null>(null);
  // The active preset is the store's fact, not one derived from the settings: a
  // block that happens to equal a built-in's is not a preset the user picked, and
  // guessing it was would put a name on settings nobody tied to it.
  //
  // Both facts are subscribed rather than read once: React Compiler treats a bare
  // call to an imported function as pure and evaluates it once, which would freeze
  // the selector at whatever the store held when the panel mounted.
  const presets = React.useSyncExternalStore(
    subscribeToAutoSupportPresets,
    getAutoSupportPresetsSnapshot,
    getAutoSupportPresetsServerSnapshot,
  );
  const activePresetId = React.useSyncExternalStore(
    subscribeToAutoSupportPresets,
    getActiveAutoSupportPresetId,
    getActiveAutoSupportPresetId,
  );
  // Whether the selection is a built-in — the dialog locks its policy fields for one,
  // because the store refuses to save over a built-in, so an edit made on it could
  // never be kept. Derived from the subscribed snapshot, not read once, so it follows
  // a selection the way the selector does.
  const presetLocked = presets.find((preset) => preset.id === activePresetId)?.isBuiltIn === true;
  const supportSettings = React.useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
  const debugSimpleRender = supportSettings.debugSimpleSupportRender;

  const settings = getSettings().autoSupport;
  const [draft, setDraft] = React.useState(settings);

  const openSettings = React.useCallback(() => {
    setDraft(getSettings().autoSupport);
    setShowSettings(true);
  }, []);

  // Closing the dialog throws the draft away, so a dirty one asks first — the
  // same fact the footer's Save and Reset key off. The footer's Save does not come
  // through here: it does not close at all (the preset list behind the dialog is
  // where a save shows), so Escape, the backdrop and the ✕ are the whole of the
  // ask-first path.
  const settingsHaveChanges = useAutoSupportDialogChanges(draft);
  const closeSettings = React.useCallback(() => {
    if (settingsHaveChanges) {
      setShowDiscardSettingsDialog(true);
      return;
    }
    setShowSettings(false);
  }, [settingsHaveChanges]);
  // The dialog is the panel's own overlay, so it registers for Escape itself.
  useEscapeToClose(showSettings, closeSettings);


  const pendingRef = React.useRef(false);
  const islandsRef = React.useRef(islands);
  islandsRef.current = islands;

  // Runs on a worker thread: the plan is seconds of work on a big model, and
  // the panel used to block the main thread (and the modal) for all of it.
  const runAutoSupports = React.useCallback(async (list: UseIslandsReturn['filteredIslands']) => {
    if (!activeModelId) return;
    try {
      const result = await runAutoPlaceInWorker(
        list,
        activeModelId,
        getSettings().autoSupport,
        setAutoSupportProgress,
        getCavityGeometry?.(activeModelId) ?? null,
      );
      if (result.analytics?.sizingDebug) setSizingDebugState(result.analytics.sizingDebug);
      if (result.analytics?.forestReport) setForestReportState(result.analytics.forestReport);
    } catch (e) {
      console.error('[AutoSupport] runAutoPlace failed:', e);
    }
  }, [activeModelId, getCavityGeometry]);

  // Deferred run: fires after React flushes state changes (scan complete
  // or snapshot clear).  Incrementing deferredRunRef triggers a re-render,
  // which gives us fresh islands.filteredIslands.
  React.useEffect(() => {
    if (!pendingRef.current) return;
    if (islands.scanning) return;
    pendingRef.current = false;
    autoSupportDrivingScan = false;
    const list = islands.filteredIslands;
    if (list.length > 0 && getSettings().autoSupport.enabled) {
      void runAutoSupports(list).finally(() => {
        setAutoSupportBusy(false);
        setBusy(false);
      });
    } else {
      setAutoSupportBusy(false);
      setBusy(false);
    }
  }, [islands.scanning, islands.filteredIslands, activeModelId, runAutoSupports]);

  const doRun = React.useCallback((replace: boolean) => {
    if (!activeModelId) return;
    if (replace) {
      // One cascade, so a dependent of another model goes too; the entry is a
      // snapshot because the auto-place that follows pushes its own.
      const before = captureSupportEditSnapshot();
      if (removeSupportEntitiesForModel(activeModelId) > 0) {
        pushSupportEditHistory(REPLACE_SUPPORTS_LABEL, before, captureSupportEditSnapshot());
      }
      // rAF fires after React flushes the snapshot, giving us
      // fresh islands.filteredIslands with updated supported flags.
      requestAnimationFrame(() => {
        setBusy(true);
        setAutoSupportBusy(true);
        requestAnimationFrame(() => {
          setTimeout(() => {
            try {
              const list = islandsRef.current.filteredIslands;
              const cur = islandsRef.current;
              if (list.length === 0 && cur.voxelIslands.length === 0 && cur.minimaIslands.length === 0) {
                pendingRef.current = true;
                autoSupportDrivingScan = true;
                void cur.onRunScan();
                return;
              }
              if (list.length > 0 && getSettings().autoSupport.enabled) {
                void runAutoSupports(list).finally(() => {
                  if (!pendingRef.current) {
                    setAutoSupportBusy(false);
                    setBusy(false);
                  }
                });
              } else {
                setAutoSupportBusy(false);
                setBusy(false);
              }
            } catch (e) {
              console.error('[AutoSupport] run failed:', e);
              setAutoSupportBusy(false);
              setBusy(false);
            }
          }, 0);
        });
      });
      return;
    }
    setBusy(true);
    setAutoSupportBusy(true);
    const list = islands.filteredIslands;
    // Need to scan first?
    if (list.length === 0 && islands.voxelIslands.length === 0 && islands.minimaIslands.length === 0) {
      pendingRef.current = true;
      autoSupportDrivingScan = true;
      void islands.onRunScan();
      return;
    }
    // Let React flush the busy state and the browser paint the modal
    // before the heavy synchronous work blocks the main thread.
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (list.length > 0 && getSettings().autoSupport.enabled) {
          void runAutoSupports(list).finally(() => {
            setAutoSupportBusy(false);
            setBusy(false);
          });
        } else {
          setAutoSupportBusy(false);
          setBusy(false);
        }
      }, 0);
    });
  }, [activeModelId, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, runAutoSupports]);

  const handleRun = React.useCallback(() => {
    if (!activeModelId || busy) return;
    void (async () => {
      // Unapplied holes / hollowing change the mesh a support run is about to
      // be placed against — ask before generating, not after.
      if (onBeforeRun && !(await onBeforeRun())) return;
      // Check for existing supports.
      const snap = getSnapshot();
      let hasSupports = false;
      for (const t of Object.values(snap.trunks)) {
        if (t.modelId === activeModelId) { hasSupports = true; break; }
      }
      if (!hasSupports) {
        for (const b of Object.values(snap.branches)) {
          if (b.modelId === activeModelId) { hasSupports = true; break; }
        }
      }
      if (hasSupports) {
        setShowReplaceDialog(true);
        return;
      }
      doRun(false);
    })();
  }, [activeModelId, busy, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, doRun, onBeforeRun]);

  const canRun = hasGeometry && !!activeModelId && !busy && !islands.scanning;

  return (
    <>
      <Card>
        <CardHeader
          left={(
            <>
              <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{_(msg`Auto Supports (Beta)`)}</h3>
            </>
          )}
          right={(
            <IconButton onClick={openSettings} className="!p-1.5" title={_(msg`Auto-support settings`)}>
              <Settings className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
            </IconButton>
          )}
        />


        {expanded && (
          <div className="px-2.5 pb-3 space-y-2.5">
            {/* Run button — always at top */}
            <Button
              onClick={() => { void handleRun(); }}
              disabled={!canRun}
              title={_(msg`Scan for islands if needed, then place automatic supports on this model`)}
              variant="secondary"
              size="auto"
              className="w-full !h-8 text-[11px] disabled:opacity-50"
              style={{
                borderColor: 'var(--accent)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                color: 'var(--accent)',
              }}
            >
              {busy ? _(msg`Running…`) : _(msg`Generate Supports`)}
            </Button>

            {/* Island counts */}
            <div className="rounded-md border p-2" style={AUTO_SUPPORT_SECTION_CARD}>
              <div className="grid grid-cols-3 gap-2 text-center">
                {([
                  { id: 'voxel', label: _(msg`Voxel`), count: islands.voxelIslands.length },
                  { id: 'minima', label: _(msg`Minima`), count: islands.minimaIslands.length },
                  { id: 'total', label: _(msg`Total`), count: islands.filteredIslands.length },
                ]).map((s) => (
                  <div key={s.id}>
                    <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
                    <div className="text-sm font-bold" style={{ color: s.id === 'total' ? 'var(--accent)' : 'var(--text-strong)' }}>
                      {islands.scanning ? '…' : s.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Run-policy selector: every preset the store holds, built-in and
                custom alike, so a profile a user saved is pickable from the panel
                rather than only from the dialog. Selecting one applies the whole
                block (the store's contract) and copies it into the dialog's draft;
                the trunk preset (manual placement) is deliberately not touched.
                Beside it, the Auto-Lift flag the run's clearance depends on. */}
            <AutoSupportPresetRow
              presets={presets}
              activeId={activePresetId}
              onSelect={(id) => selectAutoSupportPreset(id, setDraft)}
              activeHint={activePresetId ? TIER_HINTS[activePresetId] : undefined}
              autoLift={autoLift}
              onAutoLiftChange={onAutoLiftChange}
            />

            {/* The last run's diagnostics, behind Debug mode in the settings
                dialog: the panel is where a run is started, so it is where its
                report is read. */}
            {debugMode && (
              <AutoSupportRunDiagnostics
                sizingDebug={sizingDebug}
                forestReport={forestReport}
                onShowForestReport={() => setShowForestReport(true)}
              />
            )}

            {!hasGeometry && (
              <div className="text-[10px] italic text-center" style={{ color: 'var(--text-muted)' }}>
                {_(msg`Load a model and scan for islands.`)}
              </div>
            )}
          </div>
        )}
      </Card>

      <StructuredDialogModal
        open={showForestReport}
        ariaLabel={_(msg`Forest Report`)}
        title={_(msg`Forest Report`)}
        subtitle={_(msg`Every placed support with its size and fan-out groups`)}
        iconTone="neutral"
        maxWidthClassName="max-w-[72rem]"
        onClose={() => setShowForestReport(false)}
        onBackdropClick={() => setShowForestReport(false)}
        actions={
          <>
            <Button
              onClick={() => {
                if (forestReport) {
                  void navigator.clipboard?.writeText(forestReportToText(forestReport));
                }
              }}
              variant="secondary"
              size="md"
              title={_(msg`Copy the whole report to the clipboard`)}
            >
              {_(msg`Copy`)}
            </Button>
            <Button
              onClick={() => setShowForestReport(false)}
              variant="secondary"
              size="md"
              title={_(msg`Close the report`)}
            >
              {_(msg`Close`)}
            </Button>
          </>
        }
      >
        {forestReport && (
          <div className="rounded-md border overflow-hidden" style={AUTO_SUPPORT_SECTION_CARD}>
            <pre
              className="px-3 py-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words tabular-nums overflow-y-auto"
              style={{ color: 'var(--text-muted)', maxHeight: '70vh' }}
            >
              {forestReportToText(forestReport)}
            </pre>
          </div>
        )}
      </StructuredDialogModal>

      {showSettings && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/58 backdrop-blur-sm p-5 ui-modal-backdrop-enter"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSettings();
          }}
        >
          <div
            className="w-full max-w-[1120px] h-full flex flex-col rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter"
            style={{ background: 'var(--surface-0)', borderColor: 'var(--border-strong)' }}
            role="dialog"
            aria-modal="true"
            aria-label={_(msg`Auto-support settings`)}
          >
            <div className="flex items-center justify-between gap-4 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent), var(--surface-1) 84%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%))',
                  }}
                >
                  <Settings2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {_(msg`Auto Supports (Beta) Settings`)}
                  </h2>
                  <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                    {_(msg`Detected surfaces, density and sizing, stability, and the saved presets a run follows`)}
                  </p>
                </div>
              </div>
              <IconButton
                variant="solid"
                size="sm"
                onClick={closeSettings}
                className="inline-flex shrink-0 items-center justify-center leading-none !p-0"
                aria-label={_(msg`Close dialog`)}
                title={_(msg`Close without applying the edits made in this dialog`)}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>

            <AutoSupportSettingsBody
              draft={draft}
              setDraft={setDraft}
              debugSimpleRender={debugSimpleRender}
              onToggleDebugSimpleRender={() => updateDebugSimpleSupportRender(!debugSimpleRender)}
              diagnostics={{
                debugSupportOriginColors: supportSettings.autoSupport.debugSupportOriginColors,
                debugSkipAutoBracing: supportSettings.autoSupport.debugSkipAutoBracing,
              }}
              onToggleDiagnostic={(key, enabled) => {
                // Applied at once, so closing the dialog does not ask whether to
                // discard a view switch. The draft follows, or a later Save would
                // write the value the toggle just replaced.
                updateAutoSupportDiagnostic(key, enabled);
                setDraft((current) => ({ ...current, [key]: enabled }));
              }}
              debugMode={debugMode}
              onToggleDebugMode={() => setDebugMode((current) => !current)}
              presetLocked={presetLocked}
            />
          </div>
        </div>,
        document.body,
      )}

      <StructuredDialogModal
        open={showDiscardSettingsDialog}
        ariaLabel={_(msg`Discard auto-support settings changes`)}
        title={_(msg`Discard Changes?`)}
        subtitle={_(msg`The edits made in this dialog have not been saved.`)}
        iconTone="warning"
        zIndexClassName="z-[120]"
        onClose={() => setShowDiscardSettingsDialog(false)}
        onBackdropClick={() => setShowDiscardSettingsDialog(false)}
        actions={
          <>
            <Button
              onClick={() => setShowDiscardSettingsDialog(false)}
              variant="secondary"
              size="md"
              title={_(msg`Go back to the settings dialog`)}
            >
              {_(msg`Keep Editing`)}
            </Button>
            <Button
              onClick={() => {
                setShowDiscardSettingsDialog(false);
                setDraft(getSettings().autoSupport);
                setShowSettings(false);
              }}
              size="md"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--danger), var(--surface-1) 88%)',
                color: 'var(--danger)',
              }}
              title={_(msg`Close the dialog and discard the edits`)}
            >
              {_(msg`Discard`)}
            </Button>
          </>
        }
      >
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {_(msg`Closing now leaves the auto-support settings as they are. Save in the dialog's footer writes them.`)}
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showReplaceDialog}
        ariaLabel={_(msg`Existing Supports Detected`)}
        title={_(msg`Existing Supports Detected`)}
        subtitle={_(msg`This model already has supports. How would you like to proceed?`)}
        iconTone="neutral"
        onClose={() => setShowReplaceDialog(false)}
        onBackdropClick={() => setShowReplaceDialog(false)}
        actions={
          <>
            <Button
              onClick={() => setShowReplaceDialog(false)}
              variant="secondary"
              size="md"
              title={_(msg`Keep the existing supports and do nothing`)}
            >
              {_(msg`Cancel`)}
            </Button>
            <Button
              onClick={() => { setShowReplaceDialog(false); doRun(false); }}
              variant="secondary"
              size="md"
              title={_(msg`Keep the existing supports and place the new ones around them`)}
            >
              {_(msg`Add to existing`)}
            </Button>
            <Button
              onClick={() => { setShowReplaceDialog(false); doRun(true); }}
              variant="tinted-accent"
              size="md"
              className="inline-flex items-center justify-center gap-1.5"
              title={_(msg`Delete this model's existing supports and place the new ones`)}
            >
              {_(msg`Replace all`)}
            </Button>
          </>
        }
      >
        <div className="rounded-md border p-3" style={AUTO_SUPPORT_SECTION_CARD}>
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {_(msg`You can replace all existing supports with auto-placed ones, or incorporate your existing supports and fill in the gaps.`)}
          </p>
        </div>
      </StructuredDialogModal>
    </>
  );
}
