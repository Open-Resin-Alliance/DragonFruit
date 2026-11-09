import * as React from 'react';
import * as THREE from 'three';
import type { EditorMenuAction } from '@/components/ui/EditorContextMenu';
import {
  useOrganicCutHotkeys,
  useOrganicCutPreviewHotkey,
  type OrganicCutHotkeyState,
} from '@/hotkeys/useOrganicCutHotkeys';
import type { OrganicCutPanelState } from './OrganicCutPanel';
import type { OrganicCutLoopPoint } from './types';

/**
 * A hover on the seam line, reported by the tool: where on the seam the cursor
 * sits and which waypoint it follows. Both the left-click insert and the
 * right-click "Add waypoint here" act on it.
 */
export type OrganicCutSeamHover = {
  localPoint: [number, number, number];
  afterIndex: number;
};

/**
 * The cut's own right-click menu. One menu for both actions; `kind` selects
 * which item and which handler.
 */
export type OrganicCutContextMenuState =
  | { kind: 'add'; x: number; y: number; localPoint: [number, number, number]; afterIndex: number }
  | { kind: 'delete'; x: number; y: number; index: number };

/** What the pointer is holding during a cut drag. */
export type OrganicCutDragKind = 'seam' | 'tenon';

/**
 * Which of the two things the pointer has hold of, and for how long ago it let
 * go. Owned separately from the rest of the interaction because the session's
 * own preview and undo-coalescing effects read it, and they run long before the
 * waypoint commands it would otherwise depend on exist.
 */
export interface OrganicCutDragState {
  /** True while a waypoint or the tenon is being dragged (OrbitControls stays off). */
  dragging: boolean;
  /** True while that drag is the tenon's own rather than a seam waypoint's. */
  draggingTenon: boolean;
  onDragStateChange: (dragging: boolean, what?: OrganicCutDragKind) => void;
  /** When the last drag ended, so a click synthesized by its pointer-up can be swallowed. */
  lastDragEndRef: React.RefObject<number>;
}

/**
 * Everything the Cut tool needs from the pointer and the keyboard. Folded into
 * [`OrganicCutSession`], so the host renders the tool and forwards two events
 * rather than holding this state itself.
 */
export interface OrganicCutInteraction {
  /** Surface pick from the StlMesh click pipeline: places or deselects a waypoint. */
  onSurfaceClick: (hit: THREE.Intersection) => void;
  /** Left-click on the seam line: inserts a waypoint where it was clicked. */
  onLineClick: (info: OrganicCutSeamHover) => void;
  onLineHoverChange: (info: OrganicCutSeamHover | null) => void;
  onMarkerHoverChange: (index: number | null) => void;
  /** Which waypoint the pointer is over, for the double-click-to-lock hint. */
  markerHover: number | null;
  contextMenu: OrganicCutContextMenuState | null;
  /**
   * Open the cut's own right-click menu if the pointer is over a waypoint marker
   * (→ "Delete waypoint") or the seam (→ "Add waypoint here"). Returns true when
   * it claimed the event, so the host's model/support menu stands down.
   *
   * Stable across renders and driven off refs: the host's right-click handler is
   * declared long before the session exists.
   */
  tryOpenContextMenu: (event: { clientX: number; clientY: number }) => boolean;
  onContextMenuAction: (action: EditorMenuAction) => void;
  /** Dismissal for the cut's menu — outside click, Escape, resize, or a chosen row. */
  closeContextMenu: () => void;
}

export interface UseOrganicCutInteractionArgs {
  toolActive: boolean;
  drag: OrganicCutDragState;
  /** The model waypoints are placed on; a pick on anything else is ignored. */
  activeModelId: string | null;
  selectedIndex: number | null;
  addPoint: (point: OrganicCutLoopPoint) => void;
  insertPoint: (afterIndex: number, point: OrganicCutLoopPoint) => void;
  removePoint: (index: number) => void;
  selectPoint: (index: number | null) => void;
  panelState: OrganicCutPanelState;
  setPanelState: (next: OrganicCutPanelState) => void;
}

/**
 * How long after a drag ends a surface click is still swallowed (ms). A
 * pointer-up after a drag still synthesizes a `click` on the model beneath,
 * which would add a waypoint on top of the one just moved.
 */
const CLICK_AFTER_DRAG_GRACE_MS = 250;

/**
 * The drag half of the interaction, on its own so the session can declare it
 * before the effects that read it. See [`OrganicCutDragState`].
 */
export function useOrganicCutDragState(): OrganicCutDragState {
  // True while a cut waypoint is being dragged, so OrbitControls stays disabled
  // for the duration of the drag (camera must not move while editing the seam).
  const [dragging, setDragging] = React.useState(false);
  // WHICH of the two the pointer has hold of. Dragging a waypoint moves the seam,
  // and the cut face travels out from under the tenon; dragging the tenon itself
  // does not move the face at all. They are both "a cut drag" for OrbitControls
  // and for undo coalescing, and they are not the same thing at all for the tenon.
  const [draggingTenon, setDraggingTenon] = React.useState(false);
  const lastDragEndRef = React.useRef(0);

  const onDragStateChange = React.useCallback(
    (next: boolean, what: OrganicCutDragKind = 'seam') => {
      if (!next) lastDragEndRef.current = Date.now();
      setDraggingTenon(next && what === 'tenon');
      setDragging(next);
    },
    [],
  );

  return { dragging, draggingTenon, onDragStateChange, lastDragEndRef };
}

export function useOrganicCutInteraction({
  toolActive,
  drag,
  activeModelId,
  selectedIndex,
  addPoint,
  insertPoint,
  removePoint,
  selectPoint,
  panelState,
  setPanelState,
}: UseOrganicCutInteractionArgs): OrganicCutInteraction {
  const { dragging, lastDragEndRef } = drag;

  // Surface picking for the Cut tool rides the SAME StlMesh click pipeline as
  // hole-punch (camera/orbit/gizmo aware), rather than a separate pick mesh.
  // Convert the hit into a model-LOCAL loop point (matches the mesh object's own
  // geometry space) so the stored loop is independent of the plate transform.
  const onSurfaceClick = React.useCallback(
    (hit: THREE.Intersection) => {
      // Ignore the click synthesized by a waypoint drag's pointer-up — it would
      // add a duplicate point on top of the one we just moved. (Also covers the
      // brief moment after the drag where `dragging` has already reset.)
      if (dragging || Date.now() - lastDragEndRef.current < CLICK_AFTER_DRAG_GRACE_MS) {
        return;
      }
      if (!activeModelId) return;
      const hitModelId = (hit.object.userData?.modelId as string | undefined) ?? activeModelId;
      if (hitModelId !== activeModelId) return;

      // If a waypoint is selected, an empty-surface click just DESELECTS it — it
      // does NOT place a new point. (Click away to dismiss the selection.)
      if (selectedIndex != null) {
        selectPoint(null);
        return;
      }

      hit.object.updateWorldMatrix(true, false);
      const localPoint = hit.object.worldToLocal(hit.point.clone());
      const localNormal = hit.face?.normal
        ? hit.face.normal.clone().normalize()
        : new THREE.Vector3(0, 0, 1);

      addPoint({
        position: [localPoint.x, localPoint.y, localPoint.z],
        normal: [localNormal.x, localNormal.y, localNormal.z],
      });
    },
    [activeModelId, addPoint, dragging, lastDragEndRef, selectPoint, selectedIndex],
  );

  // Left-click on the seam line inserts a waypoint at the clicked point (the more
  // discoverable counterpart to the right-click "Add waypoint here").
  const onLineClick = React.useCallback(
    (info: OrganicCutSeamHover) => {
      selectPoint(null);
      insertPoint(info.afterIndex, { position: info.localPoint, normal: [0, 0, 0] });
    },
    [insertPoint, selectPoint],
  );

  // Hover-to-arm for the right-click menus. The tool reports when the cursor is
  // over the seam or over a waypoint marker; the armed target is stashed in refs
  // so `tryOpenContextMenu` can stay stable.
  const lineHoverRef = React.useRef<OrganicCutSeamHover | null>(null);
  const onLineHoverChange = React.useCallback((info: OrganicCutSeamHover | null) => {
    lineHoverRef.current = info;
  }, []);
  const markerHoverRef = React.useRef<number | null>(null);
  const [markerHover, setMarkerHover] = React.useState<number | null>(null);
  const onMarkerHoverChange = React.useCallback((index: number | null) => {
    markerHoverRef.current = index;
    setMarkerHover(index);
  }, []);

  const [contextMenu, setContextMenu] = React.useState<OrganicCutContextMenuState | null>(null);

  const toolActiveRef = React.useRef(toolActive);
  React.useEffect(() => {
    toolActiveRef.current = toolActive;
  }, [toolActive]);

  // Marker takes priority over line: a right-click on a waypoint deletes that
  // waypoint rather than adding one next to it.
  const tryOpenContextMenu = React.useCallback((event: { clientX: number; clientY: number }) => {
    if (!toolActiveRef.current) return false;
    const marker = markerHoverRef.current;
    if (marker != null) {
      setContextMenu({ kind: 'delete', x: event.clientX, y: event.clientY, index: marker });
      return true;
    }
    const seam = lineHoverRef.current;
    if (seam) {
      setContextMenu({
        kind: 'add',
        x: event.clientX,
        y: event.clientY,
        localPoint: seam.localPoint,
        afterIndex: seam.afterIndex,
      });
      return true;
    }
    return false;
  }, []);

  const onContextMenuAction = React.useCallback(
    (action: EditorMenuAction) => {
      if (action === 'organic-cut-add-waypoint' && contextMenu?.kind === 'add') {
        insertPoint(contextMenu.afterIndex, {
          position: contextMenu.localPoint,
          normal: [0, 0, 0],
        });
      } else if (action === 'organic-cut-delete-waypoint' && contextMenu?.kind === 'delete') {
        removePoint(contextMenu.index);
      }
      setContextMenu(null);
    },
    [contextMenu, insertPoint, removePoint],
  );

  // The cut's menu dismisses itself: `EditorContextMenu` owns outside click,
  // Escape, scroll and resize for every menu in the app.

  // Cut-tool session state read by useOrganicCutHotkeys, kept in a ref so the
  // hotkey subscription survives the per-click churn of waypoint editing.
  const hotkeyStateRef = React.useRef<OrganicCutHotkeyState>({
    active: toolActive,
    removePoint,
    selectedIndex,
  });
  React.useEffect(() => {
    hotkeyStateRef.current = { active: toolActive, removePoint, selectedIndex };
  }, [toolActive, removePoint, selectedIndex]);
  // Delete for the Cut tool, claimed through the delete registry. Undo/redo are
  // the app's own: every Cut edit is pushed to the history.
  useOrganicCutHotkeys(hotkeyStateRef);
  // Show Preview, from the configurable CUT.TOGGLE_PREVIEW binding.
  useOrganicCutPreviewHotkey(
    React.useCallback(() => {
      setPanelState({ ...panelState, showPreview: !panelState.showPreview });
    }, [panelState, setPanelState]),
    toolActive,
  );

  return {
    onSurfaceClick,
    onLineClick,
    onLineHoverChange,
    onMarkerHoverChange,
    markerHover,
    contextMenu,
    tryOpenContextMenu,
    onContextMenuAction,
    closeContextMenu: () => setContextMenu(null),
  };
}
