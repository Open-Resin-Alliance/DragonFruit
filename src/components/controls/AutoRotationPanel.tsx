"use client";

import React from 'react';
import * as THREE from 'three';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button, Card, CardHeader } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { getModelMesh } from '@/supports/autoSupport/meshStore';
import {
  suggestOrientationForGeometry,
  composeLeanBack,
  composeOrientationDelta,
  type OrientationObjective,
} from '@/supports/autoSupport/orientationAdvisor';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { OrientationToastReport } from '@/features/notifications/useEditorToasts';
import {
  getSupportBlockedCount,
  clearSupportBlockers,
  getSupportBlockedTriangles,
  subscribeSupportBlockers,
  getSupportBlockersVersion,
  getSupportBlockerBrushSizeMm,
  setSupportBlockerBrushSizeMm,
  SUPPORT_BLOCKER_BRUSH_MIN_MM,
  SUPPORT_BLOCKER_BRUSH_MAX_MM,
} from '@/supports/autoSupport/supportBlockers';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';

/** Set while an orient sweep runs. Page-level overlay reads this to show the
 *  "Orienting Model" modal. Module-level (not state) so the panel can flip it
 *  around the synchronous sweep; the page subscribes via the stable getter.
 *  Mirrors the auto-support busy chain in AutoSupportPanel. */
let _orientationBusy = false;
const _orientationBusyListeners = new Set<() => void>();

export function getOrientationBusy(): boolean { return _orientationBusy; }
export function subscribeOrientationBusy(fn: () => void): () => void {
  _orientationBusyListeners.add(fn);
  return () => _orientationBusyListeners.delete(fn);
}
function setOrientationBusy(v: boolean): void {
  if (_orientationBusy !== v) {
    _orientationBusy = v;
    for (const fn of _orientationBusyListeners) fn();
  }
}

/** Elapsed timer for the orient busy modal. Mounts with the modal so the
 *  interval lifetime matches visibility exactly (same shape as the islands
 *  timer: 250 ms ticks, m:ss label). */
export function OrientElapsed() {
  const [sec, setSec] = React.useState(0);
  React.useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => setSec(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => window.clearInterval(id);
  }, []);
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  const elapsed = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  return <Trans>Elapsed: {elapsed}</Trans>;
}

/** Module-level labels (React Compiler must not rename Lingui locals). */
const TITLE = msg`Auto Orientation (Beta)`;
const ORIENT = msg`Orient Model`;
const OPTIMIZE_FOR = msg`Optimize orientation for`;
const OPT_SUPPORTS = msg`Least surface past the critical angle (fewest supports)`;
const OPT_HEIGHT = msg`Shortest print time (lowest Z height)`;
const OPT_FOOTPRINT = msg`Most parts per plate (smallest footprint)`;
const OPT_FLAT_FACE = msg`Largest flat surface down`;
const OPT_ISLANDS = msg`Fewest islands`;
const OPT_UNSUPPORTED_VOLUME = msg`Least unsupported volume (inkjet/FDM)`;
const OPT_SCARRING = msg`Least scarring`;
const OPT_LEAN_BACK = msg`Lean back, front up (minis)`;
const ORIENTATIONS_TRIED = msg`Orientations tried`;
const CRITICAL_ANGLE = msg`Critical build angle`;
const LEAN_RANGE = msg`Lean back`;
const RESET = msg`Reset`;
const LEAN_BACK_HINT = msg({
  message: 'Tips the top back so the front faces up and the supports go on the back, choosing the angle in this range that needs the fewest supports. Assumes the model was loaded upright with its front toward the viewer; turning it on the plate is kept.',
  comment: 'Tooltip on the Lean back option of Auto Orientation, meant for miniatures.',
});
const NO_MODEL = msg`Load a model to get an orientation suggestion.`;
const NO_GEOMETRY = msg`Active model has no readable geometry.`;
const BLOCKERS = msg`Blockers`;
const CLEAR_BLOCKERS = msg`Clear`;
const DONE_BLOCKERS = msg`Done`;
const PAINT_LEAD = msg`Paint areas to keep support-free. Orientation avoids them.`;
const BLOCKERS_HINT = msg`Paint nogo areas for supports. Blocked contact is refused when generating supports and avoided when orienting.`;
const PAINT_TITLE = msg`Blocker Painting Mode`;
const BLOCKER_ACTION_TEXT = { color: 'var(--accent-secondary-action-color)', fontWeight: 600 } as const;
const BRUSH_SIZE = msg`Brush Size`;

/** The goals in the order Formware lists them, then DragonFruit's own. */
const OBJECTIVE_OPTIONS: Array<{ value: OrientationObjective; label: typeof OPT_SUPPORTS }> = [
  { value: 'supports', label: OPT_SUPPORTS },
  { value: 'height', label: OPT_HEIGHT },
  { value: 'footprint', label: OPT_FOOTPRINT },
  { value: 'flatFace', label: OPT_FLAT_FACE },
  { value: 'islands', label: OPT_ISLANDS },
  { value: 'unsupportedVolume', label: OPT_UNSUPPORTED_VOLUME },
  { value: 'scarring', label: OPT_SCARRING },
  { value: 'leanBack', label: OPT_LEAN_BACK },
];

/** Defaults the Reset button restores; the advisor uses the same ones when unset. */
const DEFAULT_ORIENT_SETTINGS = {
  candidateCount: 120,
  criticalAngleDeg: 45,
  leanMinDeg: 10,
  leanMaxDeg: 45,
};
/** A lean-back result this close to the current pose is the current pose. */
const SAME_POSE_RAD = (0.5 * Math.PI) / 180;

export interface AutoRotationPanelProps {
  activeModelId?: string;
  /** Live scene rotation (world frame the suggestion is computed in). */
  currentRotation?: THREE.Euler;
  /** Scene-owned apply: moves the model AND its supports, with history. */
  onApplyRotation?: (modelId: string, rotation: THREE.Euler) => void;
  /** Display name for the toast receipt; falls back to the model id. */
  activeModelName?: string;
  /** Shell-toast receipt for the orient run (data only — the stack renders it). */
  onOrientationReport?: (report: Omit<OrientationToastReport, 'id'>) => void;
  /**
   * Gate before a destructive apply: receives the apply continuation. Returns
   * true when the apply may run immediately (no dialog); false means the gate
   * kept the continuation and will run it after confirm. Absent → apply directly.
   */
  onBeforeOrientApply?: (continueApply: () => void) => boolean;
  /** Whether the scene is in support-blocker paint mode. */
  blockersActive?: boolean;
  /** Toggles support-blocker paint mode in the scene. */
  onToggleBlockers?: () => void;
}
export function AutoRotationPanel({ activeModelId, activeModelName, currentRotation, onApplyRotation, onOrientationReport, onBeforeOrientApply, blockersActive, onToggleBlockers }: AutoRotationPanelProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  // Named exactly as the ICU placeholders in the blocker hint below: the Trans
  // macro takes the placeholder names from these identifiers.
  const clearLabel = _(CLEAR_BLOCKERS);
  const doneLabel = _(DONE_BLOCKERS);
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const brushSizeMm = getSupportBlockerBrushSizeMm();
  const [objective, setObjective] = React.useState<OrientationObjective>('supports');
  const [settings, setSettings] = React.useState(DEFAULT_ORIENT_SETTINGS);
  // Support-blocker mask version for the active model (drives Clear).
  React.useSyncExternalStore(subscribeSupportBlockers, getSupportBlockersVersion, getSupportBlockersVersion);
  const blockedCount = activeModelId ? getSupportBlockedCount(activeModelId) : 0;

  // A new model or goal clears a stale error.
  React.useEffect(() => {
    setError(null);
  }, [activeModelId, objective]);

  const handleOrient = React.useCallback(() => {
    setError(null);
    if (!activeModelId) {
      setError(_(NO_MODEL));
      return;
    }
    if (!onApplyRotation) return;
    setBusy(true);
    setOrientationBusy(true);
    // Let the modal paint before the synchronous sweep blocks the thread.
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          const mesh = getModelMesh(activeModelId);
          const position = mesh?.geometry?.attributes?.position;
          if (!mesh || !position) {
            setError(_(NO_GEOMETRY));
            return;
          }
          // Orient in world frame: bake the model's live scene rotation into a
          // throwaway copy (never mutate the live geometry). Lean back scores the
          // model as loaded instead: its result is absolute (see composeLeanBack).
          const leanBack = objective === 'leanBack';
          const baked = new Float32Array(position.array as ArrayLike<number>);
          if (currentRotation && !leanBack) {
            const v = new THREE.Vector3();
            for (let i = 0; i < baked.length; i += 3) {
              v.set(baked[i], baked[i + 1], baked[i + 2]).applyEuler(currentRotation);
              baked[i] = v.x;
              baked[i + 1] = v.y;
              baked[i + 2] = v.z;
            }
          }
          const index = (mesh.geometry.index?.array as ArrayLike<number> | undefined) ?? null;
          const blocked = getSupportBlockedTriangles(activeModelId);
          const result = suggestOrientationForGeometry(
            { attributes: { position: { array: baked } }, index },
            {
              objective,
              candidateCount: settings.candidateCount,
              selfSupportAngleDeg: settings.criticalAngleDeg,
              leanBackMinDeg: settings.leanMinDeg,
              leanBackMaxDeg: settings.leanMaxDeg,
              ...(blocked.size > 0 ? { blockedTriangleIndices: blocked } : {}),
            },
          );
          if (!result) {
            setError(_(NO_GEOMETRY));
            return;
          }
          // The scene apply path records history unconditionally, so only
          // apply a strict improvement — never a no-op rotation.
          const nextRotation = leanBack
            ? composeLeanBack(currentRotation, result.rotXDeg, result.rotYDeg)
            : composeOrientationDelta(currentRotation, result.rotXDeg, result.rotYDeg);
          const improved = leanBack
            ? quaternionFromGlobalEuler(nextRotation).angleTo(quaternionFromGlobalEuler(currentRotation)) > SAME_POSE_RAD
            : objective === 'height'
              ? result.suggested.heightMm < result.baseline.heightMm
              : result.suggested.cost < result.baseline.cost;
          if (!improved) {
            onOrientationReport?.({
              status: 'already-optimal',
              modelName: activeModelName ?? activeModelId,
            });
            return;
          }
          // Compose in the canonical frame (see composeOrientationDelta) so
          // the scene path moves supports along and records history.
          const doApply = () => {
            onApplyRotation(activeModelId, nextRotation);
            onOrientationReport?.({
              status: 'applied',
              modelName: activeModelName ?? activeModelId,
            });
          };
          if (!onBeforeOrientApply || onBeforeOrientApply(doApply)) doApply();
        } finally {
          setBusy(false);
          setOrientationBusy(false);
        }
      }, 0);
    });
  }, [activeModelId, activeModelName, currentRotation, objective, settings, onApplyRotation, onOrientationReport, onBeforeOrientApply, _]);

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{_(TITLE)}</h3>
          </>
        )}
      />

      {expanded && (
        <div className="px-2.5 pb-3 space-y-2.5">
          {blockersActive ? (
            <div
              className="rounded-md border p-2 space-y-1.5 text-center min-h-[4.5rem] box-border"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
              }}
            >
              <div className="ui-meta font-semibold" style={BLOCKER_ACTION_TEXT}>{_(PAINT_TITLE)}</div>
              <div className="flex items-start justify-center min-h-8">
                <p className="text-[10px] leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                  {_(PAINT_LEAD)}<br />
                  <Trans comment="Sits under the Blocker Painting Mode heading. {clearLabel} and {doneLabel} are the Clear and Done button labels; keep them as placeholders so the two always match the buttons.">
                    Press <span style={BLOCKER_ACTION_TEXT}>{clearLabel}</span> to reset all, or <span style={BLOCKER_ACTION_TEXT}>{doneLabel}</span> to apply.
                  </Trans>
                </p>
              </div>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button
                type="button"
                onClick={() => { void handleOrient(); }}
                disabled={busy || !activeModelId}
                size="auto"
                className="flex-1 !h-8 text-[11px] disabled:opacity-50"
                style={{
                  borderColor: 'var(--accent)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                  color: 'var(--accent)',
                }}
              >
                {busy ? _(msg`Analyzing…`) : _(ORIENT)}
              </Button>
              <Button
                type="button"
                onClick={() => { onToggleBlockers?.(); }}
                disabled={busy || !activeModelId || !onToggleBlockers}
                variant="secondary"
                size="auto"
                className="flex-1 !h-8 text-[11px] disabled:opacity-50"
                title={_(BLOCKERS_HINT)}
              >
                {_(BLOCKERS)}
              </Button>
            </div>
          )}
          {blockersActive ? (
            <div className="flex flex-col gap-1">
              <label className="ui-meta flex justify-between">
                <span>{_(BRUSH_SIZE)}</span>
                <span>{fmt.quantity(brushSizeMm, 1, 'mm')}</span>
              </label>
              <input
                type="range"
                min={SUPPORT_BLOCKER_BRUSH_MIN_MM}
                max={SUPPORT_BLOCKER_BRUSH_MAX_MM}
                step={0.5}
                value={brushSizeMm}
                onChange={(e) => setSupportBlockerBrushSizeMm(parseFloat(e.target.value))}
                disabled={busy || !activeModelId}
                className="ui-range"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <fieldset className="flex flex-col gap-1" disabled={busy || !activeModelId}>
                <legend className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>{_(OPTIMIZE_FOR)}</legend>
                {OBJECTIVE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-start gap-1.5 text-[11px] leading-snug cursor-pointer"
                    style={{ color: objective === option.value ? 'var(--text-strong)' : 'var(--text-muted)' }}
                    title={option.value === 'leanBack' ? _(LEAN_BACK_HINT) : undefined}
                  >
                    <input
                      type="radio"
                      name="orientation-objective"
                      className="mt-0.5"
                      checked={objective === option.value}
                      onChange={() => setObjective(option.value)}
                    />
                    <span>{_(option.label)}</span>
                  </label>
                ))}
              </fieldset>

              {objective === 'leanBack' ? (
                <div className="flex flex-col gap-1">
                  <label className="ui-meta flex justify-between">
                    <span>{_(LEAN_RANGE)}</span>
                    <span>{fmt.quantity(settings.leanMinDeg, 0, 'degree')} – {fmt.quantity(settings.leanMaxDeg, 0, 'degree')}</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={settings.leanMinDeg}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setSettings((prev) => ({ ...prev, leanMinDeg: v, leanMaxDeg: Math.max(prev.leanMaxDeg, v) }));
                    }}
                    disabled={busy || !activeModelId}
                    className="ui-range"
                  />
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={settings.leanMaxDeg}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setSettings((prev) => ({ ...prev, leanMaxDeg: v, leanMinDeg: Math.min(prev.leanMinDeg, v) }));
                    }}
                    disabled={busy || !activeModelId}
                    className="ui-range"
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <label className="ui-meta flex justify-between">
                    <span>{_(ORIENTATIONS_TRIED)}</span>
                    <span>{settings.candidateCount}</span>
                  </label>
                  <input
                    type="range"
                    min={16}
                    max={512}
                    step={8}
                    value={settings.candidateCount}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setSettings((prev) => ({ ...prev, candidateCount: v }));
                    }}
                    disabled={busy || !activeModelId}
                    className="ui-range"
                  />
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className="ui-meta flex justify-between">
                  <span>{_(CRITICAL_ANGLE)}</span>
                  <span>{fmt.quantity(settings.criticalAngleDeg, 0, 'degree')}</span>
                </label>
                <input
                  type="range"
                  min={20}
                  max={70}
                  step={1}
                  value={settings.criticalAngleDeg}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setSettings((prev) => ({ ...prev, criticalAngleDeg: v }));
                  }}
                  disabled={busy || !activeModelId}
                  className="ui-range"
                />
              </div>

              <Button
                type="button"
                variant="secondary"
                size="auto"
                className="!h-7 text-[11px] disabled:opacity-50"
                onClick={() => setSettings(DEFAULT_ORIENT_SETTINGS)}
                disabled={busy}
              >
                {_(RESET)}
              </Button>
            </div>
          )}
          {blockersActive && (
            <div className="flex gap-1.5">
              <Button
                type="button"
                onClick={() => { if (activeModelId) clearSupportBlockers(activeModelId); }}
                disabled={busy || blockedCount === 0}
                variant="secondary"
                size="auto"
                className="flex-1 !h-8 text-[11px] disabled:opacity-50"
              >
                {_(CLEAR_BLOCKERS)}
              </Button>
              <Button
                type="button"
                onClick={() => { onToggleBlockers?.(); }}
                disabled={busy}
                variant="accent"
                size="auto"
                className="flex-1 !h-8 text-[11px] disabled:opacity-50"
              >
                {_(DONE_BLOCKERS)}
              </Button>
            </div>
          )}

          {error && (
            <p className="text-[11px]" style={{ color: '#f87171' }}>{error}</p>
          )}
        </div>
      )}
    </Card>
  );
}
