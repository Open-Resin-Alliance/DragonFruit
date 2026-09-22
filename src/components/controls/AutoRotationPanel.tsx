"use client";

import React from 'react';
import * as THREE from 'three';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Card, CardHeader, IconButton, Select } from '@/components/atoms';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { getModelMesh } from '@/supports/autoSupport/meshStore';
import {
  suggestOrientationForGeometry,
  composeOrientationDelta,
  type OrientationObjective,
} from '@/supports/autoSupport/orientationAdvisor';
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
  return <>Elapsed: {minutes}:{seconds.toString().padStart(2, '0')}</>;
}

/** Module-level labels (React Compiler must not rename Lingui locals). */
const TITLE = msg`Auto Orientation (Beta)`;
const ORIENT = msg`Orient Model`;
const OPT_SUPPORTS = msg`Fewest Supports`;
const OPT_HEIGHT = msg`Shortest Print Time`;
const OPT_SCARRING = msg`Least Scarring`;
const NO_MODEL = msg`Load a model to get an orientation suggestion.`;
const NO_GEOMETRY = msg`Active model has no readable geometry.`;
const BLOCKERS = msg`Blockers`;
const CLEAR_BLOCKERS = msg`Clear`;
const DONE_BLOCKERS = msg`Done`;
const PAINT_LEAD = msg`Paint areas to keep support-free. Orientation avoids them.`;
const BLOCKERS_HINT = msg`Paint nogo areas for supports. Blocked contact is refused when generating supports and avoided when orienting.`;
const PAINT_TITLE = msg`Blocker Painting Mode`;
const PAINT_MID = msg`to reset all,`;
const PAINT_TAIL = msg`to apply.`;
const BRUSH_SIZE = msg`Brush Size`;

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
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const brushSizeMm = getSupportBlockerBrushSizeMm();
  const [objective, setObjective] = React.useState<OrientationObjective>('supports');
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
          // throwaway copy (never mutate the live geometry).
          const baked = new Float32Array(position.array as ArrayLike<number>);
          if (currentRotation) {
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
            { objective, ...(blocked.size > 0 ? { blockedTriangleIndices: blocked } : {}) },
          );
          if (!result) {
            setError(_(NO_GEOMETRY));
            return;
          }
          // The scene apply path records history unconditionally, so only
          // apply a strict improvement — never a no-op rotation.
          const improved =
            objective === 'height'
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
            onApplyRotation(activeModelId, composeOrientationDelta(currentRotation, result.rotXDeg, result.rotYDeg));
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
  }, [activeModelId, activeModelName, currentRotation, objective, onApplyRotation, onOrientationReport, onBeforeOrientApply, _]);

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              className="!p-0.5"
              title={expanded ? _(msg`Collapse card`) : _(msg`Expand card`)}
            >
              <svg className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
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
              <div className="ui-meta font-semibold" style={{ color: 'var(--accent-secondary-action-color)' }}>{_(PAINT_TITLE)}</div>
              <div className="flex items-start justify-center min-h-8">
                <p className="text-[10px] leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                  {_(PAINT_LEAD)}<br /><span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>{_(CLEAR_BLOCKERS)}</span> {_(PAINT_MID)} <span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>{_(DONE_BLOCKERS)}</span> {_(PAINT_TAIL)}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => { void handleOrient(); }}
                disabled={busy || !activeModelId}
                className="ui-button flex-1 !h-8 text-[11px] disabled:opacity-50"
                style={{
                  borderColor: 'var(--accent)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                  color: 'var(--accent)',
                }}
              >
                {busy ? _(msg`Analyzing…`) : _(ORIENT)}
              </button>
              <button
                type="button"
                onClick={() => { onToggleBlockers?.(); }}
                disabled={busy || !activeModelId || !onToggleBlockers}
                className="ui-button ui-button-secondary flex-1 !h-8 text-[11px] disabled:opacity-50"
                title={_(BLOCKERS_HINT)}
              >
                {_(BLOCKERS)}
              </button>
            </div>
          )}
          {blockersActive ? (
            <div className="flex flex-col gap-1">
              <label className="ui-meta flex justify-between">
                <span>{_(BRUSH_SIZE)}</span>
                <span>{brushSizeMm.toFixed(1)} mm</span>
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
            <div className="flex flex-col gap-1">
              <Select
                style={{ textAlign: 'center', background: 'var(--surface-1)' }}
                value={objective}
                onChange={(e) => setObjective(e.target.value as OrientationObjective)}
                disabled={busy || !activeModelId}
              >
                <option value="supports">{_(OPT_SUPPORTS)}</option>
                <option value="height">{_(OPT_HEIGHT)}</option>
                <option value="scarring">{_(OPT_SCARRING)}</option>
              </Select>
            </div>
          )}
          {blockersActive && (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => { if (activeModelId) clearSupportBlockers(activeModelId); }}
                disabled={busy || blockedCount === 0}
                className="ui-button ui-button-secondary flex-1 !h-8 text-[11px] disabled:opacity-50"
              >
                {_(CLEAR_BLOCKERS)}
              </button>
              <button
                type="button"
                onClick={() => { onToggleBlockers?.(); }}
                disabled={busy}
                className="ui-button ui-button-accent flex-1 !h-8 text-[11px] disabled:opacity-50"
              >
                {_(DONE_BLOCKERS)}
              </button>
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
