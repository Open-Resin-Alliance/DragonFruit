import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { RotateCcw, LayoutPanelTop } from 'lucide-react';
import { clamp } from '@/utils/math';
import { ContextMenu } from '@/components/ui/ContextMenu';
import {
  FLOATING_LAYOUT_DEBUG_REQUEST_EVENT,
  FLOATING_LAYOUT_PERSISTENCE_EVENT,
  FLOATING_LAYOUT_STORAGE_KEY,
  LEGACY_FLOATING_LAYOUT_STORAGE_KEY,
  isFloatingLayoutPersistenceEnabled,
  type FloatingLayoutDebugRequestDetail,
  type FloatingLayoutDebugSnapshot,
} from '@/components/layout/floatingLayoutPreferences';

type PanelPosition = { x: number; y: number };
type PanelSize = { width: number; height: number };
type PanelDock = 'left' | 'right' | 'float';

type PanelPlacement = {
  dock: PanelDock;
  order: number;
  /** Where a floating panel sits. Docked panels are placed by their dock. */
  float?: PanelPosition;
};

type PanelLayoutState = {
  panels: Record<string, PanelPlacement>;
  docks: { leftWidth?: number; rightWidth?: number };
};

type CollapsiblePanelRegistration = {
  expanded: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  autoCollapse: boolean;
};

type FloatingPanelStackContextValue = {
  registerCollapsiblePanel: (panelId: string, registration: CollapsiblePanelRegistration) => () => void;
  requestPanelExpand: (panelId: string) => void;
};

const FloatingPanelStackContext = React.createContext<FloatingPanelStackContextValue | null>(null);
const FloatingPanelItemContext = React.createContext<string | null>(null);

type FloatingPanelItemProps = {
  id: string;
  index: number;
  position: PanelPosition | null;
  panelWidth: number;
  docked: boolean;
  isDragging: boolean;
  dragOffset: PanelPosition | null;
  onPointerDown: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onSizeChange: (id: string, size: PanelSize) => void;
  children: React.ReactNode;
};

export function useFloatingPanelCollapse(defaultExpanded = true, options?: { autoCollapse?: boolean }) {
  const stack = React.useContext(FloatingPanelStackContext);
  const panelId = React.useContext(FloatingPanelItemContext);
  const [expanded, setExpandedState] = React.useState(defaultExpanded);
  const autoCollapse = options?.autoCollapse ?? true;

  React.useLayoutEffect(() => {
    if (!stack || !panelId) return undefined;

    return stack.registerCollapsiblePanel(panelId, {
      expanded,
      setExpanded: setExpandedState,
      autoCollapse,
    });
  }, [autoCollapse, expanded, panelId, stack]);

  const setExpanded = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>((next) => {
    const resolved = typeof next === 'function'
      ? (next as (value: boolean) => boolean)(expanded)
      : next;

    if (resolved && !expanded && stack && panelId) {
      stack.requestPanelExpand(panelId);
    }

    setExpandedState(resolved);
  }, [expanded, panelId, stack]);

  return [expanded, setExpanded] as const;
}

type WindowContextMenuState = {
  panelId: string;
  x: number;
  y: number;
};

type DragState = {
  id: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  originDock: PanelDock;
  /** Pointer delta from the grab point, applied to the panel while dragging. */
  offset: PanelPosition;
};

type DropTarget = {
  dock: 'left' | 'right';
  index: number;
  y: number;
};

const PANEL_MARGIN = 6;
const PANEL_GAP = 6;

const DEFAULT_PANEL_WIDTH = 320;
const DEFAULT_PANEL_HEIGHT = 150;
const MIN_DOCK_WIDTH = 200;
const MAX_DOCK_WIDTH = 520;
const COLLAPSED_PANEL_HEIGHT = 48;

const PANEL_WIDTH_OVERRIDES: Record<string, number> = {
  'transform-debug-overlay': 420,
};

// Panels the layout does not let the user move. `always` is the shell chrome. The
// model list is only pinned while the tool rail is a column down the left edge.
const LOCKED_PANELS: Record<string, 'always' | 'rail-column'> = {
  'prepare-models': 'rail-column',
  'support-models': 'rail-column',
};

// First-run placement. Every panel is either in a dock or floating; the dock
// order follows the order the tool renders its panels in.
const DEFAULT_PANEL_DOCKS: Record<string, PanelDock> = {
  'prepare-models': 'left',
  'prepare-debug-primitives': 'left',
  'support-models': 'left',
  'analysis-scan-card': 'left',
  'analysis-island-list': 'left',
  'analysis-workflow': 'left',
  'export-main': 'left',
  'curve-settings': 'left',
  'prepare-transform-controls': 'right',
  'prepare-orientation': 'right',
  'prepare-smoothing-settings': 'right',
  'prepare-arrange-panel': 'right',
  'prepare-duplicate-panel': 'right',
  'prepare-organic-cut-panel': 'right',
  'analysis-overlay-controls': 'right',
  'analysis-territory-voxel': 'right',
  'analysis-island-voxel': 'right',
  'analysis-volumes': 'right',
  'support-islands': 'right',
  'support-settings': 'right',
  'support-auto': 'right',
  'support-hollowing': 'right',
  'support-hole-punch': 'right',
  'export-slicing': 'right',
  'transform-debug-overlay': 'right',
};

function getPanelBaseWidth(panelId: string) {
  return PANEL_WIDTH_OVERRIDES[panelId] ?? DEFAULT_PANEL_WIDTH;
}

function isPanelLocked(panelId: string, railIsColumn: boolean): boolean {
  const rule = LOCKED_PANELS[panelId];
  return rule === 'always' || (rule === 'rail-column' && railIsColumn);
}

function defaultPlacement(panelId: string, order: number): PanelPlacement {
  return { dock: DEFAULT_PANEL_DOCKS[panelId] ?? 'right', order };
}

function clampPosition(position: PanelPosition, size: PanelSize, bounds: PanelSize): PanelPosition {
  const maxX = Math.max(PANEL_MARGIN, bounds.width - size.width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, bounds.height - size.height - PANEL_MARGIN);
  return {
    x: clamp(position.x, PANEL_MARGIN, maxX),
    y: clamp(position.y, PANEL_MARGIN, maxY),
  };
}

function isDragBlockedByTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('button, input, select, textarea, label, a, [role="button"], [data-no-drag], [data-no-drag="true"], .react-colorful'),
  );
}

function isPanelHeaderDragHandleTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('[data-panel-drag-handle="true"]'));
}

function flattenPanelChildren(children: React.ReactNode, prefix = 'panel'): Array<{ id: string; node: React.ReactNode }> {
  const entries: Array<{ id: string; node: React.ReactNode }> = [];

  React.Children.forEach(children, (child, index) => {
    if (child == null) return;

    const fallbackId = `${prefix}-${index}`;

    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
      entries.push(...flattenPanelChildren(child.props.children, fallbackId));
      return;
    }

    const id = React.isValidElement(child) && child.key != null ? String(child.key) : fallbackId;
    entries.push({ id, node: child });
  });

  return entries;
}

function loadPanelLayout(): PanelLayoutState {
  if (typeof window === 'undefined') return { panels: {}, docks: {} };

  try {
    const raw = window.localStorage.getItem(FLOATING_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { version?: number; panels?: Record<string, PanelPlacement>; docks?: PanelLayoutState['docks'] };
      if (parsed?.version === 6 && parsed.panels && typeof parsed.panels === 'object') {
        return { panels: parsed.panels, docks: parsed.docks ?? {} };
      }
    }

    // v5 stored absolute positions for moved panels only. Keep the intent: a
    // panel parked near an edge joins that dock, anything else floats in place.
    const legacy = window.localStorage.getItem(LEGACY_FLOATING_LAYOUT_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as { positions?: Record<string, PanelPosition> };
      const positions = parsed?.positions ?? {};
      const panels: Record<string, PanelPlacement> = {};
      const width = window.innerWidth;
      let order = 0;

      for (const [panelId, position] of Object.entries(positions)) {
        if (typeof position?.x !== 'number' || typeof position?.y !== 'number') continue;
        const center = position.x + getPanelBaseWidth(panelId) / 2;
        const dock: PanelDock = center < width * 0.4
          ? 'left'
          : center > width * 0.6
            ? 'right'
            : 'float';
        panels[panelId] = {
          dock,
          order: order++,
          ...(dock === 'float' ? { float: { x: position.x, y: position.y } } : {}),
        };
      }

      return { panels, docks: {} };
    }
  } catch {
    // Fall through to defaults.
  }

  return { panels: {}, docks: {} };
}

function placePanel(
  layout: PanelLayoutState,
  panelId: string,
  dock: PanelDock,
  index: number,
  float?: PanelPosition,
): PanelLayoutState {
  const panels = { ...layout.panels };
  const sourceDock = panels[panelId]?.dock;

  if (dock === 'float') {
    const order = Object.values(panels)
      .filter((placement) => placement.dock === 'float')
      .reduce((max, placement) => Math.max(max, placement.order), -1) + 1;
    panels[panelId] = { dock: 'float', order, float };
  } else {
    const targetIds = Object.keys(panels)
      .filter((id) => id !== panelId && panels[id].dock === dock)
      .sort((a, b) => panels[a].order - panels[b].order);
    const insertAt = Math.max(0, Math.min(index, targetIds.length));
    targetIds.splice(insertAt, 0, panelId);
    targetIds.forEach((id, order) => {
      panels[id] = { ...panels[id], dock, order };
    });
  }

  if (sourceDock && sourceDock !== dock && sourceDock !== 'float') {
    const sourceIds = Object.keys(panels)
      .filter((id) => panels[id].dock === sourceDock)
      .sort((a, b) => panels[a].order - panels[b].order);
    sourceIds.forEach((id, order) => {
      panels[id] = { ...panels[id], order };
    });
  }

  return { ...layout, panels };
}

function FloatingPanelItem({
  id,
  index,
  position,
  panelWidth,
  docked,
  isDragging,
  dragOffset,
  onPointerDown,
  onContextMenu,
  onSizeChange,
  children,
}: FloatingPanelItemProps) {
  const itemRef = React.useRef<HTMLDivElement | null>(null);
  const rightClickGestureRef = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);

  React.useLayoutEffect(() => {
    const element = itemRef.current;
    if (!element) return;

    onSizeChange(id, { width: element.offsetWidth, height: element.offsetHeight });
  });

  return (
    <div
      ref={itemRef}
      data-panel-id={id}
      className="pointer-events-auto"
      style={{
        position: docked ? 'relative' : 'absolute',
        left: docked ? undefined : position?.x ?? 0,
        top: docked ? undefined : position?.y ?? 0,
        width: panelWidth,
        // A docked panel is right-aligned in its dock, so a panel wider than the
        // dock's content box would have its left edge clipped by the dock's
        // `overflow-x: hidden`. Cap it instead; the panel reflows and stays whole.
        maxWidth: docked ? '100%' : undefined,
        flex: docked ? '0 0 auto' : undefined,
        zIndex: isDragging ? 100 : 20 + index,
        cursor: isDragging ? 'grabbing' : 'default',
        transform: dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px)` : undefined,
        pointerEvents: isDragging ? 'none' : 'auto',
        borderRadius: 12,
      }}
      onPointerDown={(event) => {
        if (event.button === 2) {
          rightClickGestureRef.current = { x: event.clientX, y: event.clientY, moved: false };
        }
        onPointerDown(id, event);
      }}
      onPointerMove={(event) => {
        const gesture = rightClickGestureRef.current;
        if (!gesture) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if ((dx * dx + dy * dy) > 36) gesture.moved = true;
      }}
      onContextMenu={(event) => {
        const gesture = rightClickGestureRef.current;
        if (gesture?.moved) {
          event.preventDefault();
          event.stopPropagation();
          rightClickGestureRef.current = null;
          return;
        }
        onContextMenu(id, event);
        rightClickGestureRef.current = null;
      }}
    >
      <FloatingPanelItemContext.Provider value={id}>
        <div className="w-full [&>*]:!w-full">
          {children}
        </div>
      </FloatingPanelItemContext.Provider>
    </div>
  );
}

/**
 * A container for floating UI panels that overlays the canvas. Panels live in a
 * left dock, a right dock, or float at a remembered position; dragging a panel
 * between them is the only way its placement changes.
 */
export function FloatingPanelStack({ children, leftInsetPx = 0, rightInsetPx = 0, railIsColumn = true }: { children: React.ReactNode; leftInsetPx?: number; rightInsetPx?: number; railIsColumn?: boolean }) {
  const { _ } = useLingui();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const panelSizesRef = React.useRef<Record<string, PanelSize>>({});
  const collapsiblePanelsRef = React.useRef<Record<string, CollapsiblePanelRegistration>>({});

  const [layout, setLayout] = React.useState<PanelLayoutState>(() => (
    isFloatingLayoutPersistenceEnabled() ? loadPanelLayout() : { panels: {}, docks: {} }
  ));
  const [viewportSize, setViewportSize] = React.useState<PanelSize>({ width: 1200, height: 800 });
  const [panelSizeVersion, setPanelSizeVersion] = React.useState(0);
  const [registryVersion, setRegistryVersion] = React.useState(0);
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = React.useState<DropTarget | null>(null);
  const [dockResize, setDockResize] = React.useState<{ side: 'left' | 'right'; startX: number; startWidth: number } | null>(null);
  const [windowContextMenu, setWindowContextMenu] = React.useState<WindowContextMenuState | null>(null);
  const [persistLayout, setPersistLayout] = React.useState<boolean>(() => isFloatingLayoutPersistenceEnabled());

  const panelEntries = React.useMemo(() => flattenPanelChildren(children), [children]);
  const panelIds = React.useMemo(() => panelEntries.map((entry) => entry.id), [panelEntries]);
  const panelIdsSignature = React.useMemo(() => panelIds.join('\u001f'), [panelIds]);
  const panelIdsRef = React.useRef(panelIds);

  React.useEffect(() => {
    panelIdsRef.current = panelIds;
  }, [panelIds]);

  const getPanelWidth = React.useCallback((panelId: string) => getPanelBaseWidth(panelId), []);
  const getPanelSize = React.useCallback((panelId: string): PanelSize => (
    panelSizesRef.current[panelId] ?? { width: getPanelWidth(panelId), height: DEFAULT_PANEL_HEIGHT }
  ), [getPanelWidth]);

  // Every panel has a placement once it has been seen. Panels that are absent
  // keep theirs, so a tool switch does not erase a move.
  React.useEffect(() => {
    setLayout((previous) => {
      let changed = false;
      const panels = { ...previous.panels };
      panelIdsRef.current.forEach((panelId, index) => {
        if (panels[panelId]) return;
        panels[panelId] = defaultPlacement(panelId, index);
        changed = true;
      });
      return changed ? { ...previous, panels } : previous;
    });
  }, [panelIdsSignature]);

  const placementFor = React.useCallback((panelId: string): PanelPlacement => (
    layout.panels[panelId] ?? defaultPlacement(panelId, panelIds.indexOf(panelId))
  ), [layout.panels, panelIds]);

  const leftPanels = React.useMemo(() => panelIds
    .filter((id) => placementFor(id).dock === 'left')
    .sort((a, b) => placementFor(a).order - placementFor(b).order), [panelIds, placementFor]);
  const rightPanels = React.useMemo(() => panelIds
    .filter((id) => placementFor(id).dock === 'right')
    .sort((a, b) => placementFor(a).order - placementFor(b).order), [panelIds, placementFor]);
  const floatingPanels = React.useMemo(() => panelIds
    .filter((id) => placementFor(id).dock === 'float')
    .sort((a, b) => placementFor(a).order - placementFor(b).order), [panelIds, placementFor]);

  // The gutter the docks reserve for a scrollbar. Measured from the dock itself
  // because `scrollbar-gutter: stable` reserves it whether or not it scrolls,
  // and its width differs per platform.
  const leftDockRef = React.useRef<HTMLDivElement | null>(null);
  const rightDockRef = React.useRef<HTMLDivElement | null>(null);
  const [dockGutter, setDockGutter] = React.useState(0);

  const dockWidth = React.useCallback((side: 'left' | 'right', ids: string[]) => {
    const stored = side === 'left' ? layout.docks.leftWidth : layout.docks.rightWidth;
    // The dock reserves a stable scrollbar gutter, so the content box is the
    // dock width minus that gutter; add it back or the panels lose it.
    const content = ids.reduce((max, id) => Math.max(max, getPanelWidth(id)), 0)
      + PANEL_MARGIN * 2
      + dockGutter;
    // A stored width from an older layout can be narrower than the panels it
    // now holds; the dock clips its children horizontally, so it must never be
    // narrower than the widest panel.
    return clamp(Math.max(stored ?? content, content), MIN_DOCK_WIDTH, MAX_DOCK_WIDTH);
  }, [dockGutter, getPanelWidth, layout.docks]);

  const leftWidth = dockWidth('left', leftPanels);
  const rightWidth = dockWidth('right', rightPanels);

  React.useLayoutEffect(() => {
    const measure = () => {
      const left = leftDockRef.current;
      const right = rightDockRef.current;
      const next = Math.max(
        left ? left.offsetWidth - left.clientWidth : 0,
        right ? right.offsetWidth - right.clientWidth : 0,
      );
      setDockGutter((previous) => (previous === next ? previous : next));
    };
    measure();
  }, [panelIdsSignature, leftWidth, rightWidth, viewportSize.height]);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => {
      setViewportSize((previous) => {
        const next = { width: window.innerWidth, height: window.innerHeight - element.offsetTop };
        return previous.width === next.width && previous.height === next.height ? previous : next;
      });
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const sync = () => setPersistLayout(isFloatingLayoutPersistenceEnabled());
    sync();
    window.addEventListener(FLOATING_LAYOUT_PERSISTENCE_EVENT, sync as EventListener);
    window.addEventListener('storage', sync);

    return () => {
      window.removeEventListener(FLOATING_LAYOUT_PERSISTENCE_EVENT, sync as EventListener);
      window.removeEventListener('storage', sync);
    };
  }, []);

  React.useEffect(() => {
    if (!persistLayout || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(FLOATING_LAYOUT_STORAGE_KEY, JSON.stringify({
        version: 6,
        panels: layout.panels,
        docks: layout.docks,
      }));
    } catch {
      // Ignore storage failures.
    }
  }, [layout, persistLayout]);

  const handlePanelSizeChange = React.useCallback((panelId: string, size: PanelSize) => {
    const previous = panelSizesRef.current[panelId];
    if (previous && previous.width === size.width && previous.height === size.height) return;
    panelSizesRef.current = { ...panelSizesRef.current, [panelId]: size };
    setPanelSizeVersion((version) => version + 1);
  }, []);

  const registerCollapsiblePanel = React.useCallback((
    panelId: string,
    registration: CollapsiblePanelRegistration,
  ) => {
    collapsiblePanelsRef.current = { ...collapsiblePanelsRef.current, [panelId]: registration };
    setRegistryVersion((version) => version + 1);

    return () => {
      if (collapsiblePanelsRef.current[panelId] !== registration) return;
      const next = { ...collapsiblePanelsRef.current };
      delete next[panelId];
      collapsiblePanelsRef.current = next;
      setRegistryVersion((version) => version + 1);
    };
  }, []);

  const requestPanelExpand = React.useCallback((panelId: string) => {
    const placement = placementFor(panelId);
    if (placement.dock === 'float') return;

    const ids = placement.dock === 'left' ? leftPanels : rightPanels;
    const available = viewportSize.height - PANEL_MARGIN * 2;
    let total = ids.reduce((sum, id) => sum + getPanelSize(id).height + PANEL_GAP, 0);
    if (total <= available) return;

    const candidates = ids
      .filter((id) => id !== panelId)
      .filter((id) => {
        const registration = collapsiblePanelsRef.current[id];
        return registration?.expanded && registration.autoCollapse;
      })
      .reverse();

    for (const id of candidates) {
      if (total <= available) break;
      const size = getPanelSize(id);
      collapsiblePanelsRef.current[id]?.setExpanded(false);
      total -= Math.max(0, size.height - COLLAPSED_PANEL_HEIGHT);
    }
  }, [getPanelSize, leftPanels, placementFor, rightPanels, viewportSize.height]);

  const floatingPanelStackContext = React.useMemo<FloatingPanelStackContextValue>(() => ({
    registerCollapsiblePanel,
    requestPanelExpand,
  }), [registerCollapsiblePanel, requestPanelExpand]);

  // Auto-compact a dock that no longer fits, from the bottom up.
  React.useEffect(() => {
    if (drag) return;

    for (const ids of [leftPanels, rightPanels]) {
      const available = viewportSize.height - PANEL_MARGIN * 2;
      let total = ids.reduce((sum, id) => sum + getPanelSize(id).height + PANEL_GAP, 0);
      if (total <= available) continue;

      const candidates = ids
        .filter((id) => {
          const registration = collapsiblePanelsRef.current[id];
          return registration?.expanded && registration.autoCollapse;
        })
        .reverse();

      for (const id of candidates) {
        if (total <= available) break;
        const size = getPanelSize(id);
        collapsiblePanelsRef.current[id]?.setExpanded(false);
        total -= Math.max(0, size.height - COLLAPSED_PANEL_HEIGHT);
      }
    }
  }, [drag, getPanelSize, leftPanels, panelSizeVersion, registryVersion, rightPanels, viewportSize.height]);

  const dockIndexAt = React.useCallback((dock: 'left' | 'right', clientY: number, draggedId: string) => {
    const ids = (dock === 'left' ? leftPanels : rightPanels).filter((id) => id !== draggedId);
    let index = 0;
    for (const id of ids) {
      const element = containerRef.current?.querySelector(`[data-panel-id="${id}"]`);
      const rect = element?.getBoundingClientRect();
      if (rect && clientY > rect.top + rect.height / 2) index += 1;
    }
    return index;
  }, [leftPanels, rightPanels]);

  const handlePointerDown = React.useCallback((panelId: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isPanelLocked(panelId, railIsColumn)) return;
    if (!isPanelHeaderDragHandleTarget(event.target)) return;
    if (isDragBlockedByTarget(event.target)) return;

    const containerRect = containerRef.current?.getBoundingClientRect();
    const panelRect = event.currentTarget.getBoundingClientRect();
    if (!containerRect) return;

    setDrag({
      id: panelId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - panelRect.left,
      offsetY: event.clientY - panelRect.top,
      moved: false,
      originDock: placementFor(panelId).dock,
      offset: { x: 0, y: 0 },
    });
    event.preventDefault();
  }, [placementFor, railIsColumn]);

  React.useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && (dx * dx + dy * dy) < 16) return;

      setDrag((previous) => (previous ? { ...previous, moved: true, offset: { x: dx, y: dy } } : previous));

      const containerRect = containerRef.current?.getBoundingClientRect();
      const leftEdge = leftInsetPx + leftWidth;
      const rightEdge = window.innerWidth - rightInsetPx - rightWidth;
      if (event.clientX <= leftEdge) {
        setDropTarget({
          dock: 'left',
          index: dockIndexAt('left', event.clientY, drag.id),
          y: event.clientY - (containerRect?.top ?? 0),
        });
      } else if (event.clientX >= rightEdge) {
        setDropTarget({
          dock: 'right',
          index: dockIndexAt('right', event.clientY, drag.id),
          y: event.clientY - (containerRect?.top ?? 0),
        });
      } else {
        setDropTarget(null);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (drag.moved) {
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (dropTarget) {
          setLayout((previous) => placePanel(previous, drag.id, dropTarget.dock, dropTarget.index));
        } else if (containerRect) {
          const size = getPanelSize(drag.id);
          const float = clampPosition(
            {
              x: event.clientX - containerRect.left - drag.offsetX,
              y: event.clientY - containerRect.top - drag.offsetY,
            },
            size,
            viewportSize,
          );
          setLayout((previous) => placePanel(previous, drag.id, 'float', 0, float));
        }
      }

      setDrag(null);
      setDropTarget(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [
    dockIndexAt,
    drag,
    dropTarget,
    getPanelSize,
    leftInsetPx,
    leftWidth,
    rightInsetPx,
    rightWidth,
    viewportSize,
  ]);

  React.useEffect(() => {
    if (!dockResize) return;

    const onPointerMove = (event: PointerEvent) => {
      const delta = event.clientX - dockResize.startX;
      const width = clamp(
        dockResize.startWidth + (dockResize.side === 'left' ? delta : -delta),
        MIN_DOCK_WIDTH,
        MAX_DOCK_WIDTH,
      );
      setLayout((previous) => ({
        ...previous,
        docks: {
          ...previous.docks,
          [dockResize.side === 'left' ? 'leftWidth' : 'rightWidth']: width,
        },
      }));
    };

    const onPointerUp = () => setDockResize(null);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dockResize]);

  const closeWindowContextMenu = React.useCallback(() => {
    setWindowContextMenu(null);
  }, []);

  const handlePanelContextMenu = React.useCallback((panelId: string, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setWindowContextMenu({ panelId, x: event.clientX, y: event.clientY });
  }, []);

  const resetSingleWindow = React.useCallback((panelId: string) => {
    closeWindowContextMenu();
    const dock = DEFAULT_PANEL_DOCKS[panelId] ?? 'right';
    setLayout((previous) => placePanel(previous, panelId, dock, Number.MAX_SAFE_INTEGER));
  }, [closeWindowContextMenu]);

  const resetAllWindows = React.useCallback(() => {
    closeWindowContextMenu();
    setLayout({ panels: {}, docks: {} });
    setPanelSizeVersion((version) => version + 1);

    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(FLOATING_LAYOUT_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_FLOATING_LAYOUT_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
    }
  }, [closeWindowContextMenu]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleDebugDumpRequest = (event: Event) => {
      const detail = (event as CustomEvent<FloatingLayoutDebugRequestDetail>).detail;
      if (!detail?.onResult) return;

      const positions: Record<string, PanelPosition> = {};
      for (const panelId of panelIds) {
        const placement = placementFor(panelId);
        if (placement.dock === 'float' && placement.float) {
          positions[panelId] = { ...placement.float };
        }
      }

      const snapshot: FloatingLayoutDebugSnapshot = {
        version: 2,
        capturedAt: new Date().toISOString(),
        persistenceEnabled: persistLayout,
        storageKey: FLOATING_LAYOUT_STORAGE_KEY,
        panelIds: [...panelIds],
        positions,
        placements: { ...layout.panels },
        docks: { ...layout.docks },
      };

      detail.onResult(snapshot);
    };

    window.addEventListener(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, handleDebugDumpRequest as EventListener);
    return () => {
      window.removeEventListener(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, handleDebugDumpRequest as EventListener);
    };
  }, [layout.docks, layout.panels, panelIds, persistLayout, placementFor]);

  const renderPanel = (panelId: string, index: number, docked: boolean) => {
    const entry = panelEntries.find((candidate) => candidate.id === panelId);
    if (!entry?.node) return null;

    const placement = placementFor(panelId);
    const position = docked
      ? null
      : clampPosition(
        placement.float ?? { x: PANEL_MARGIN, y: PANEL_MARGIN + index * 18 },
        { width: getPanelWidth(panelId), height: DEFAULT_PANEL_HEIGHT },
        viewportSize,
      );
    const isDragging = drag?.id === panelId;
    const dragOffset = isDragging && drag ? drag.offset : null;

    return (
      <FloatingPanelItem
        key={panelId}
        id={panelId}
        index={index}
        position={position}
        panelWidth={getPanelWidth(panelId)}
        docked={docked}
        isDragging={isDragging}
        dragOffset={dragOffset}
        onPointerDown={handlePointerDown}
        onContextMenu={handlePanelContextMenu}
        onSizeChange={handlePanelSizeChange}
      >
        {entry.node}
      </FloatingPanelItem>
    );
  };

  return (
    <FloatingPanelStackContext.Provider value={floatingPanelStackContext}>
      <div
        ref={containerRef}
        className="absolute right-0 top-[var(--topbar-height)] bottom-0 z-10 pointer-events-none"
        style={{ left: 0 }}
      >
        <div
          ref={leftDockRef}
          data-dock="left"
          className="absolute top-0 bottom-0 flex flex-col pointer-events-none"
          style={{
            left: leftInsetPx,
            width: leftWidth,
            padding: PANEL_MARGIN,
            gap: PANEL_GAP,
            alignItems: 'flex-start',
            overflowY: drag ? 'visible' : 'auto',
            overflowX: drag ? 'visible' : 'hidden',
            scrollbarGutter: 'stable',
          }}
        >
          {leftPanels.map((panelId, index) => renderPanel(panelId, index, true))}
          <div
            className="absolute inset-y-0 cursor-col-resize pointer-events-auto"
            style={{ right: 0, width: 6 }}
            onPointerDown={(event) => {
              event.preventDefault();
              setDockResize({ side: 'left', startX: event.clientX, startWidth: leftWidth });
            }}
          />
        </div>

        <div
          ref={rightDockRef}
          data-dock="right"
          className="absolute top-0 bottom-0 flex flex-col pointer-events-none"
          style={{
            right: rightInsetPx,
            width: rightWidth,
            padding: PANEL_MARGIN,
            gap: PANEL_GAP,
            alignItems: 'flex-end',
            overflowY: drag ? 'visible' : 'auto',
            overflowX: drag ? 'visible' : 'hidden',
            scrollbarGutter: 'stable',
          }}
        >
          {rightPanels.map((panelId, index) => renderPanel(panelId, index, true))}
          <div
            className="absolute inset-y-0 cursor-col-resize pointer-events-auto"
            style={{ left: 0, width: 6 }}
            onPointerDown={(event) => {
              event.preventDefault();
              setDockResize({ side: 'right', startX: event.clientX, startWidth: rightWidth });
            }}
          />
        </div>

        {floatingPanels.map((panelId, index) => renderPanel(panelId, index, false))}

        {dropTarget ? (
          <div
            className="absolute pointer-events-none rounded-full"
            style={{
              left: dropTarget.dock === 'left' ? leftInsetPx + PANEL_MARGIN : viewportSize.width - rightInsetPx - rightWidth + PANEL_MARGIN,
              top: dropTarget.y,
              width: (dropTarget.dock === 'left' ? leftWidth : rightWidth) - PANEL_MARGIN * 2,
              height: 2,
              background: 'var(--accent)',
              zIndex: 120,
            }}
          />
        ) : null}

        <ContextMenu
          position={windowContextMenu}
          entries={[
            { id: 'reset-window', label: _(msg`Reset Window`), icon: RotateCcw },
            { id: 'reset-all-windows', label: _(msg`Reset Layout`), icon: LayoutPanelTop },
          ]}
          onSelect={(id) => {
            if (!windowContextMenu) return;
            if (id === 'reset-window') resetSingleWindow(windowContextMenu.panelId);
            if (id === 'reset-all-windows') resetAllWindows();
          }}
          onClose={closeWindowContextMenu}
          title={_(msg({ message: 'Window', comment: 'Heading of the floating panel right-click menu that resets panel positions.' }))}
          ariaLabel={_(msg({ message: 'Window context menu', comment: 'Accessible name of the floating panel right-click menu that resets panel positions.' }))}
        />
      </div>
    </FloatingPanelStackContext.Provider>
  );
}
