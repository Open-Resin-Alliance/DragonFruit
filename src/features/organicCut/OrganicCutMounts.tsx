import * as React from 'react';
import {
  EditorContextMenu,
  ORGANIC_CUT_ADD_WAYPOINT_ITEM,
  ORGANIC_CUT_DELETE_WAYPOINT_ITEM,
} from '@/components/ui/EditorContextMenu';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import { OrganicCutTool } from './OrganicCutTool';
import { OrganicCutTenonGizmo } from './OrganicCutTenonGizmo';
import type { OrganicCutSession } from './useOrganicCutSession';
import { Trans } from '@lingui/react/macro';

/**
 * What every cut mount needs from the scene, and all it needs: which models are
 * on the plate, which one is active, and its live transform. Everything else
 * comes off the session.
 */
export interface OrganicCutMountSceneProps {
  models: React.ComponentProps<typeof OrganicCutTool>['models'];
  activeModelId: string | null;
  activeTransform: React.ComponentProps<typeof OrganicCutTool>['activeTransform'];
}

type SessionProp = { session: OrganicCutSession };

/**
 * The seam and its waypoints, in the scene. Mounts only while the Cut tool is
 * the active transform mode; the host decides that and renders this or nothing.
 */
export function OrganicCutToolMount({
  session,
  models,
  activeModelId,
  activeTransform,
}: SessionProp & OrganicCutMountSceneProps) {
  return (
    <OrganicCutTool
      models={models}
      activeModelId={activeModelId}
      activeTransform={activeTransform}
      active={!session.isApplying}
      cutLeakPoints={session.cutLeakPoints}
      loop={session.loop}
      onAddPoint={session.addPoint}
      onUpdatePoint={session.updatePoint}
      onDragStateChange={session.onDragStateChange}
      onLineHoverChange={session.onLineHoverChange}
      onLineClick={session.onLineClick}
      selectedIndex={session.selectedIndex}
      onSelectPoint={session.selectPoint}
      onToggleLockPoint={session.toggleLockPoint}
      onMarkerHoverChange={session.onMarkerHoverChange}
      geodesicPolyline={session.geodesicPolyline}
      planeCurves={session.planeCurves}
      inactiveLoopPolylines={session.inactiveLoopPolylines}
      cutMode={session.panelState.cutMode}
      membranePreview={session.membranePreview}
      tenonPreview={session.tenonPreview}
      tenonTriangleCount={session.tenonTriangleCount}
      tenonFits={session.tenonFits}
      tenonFrame={session.tenonFrame}
      tenonAnchor={session.panelState.tenonAnchor}
      tenonTiltRad={session.panelState.tenonTiltRad}
      tenonRollRad={session.panelState.tenonRollRad}
      showPreview={session.panelState.showPreview}
    />
  );
}

/**
 * The tenon's aim gizmo. Both cut modes place a tenon now, so it follows the
 * tenon rather than the mode: it mounts whenever there is a frame to sit on and
 * the preview is showing, and returns null otherwise.
 */
export function OrganicCutTenonGizmoMount({
  session,
  models,
  activeModelId,
  activeTransform,
}: SessionProp & OrganicCutMountSceneProps) {
  const { panelState, setPanelState } = session;
  const onTenonAnchorChange = React.useCallback(
    (anchor: OrganicCutSession['panelState']['tenonAnchor']) =>
      setPanelState({ ...panelState, tenonAnchor: anchor }),
    [panelState, setPanelState],
  );
  const onTenonAimChange = React.useCallback(
    (tilt: number, roll: number) =>
      setPanelState({ ...panelState, tenonTiltRad: tilt, tenonRollRad: roll }),
    [panelState, setPanelState],
  );
  const onDragStateChange = React.useCallback(
    (dragging: boolean) => session.onDragStateChange(dragging, 'tenon'),
    [session],
  );

  if (!session.tenonGizmoVisible || !session.tenonFrame) return null;
  return (
    <OrganicCutTenonGizmo
      models={models}
      activeModelId={activeModelId}
      activeTransform={activeTransform}
      tenonFrame={session.tenonFrame}
      tenonTiltRad={panelState.tenonTiltRad}
      tenonRollRad={panelState.tenonRollRad}
      tenonAnchor={panelState.tenonAnchor}
      membranePreview={session.membranePreview}
      onTenonAnchorChange={onTenonAnchorChange}
      onTenonAimChange={onTenonAimChange}
      onDragStateChange={onDragStateChange}
    />
  );
}

/**
 * The cut's DOM overlay: its own right-click menu ("Add waypoint here" on the
 * seam, "Delete waypoint" on a marker) and the double-click-to-lock hint that
 * follows the cursor over a waypoint.
 *
 * `toolActive` gates only the hint. The menu gates itself: it is open or it is
 * not, and it can only have been opened while the tool was active.
 */
export function OrganicCutOverlay({
  session,
  toolActive,
}: SessionProp & { toolActive: boolean }) {
  const { contextMenu } = session;
  return (
    <>
      <EditorContextMenu
        position={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        onAction={session.onContextMenuAction}
        title={contextMenu?.kind === 'delete' ? 'Waypoint' : 'Cut Seam'}
        items={
          contextMenu?.kind === 'delete'
            ? [ORGANIC_CUT_DELETE_WAYPOINT_ITEM]
            : [ORGANIC_CUT_ADD_WAYPOINT_ITEM]
        }
      />
      <MouseTooltip visible={toolActive && session.markerHover !== null}>
        <div
          className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg whitespace-nowrap"
          style={{
            background: 'rgba(24, 24, 24, 0.98)',
            color: 'var(--text-strong, #e0e0e0)',
            border: '1px solid var(--accent, #baf72e)',
            boxShadow: '0 6px 32px 0 rgba(0,0,0,0.44), 0 1.5px 8px 0 rgba(0,0,0,0.28)',
          }}
        >
          <Trans>Double-click to lock this waypoint from snapping.</Trans>
        </div>
      </MouseTooltip>
    </>
  );
}
