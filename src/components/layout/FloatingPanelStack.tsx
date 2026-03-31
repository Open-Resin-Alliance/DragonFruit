import React from 'react';
import windowLayouts from '@/config/window-layouts.json';
import {
  type FloatingLayoutDebugRequestDetail,
  type FloatingLayoutDebugSnapshot,
  FLOATING_LAYOUT_DEBUG_REQUEST_EVENT,
  FLOATING_LAYOUT_PERSISTENCE_EVENT,
  FLOATING_LAYOUT_STORAGE_KEY,
  isFloatingLayoutPersistenceEnabled,
} from '@/components/layout/floatingLayoutPreferences';

type PanelPosition = {
  x: number;
  y: number;
};

type PanelSize = {
  width: number;
  height: number;
};

type PanelRect = PanelPosition & PanelSize;

type EdgeHint = {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
};

type DropPreview = {
  id: string;
  position: PanelPosition;
  size: PanelSize;
};

type PanelAttachmentSide = 'below' | 'above' | 'right' | 'left';

type PanelAttachment = {
  to: string;
  side: PanelAttachmentSide;
  gap: number;
};

type AttachmentPanelRect = PanelRect & { id: string };

type FloatingPanelItemProps = {
  id: string;
  index: number;
  position: PanelPosition;
  panelWidth: number;
  isDragging: boolean;
  magnetic: boolean;
  onPointerDown: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onSizeChange: (id: string, size: PanelSize) => void;
  children: React.ReactNode;
};

type WindowContextMenuState = {
  panelId: string;
  x: number;
  y: number;
};

const PANEL_MARGIN = 12;
const EDGE_SNAP_THRESHOLD = 20;
const EDGE_MAGNET_THRESHOLD = 22;
const EDGE_HINT_THRESHOLD = 36;
const PANEL_MAGNET_THRESHOLD = 24;
const PANEL_GAP = 12;
const DEFAULT_PANEL_WIDTH = 320;
const DEFAULT_PANEL_HEIGHT = 150;
const PANEL_WIDTH_OVERRIDES: Record<string, number> = {
  'visual-settings': 72,
  'prepare-smoothing-settings': 340,
  'transform-debug-overlay': 420,
};
const PANEL_SCALE_EXEMPT_IDS = new Set<string>(['support-settings']);
const LOCKED_PANEL_IDS = new Set<string>(['visual-settings']);
const CHAIN_ATTACH_TOLERANCE = 30;

function getPanelBaseWidth(panelId: string) {
  return PANEL_WIDTH_OVERRIDES[panelId] ?? DEFAULT_PANEL_WIDTH;
}

type AnchorSide = 'below' | 'above' | 'right' | 'left' | 'right-edge' | 'left-edge';

type LayoutAnchorRule = {
  to: string;
  side: AnchorSide;
  gap?: number;
  offsetX?: number;
  offsetY?: number;
};

type LayoutProfile = {
  id: string;
  matchPanelIds: string[];
  order?: string[];
  anchors?: Record<string, LayoutAnchorRule>;
};

type LayoutConfig = {
  version: number;
  profiles: LayoutProfile[];
};

const WINDOW_LAYOUTS: LayoutConfig = windowLayouts as unknown as LayoutConfig;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function overlaps(a: PanelRect, b: PanelRect, gap = PANEL_GAP) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function clampPosition(position: PanelPosition, size: PanelSize, bounds: PanelSize): PanelPosition {
  const maxX = Math.max(PANEL_MARGIN, bounds.width - size.width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, bounds.height - size.height - PANEL_MARGIN);
  return {
    x: clamp(position.x, PANEL_MARGIN, maxX),
    y: clamp(position.y, PANEL_MARGIN, maxY),
  };
}

function findNearestFreePosition(
  desired: PanelPosition,
  size: PanelSize,
  occupied: PanelRect[],
  bounds: PanelSize,
  panelGap = PANEL_GAP,
): PanelPosition {
  const base = clampPosition(desired, size, bounds);

  const collidesAt = (position: PanelPosition) => {
    const candidate: PanelRect = { ...position, ...size };
    return occupied.some((rect) => overlaps(candidate, rect, panelGap));
  };

  if (!collidesAt(base)) {
    return base;
  }

  const xMin = PANEL_MARGIN;
  const xMax = Math.max(PANEL_MARGIN, bounds.width - size.width - PANEL_MARGIN);
  const yMin = PANEL_MARGIN;
  const yMax = Math.max(PANEL_MARGIN, bounds.height - size.height - PANEL_MARGIN);

  const step = 18;
  for (let radius = step; radius <= 720; radius += step) {
    const samples = [
      { x: base.x + radius, y: base.y },
      { x: base.x - radius, y: base.y },
      { x: base.x, y: base.y + radius },
      { x: base.x, y: base.y - radius },
      { x: base.x + radius, y: base.y + radius },
      { x: base.x + radius, y: base.y - radius },
      { x: base.x - radius, y: base.y + radius },
      { x: base.x - radius, y: base.y - radius },
    ];

    for (const point of samples) {
      const candidate = {
        x: clamp(point.x, xMin, xMax),
        y: clamp(point.y, yMin, yMax),
      };
      if (!collidesAt(candidate)) {
        return candidate;
      }
    }
  }

  return base;
}

function isDragBlockedByTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('button, input, select, textarea, label, a, [role="button"], [data-no-drag], [data-no-drag="true"], .react-colorful'),
  );
}

function getEdgeHint(position: PanelPosition, size: PanelSize, bounds: PanelSize, threshold: number): EdgeHint {
  const rightEdgeX = Math.max(PANEL_MARGIN, bounds.width - size.width - PANEL_MARGIN);
  const bottomEdgeY = Math.max(PANEL_MARGIN, bounds.height - size.height - PANEL_MARGIN);

  return {
    left: Math.abs(position.x - PANEL_MARGIN) <= threshold,
    right: Math.abs(position.x - rightEdgeX) <= threshold,
    top: Math.abs(position.y - PANEL_MARGIN) <= threshold,
    bottom: Math.abs(position.y - bottomEdgeY) <= threshold,
  };
}

function hasEdgeHint(hint: EdgeHint) {
  return hint.left || hint.right || hint.top || hint.bottom;
}

function applyEdgeMagnet(position: PanelPosition, size: PanelSize, bounds: PanelSize): PanelPosition {
  const rightEdgeX = Math.max(PANEL_MARGIN, bounds.width - size.width - PANEL_MARGIN);
  const bottomEdgeY = Math.max(PANEL_MARGIN, bounds.height - size.height - PANEL_MARGIN);

  const next = { ...position };

  if (Math.abs(next.x - PANEL_MARGIN) <= EDGE_MAGNET_THRESHOLD) {
    next.x = PANEL_MARGIN;
  } else if (Math.abs(next.x - rightEdgeX) <= EDGE_MAGNET_THRESHOLD) {
    next.x = rightEdgeX;
  }

  if (Math.abs(next.y - PANEL_MARGIN) <= EDGE_MAGNET_THRESHOLD) {
    next.y = PANEL_MARGIN;
  } else if (Math.abs(next.y - bottomEdgeY) <= EDGE_MAGNET_THRESHOLD) {
    next.y = bottomEdgeY;
  }

  return next;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

function applyPanelMagnet(position: PanelPosition, size: PanelSize, otherPanels: PanelRect[], panelGap = PANEL_GAP): PanelPosition {
  const next = { ...position };
  let bestXDistance = PANEL_MAGNET_THRESHOLD + 1;
  let bestYDistance = PANEL_MAGNET_THRESHOLD + 1;

  for (const panel of otherPanels) {
    const verticalOverlap = rangesOverlap(next.y, next.y + size.height, panel.y, panel.y + panel.height);
    const horizontalOverlap = rangesOverlap(next.x, next.x + size.width, panel.x, panel.x + panel.width);

    if (verticalOverlap) {
      const dockLeftX = panel.x - size.width - panelGap;
      const dockRightX = panel.x + panel.width + panelGap;

      const leftDistance = Math.abs(next.x - dockLeftX);
      if (leftDistance <= PANEL_MAGNET_THRESHOLD && leftDistance < bestXDistance) {
        bestXDistance = leftDistance;
        next.x = dockLeftX;
      }

      const rightDistance = Math.abs(next.x - dockRightX);
      if (rightDistance <= PANEL_MAGNET_THRESHOLD && rightDistance < bestXDistance) {
        bestXDistance = rightDistance;
        next.x = dockRightX;
      }
    }

    if (horizontalOverlap) {
      const dockTopY = panel.y - size.height - panelGap;
      const dockBottomY = panel.y + panel.height + panelGap;

      const topDistance = Math.abs(next.y - dockTopY);
      if (topDistance <= PANEL_MAGNET_THRESHOLD && topDistance < bestYDistance) {
        bestYDistance = topDistance;
        next.y = dockTopY;
      }

      const bottomDistance = Math.abs(next.y - dockBottomY);
      if (bottomDistance <= PANEL_MAGNET_THRESHOLD && bottomDistance < bestYDistance) {
        bestYDistance = bottomDistance;
        next.y = dockBottomY;
      }
    }
  }

  return next;
}

function EdgeSnapOverlay({ hint }: { hint: EdgeHint }) {
  const baseClass = 'absolute pointer-events-none rounded-full bg-blue-400/35 shadow-[0_0_18px_rgba(79,140,255,0.55)] transition-opacity duration-120';

  return (
    <>
      {hint.left && <div className={`${baseClass} left-1 top-2 bottom-2 w-1`} />}
      {hint.right && <div className={`${baseClass} right-1 top-2 bottom-2 w-1`} />}
      {hint.top && <div className={`${baseClass} top-1 left-2 right-2 h-1`} />}
      {hint.bottom && <div className={`${baseClass} bottom-1 left-2 right-2 h-1`} />}
    </>
  );
}

function positionsEqual(
  previous: Record<string, PanelPosition>,
  next: Record<string, PanelPosition>,
  panelIds: string[],
) {
  if (Object.keys(previous).length !== panelIds.length) {
    return false;
  }

  return panelIds.every((panelId) => {
    const prevPos = previous[panelId];
    const nextPos = next[panelId];
    return !!prevPos && !!nextPos && prevPos.x === nextPos.x && prevPos.y === nextPos.y;
  });
}

function resolveLayoutProfile(panelIds: string[]): LayoutProfile | null {
  const ids = new Set(panelIds);
  let best: LayoutProfile | null = null;
  let bestSpecificity = -1;

  for (const profile of WINDOW_LAYOUTS.profiles ?? []) {
    const matchIds = profile.matchPanelIds ?? [];
    if (!matchIds.every((id) => ids.has(id))) continue;

    if (matchIds.length > bestSpecificity) {
      best = profile;
      bestSpecificity = matchIds.length;
    }
  }

  return best;
}

function buildOrderedPanelIds(panelIds: string[], profile: LayoutProfile | null): string[] {
  if (!profile?.order || profile.order.length === 0) {
    return panelIds;
  }

  const existing = new Set(panelIds);
  const ordered = profile.order.filter((id) => existing.has(id));
  const seen = new Set(ordered);

  for (const id of panelIds) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  return ordered;
}

function getAnchoredDesiredPosition(
  panelId: string,
  panelSize: PanelSize,
  profile: LayoutProfile | null,
  placedPositions: Record<string, PanelPosition>,
  previousPositions: Record<string, PanelPosition>,
  panelMemory: Record<string, PanelPosition>,
  bounds: PanelSize,
  getPanelSize: (id: string) => PanelSize,
  panelGap = PANEL_GAP,
  anchorTargetOverride?: string,
): PanelPosition | null {
  if (!profile?.anchors) return null;
  const rule = profile.anchors[panelId];
  if (!rule) return null;

  const offsetX = rule.offsetX ?? 0;
  const offsetY = rule.offsetY ?? 0;

  if (rule.side === 'right-edge') {
    return {
      x: bounds.width - panelSize.width - PANEL_MARGIN + offsetX,
      y: PANEL_MARGIN + offsetY,
    };
  }

  if (rule.side === 'left-edge') {
    return {
      x: PANEL_MARGIN + offsetX,
      y: PANEL_MARGIN + offsetY,
    };
  }

  const anchorTargetId = anchorTargetOverride ?? rule.to;
  const anchorPos = placedPositions[anchorTargetId] ?? previousPositions[anchorTargetId] ?? panelMemory[anchorTargetId];
  if (!anchorPos) return null;

  const anchorSize = getPanelSize(anchorTargetId);
  const gap = rule.gap ?? panelGap;

  if (rule.side === 'below') {
    return {
      x: anchorPos.x + offsetX,
      y: anchorPos.y + anchorSize.height + gap + offsetY,
    };
  }

  if (rule.side === 'above') {
    return {
      x: anchorPos.x + offsetX,
      y: anchorPos.y - panelSize.height - gap + offsetY,
    };
  }

  if (rule.side === 'right') {
    return {
      x: anchorPos.x + anchorSize.width + gap + offsetX,
      y: anchorPos.y + offsetY,
    };
  }

  return {
    x: anchorPos.x - panelSize.width - gap + offsetX,
    y: anchorPos.y + offsetY,
  };
}

function isEdgeAnchored(panelId: string, profile: LayoutProfile | null): boolean {
  const side = profile?.anchors?.[panelId]?.side;
  return side === 'right-edge' || side === 'left-edge';
}

function inferAttachments(
  panelId: string,
  panelPos: PanelPosition,
  panelSize: PanelSize,
  others: AttachmentPanelRect[],
): PanelAttachment[] {
  const maxDistance = CHAIN_ATTACH_TOLERANCE * 2;
  const candidates: Array<{ attachment: PanelAttachment; distance: number }> = [];
  const seen = new Set<string>();

  const pushCandidate = (attachment: PanelAttachment, distance: number) => {
    const key = `${attachment.to}:${attachment.side}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ attachment, distance });
  };

  for (const other of others) {
    if (other.id === panelId) continue;

    const horizontalOverlap = rangesOverlap(panelPos.x, panelPos.x + panelSize.width, other.x, other.x + other.width);
    const verticalOverlap = rangesOverlap(panelPos.y, panelPos.y + panelSize.height, other.y, other.y + other.height);

    if (horizontalOverlap) {
      const belowGap = panelPos.y - (other.y + other.height);
      if (belowGap >= -maxDistance && belowGap <= maxDistance) {
        const dist = Math.abs(belowGap);
        pushCandidate({ to: other.id, side: 'below', gap: Math.max(0, belowGap) }, dist);
      }

      const aboveGap = other.y - (panelPos.y + panelSize.height);
      if (aboveGap >= -maxDistance && aboveGap <= maxDistance) {
        const dist = Math.abs(aboveGap);
        pushCandidate({ to: other.id, side: 'above', gap: Math.max(0, aboveGap) }, dist);
      }
    }

    if (verticalOverlap) {
      const rightGap = panelPos.x - (other.x + other.width);
      if (rightGap >= -maxDistance && rightGap <= maxDistance) {
        const dist = Math.abs(rightGap);
        pushCandidate({ to: other.id, side: 'right', gap: Math.max(0, rightGap) }, dist);
      }

      const leftGap = other.x - (panelPos.x + panelSize.width);
      if (leftGap >= -maxDistance && leftGap <= maxDistance) {
        const dist = Math.abs(leftGap);
        pushCandidate({ to: other.id, side: 'left', gap: Math.max(0, leftGap) }, dist);
      }
    }
  }

  return candidates
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map((entry) => entry.attachment);
}

function getAttachmentDesiredPosition(
  attachment: PanelAttachment,
  panelSize: PanelSize,
  parentPos: PanelPosition,
  parentSize: PanelSize,
): PanelPosition {
  if (attachment.side === 'below') {
    return {
      x: parentPos.x,
      y: parentPos.y + parentSize.height + attachment.gap,
    };
  }

  if (attachment.side === 'above') {
    return {
      x: parentPos.x,
      y: parentPos.y - panelSize.height - attachment.gap,
    };
  }

  if (attachment.side === 'right') {
    return {
      x: parentPos.x + parentSize.width + attachment.gap,
      y: parentPos.y,
    };
  }

  return {
    x: parentPos.x - panelSize.width - attachment.gap,
    y: parentPos.y,
  };
}

function buildSeededPositions(
  orderedPanelIds: string[],
  profile: LayoutProfile | null,
  bounds: PanelSize,
  getPanelSize: (id: string) => PanelSize,
  panelGap = PANEL_GAP,
): Record<string, PanelPosition> {
  const occupied: PanelRect[] = [];
  const next: Record<string, PanelPosition> = {};

  for (const panelId of orderedPanelIds) {
    const size = getPanelSize(panelId);
    const anchored = getAnchoredDesiredPosition(panelId, size, profile, next, {}, {}, bounds, getPanelSize, panelGap);

    const desired = anchored
      ? clampPosition(anchored, size, bounds)
      : occupied.length > 0
        ? {
            x: PANEL_MARGIN,
            y: occupied[occupied.length - 1].y + occupied[occupied.length - 1].height + panelGap,
          }
        : {
            x: PANEL_MARGIN,
            y: PANEL_MARGIN,
          };

    const freePosition = isEdgeAnchored(panelId, profile)
      ? desired
      : findNearestFreePosition(desired, size, occupied, bounds, panelGap);
    next[panelId] = freePosition;
    occupied.push({ ...freePosition, ...size });
  }

  return next;
}

type PanelEntry = {
  id: string;
  node: React.ReactNode;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

function flattenPanelChildren(children: React.ReactNode, prefix = 'panel'): PanelEntry[] {
  const entries: PanelEntry[] = [];

  React.Children.forEach(children, (child, index) => {
    if (child == null) return;

    const fallbackId = `${prefix}-${index}`;

    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment) {
      entries.push(...flattenPanelChildren(child.props.children, fallbackId));
      return;
    }

    const id = React.isValidElement(child) && child.key != null ? String(child.key) : fallbackId;
    if (React.isValidElement<{ x?: number; y?: number; width?: number; height?: number }>(child)) {
      const { x, y, width, height } = child.props;
      entries.push({ id, node: child, x, y, width, height });
      return;
    }

    entries.push({ id, node: child });
  });

  return entries;
}

function FloatingPanelItem({
  id,
  index,
  position,
  panelWidth,
  isDragging,
  magnetic,
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

    const emitSize = () => {
      onSizeChange(id, {
        width: element.offsetWidth || panelWidth,
        height: element.offsetHeight || DEFAULT_PANEL_HEIGHT,
      });
    };

    emitSize();

    const observer = new ResizeObserver(() => {
      emitSize();
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onSizeChange, panelWidth]);

  return (
    <div
      ref={itemRef}
      className="absolute pointer-events-auto"
      style={{
        left: position.x,
        top: position.y,
        width: panelWidth,
        zIndex: isDragging ? 100 : 20 + index,
        cursor: isDragging ? 'grabbing' : 'default',
        boxShadow: magnetic
          ? '0 0 0 1px color-mix(in srgb, var(--accent), white 15%), 0 0 0 5px color-mix(in srgb, var(--accent), transparent 76%), 0 14px 24px rgba(0, 0, 0, 0.28)'
          : undefined,
        borderRadius: magnetic ? '12px' : undefined,
        transition: isDragging ? 'none' : 'box-shadow 140ms ease',
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
        if ((dx * dx + dy * dy) > 36) {
          gesture.moved = true;
        }
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
      <div className="w-full [&>*]:!w-full">
        {children}
      </div>
    </div>
  );
}

/**
 * A container for floating UI panels that overlays the canvas.
 * Allows clicking through empty spaces to the canvas below.
 */
export function FloatingPanelStack({ children }: { children: React.ReactNode }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const panelSizesRef = React.useRef<Record<string, PanelSize>>({});
  const dragRef = React.useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const [panelPositions, setPanelPositions] = React.useState<Record<string, PanelPosition>>({});
  const [containerSize, setContainerSize] = React.useState<PanelSize>({ width: 1200, height: 800 });
  const [panelSizeVersion, setPanelSizeVersion] = React.useState(0);
  const [activeDragPanelId, setActiveDragPanelId] = React.useState<string | null>(null);
  const [edgeHint, setEdgeHint] = React.useState<EdgeHint>({ left: false, right: false, top: false, bottom: false });
  const [dropPreview, setDropPreview] = React.useState<DropPreview | null>(null);
  const [windowContextMenu, setWindowContextMenu] = React.useState<WindowContextMenuState | null>(null);
  const [persistLayout, setPersistLayout] = React.useState<boolean>(() => isFloatingLayoutPersistenceEnabled());

  const panelIdsRef = React.useRef<string[]>([]);
  const panelPositionsRef = React.useRef<Record<string, PanelPosition>>({});
  const panelMemoryRef = React.useRef<Record<string, PanelPosition>>({});
  const attachmentMemoryRef = React.useRef<Record<string, PanelAttachment[]>>({});
  const manualOverrideRef = React.useRef<Record<string, boolean>>({});
  const dropPreviewRef = React.useRef<DropPreview | null>(null);
  const layoutHydratedRef = React.useRef(false);

  const panelEntries = React.useMemo(() => flattenPanelChildren(children), [children]);
  const panelIds = React.useMemo(() => panelEntries.map((entry) => entry.id), [panelEntries]);
  const panelIdsSignature = React.useMemo(() => panelIds.join('\u001f'), [panelIds]);
  const stablePanelIds = React.useMemo(() => panelIds, [panelIdsSignature]);
  const panelWidthScale = React.useMemo(() => {
    const width = containerSize.width;
    const height = containerSize.height;

    if (width >= 3200 && height >= 1100) return 1.14;
    if (width >= 2600 && height >= 980) return 1.08;
    if (width <= 1100 || height <= 700) return 0.72;
    if (width <= 1366 || height <= 820) return 0.82;
    if (width <= 1600 || height <= 900) return 0.9;
    if (width <= 1800 || height <= 980) return 0.95;
    return 1;
  }, [containerSize.height, containerSize.width]);

  const panelGap = React.useMemo(() => {
    if (panelWidthScale <= 0.72) return 7;
    if (panelWidthScale <= 0.82) return 8;
    if (panelWidthScale <= 0.9) return 9;
    if (panelWidthScale <= 0.95) return 10;
    return PANEL_GAP;
  }, [panelWidthScale]);

  const getPanelWidth = React.useCallback((panelId: string) => {
    const baseWidth = getPanelBaseWidth(panelId);
    if (PANEL_SCALE_EXEMPT_IDS.has(panelId)) {
      if (panelWidthScale <= 1) {
        return baseWidth;
      }
      const supportUltrawideBoost = panelId === 'support-settings'
        ? (panelWidthScale >= 1.14 ? 1.1 : panelWidthScale >= 1.08 ? 1.06 : 1)
        : 1;
      return Math.max(72, Math.round(baseWidth * panelWidthScale * supportUltrawideBoost));
    }
    const analysisCompactFactor = panelId.startsWith('analysis-')
      ? (panelWidthScale < 1 ? 0.88 : 1)
      : 1;
    const scaledWidth = Math.round(baseWidth * panelWidthScale * analysisCompactFactor);
    return Math.max(72, scaledWidth);
  }, [panelWidthScale]);

  const getPanelSize = React.useCallback((panelId: string): PanelSize => {
    return panelSizesRef.current[panelId] ?? { width: getPanelWidth(panelId), height: DEFAULT_PANEL_HEIGHT };
  }, [getPanelWidth]);

  const layoutProfile = React.useMemo(() => resolveLayoutProfile(stablePanelIds), [stablePanelIds]);
  const orderedPanelIds = React.useMemo(() => buildOrderedPanelIds(stablePanelIds, layoutProfile), [layoutProfile, stablePanelIds]);
  const orderedPanelIdsSignature = React.useMemo(() => orderedPanelIds.join('\u001f'), [orderedPanelIds]);
  const seededPositions = React.useMemo(
    () => buildSeededPositions(orderedPanelIds, layoutProfile, containerSize, getPanelSize, panelGap),
    [containerSize, getPanelSize, layoutProfile, orderedPanelIds, panelGap],
  );

  const collectProfileAnchorDescendants = React.useCallback((rootId: string) => {
    const anchors = layoutProfile?.anchors ?? {};
    const result = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;

      for (const [panelId, rule] of Object.entries(anchors)) {
        if (rule.to !== current) continue;
        if (result.has(panelId) || panelId === rootId) continue;
        result.add(panelId);
        queue.push(panelId);
      }
    }

    return result;
  }, [layoutProfile]);

  React.useEffect(() => {
    panelIdsRef.current = stablePanelIds;
  }, [stablePanelIds]);

  React.useEffect(() => {
    panelPositionsRef.current = panelPositions;
    panelMemoryRef.current = {
      ...panelMemoryRef.current,
      ...panelPositions,
    };
  }, [panelPositions]);

  React.useEffect(() => {
    dropPreviewRef.current = dropPreview;
  }, [dropPreview]);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateContainerSize = () => {
      const nextWidth = element.clientWidth;
      const nextHeight = element.clientHeight;
      setContainerSize((previous) => {
        if (previous.width === nextWidth && previous.height === nextHeight) {
          return previous;
        }

        return {
          width: nextWidth,
          height: nextHeight,
        };
      });
    };

    updateContainerSize();
    const observer = new ResizeObserver(updateContainerSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncPreference = () => {
      setPersistLayout(isFloatingLayoutPersistenceEnabled());
    };

    syncPreference();
    window.addEventListener(FLOATING_LAYOUT_PERSISTENCE_EVENT, syncPreference as EventListener);
    window.addEventListener('storage', syncPreference);

    return () => {
      window.removeEventListener(FLOATING_LAYOUT_PERSISTENCE_EVENT, syncPreference as EventListener);
      window.removeEventListener('storage', syncPreference);
    };
  }, []);

  React.useLayoutEffect(() => {
    if (layoutHydratedRef.current) return;
    if (typeof window === 'undefined') return;
    if (!persistLayout) {
      layoutHydratedRef.current = true;
      return;
    }

    try {
      const raw = window.localStorage.getItem(FLOATING_LAYOUT_STORAGE_KEY);
      if (!raw) {
        layoutHydratedRef.current = true;
        return;
      }

      const parsed = JSON.parse(raw) as { positions?: Record<string, PanelPosition> };
      const saved = parsed?.positions;
      if (!saved || typeof saved !== 'object') {
        layoutHydratedRef.current = true;
        return;
      }

      const restored: Record<string, PanelPosition> = {};
      for (const panelId of stablePanelIds) {
        if (LOCKED_PANEL_IDS.has(panelId)) continue;
        const pos = saved[panelId];
        if (!pos) continue;
        if (typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
        restored[panelId] = { x: pos.x, y: pos.y };
      }

      panelMemoryRef.current = {
        ...panelMemoryRef.current,
        ...saved,
      };

      if (Object.keys(restored).length > 0) {
        const modelsId = 'prepare-models';
        const debugId = 'prepare-debug-primitives';
        const modelPos = restored[modelsId];
        const debugPos = restored[debugId];

        if (modelPos && debugPos && Math.abs(debugPos.x - modelPos.x) <= CHAIN_ATTACH_TOLERANCE * 2) {
          const modelSize = getPanelSize(modelsId);
          const expectedDebugY = modelPos.y + modelSize.height + panelGap;
          const hasLargeGap = debugPos.y - expectedDebugY > panelGap;

          if (hasLargeGap) {
            restored[debugId] = {
              ...debugPos,
              y: expectedDebugY,
            };
          }
        }

        setPanelPositions((previous) => ({ ...previous, ...restored }));
      }
    } catch {
      // Fall back to auto-layout defaults
    } finally {
      layoutHydratedRef.current = true;
    }
  }, [getPanelSize, panelGap, persistLayout, stablePanelIds]);

  React.useEffect(() => {
    if (!layoutHydratedRef.current) return;
    if (typeof window === 'undefined') return;
    if (Object.keys(panelPositions).length === 0) return;
    if (!persistLayout) return;

    const positionsToSave: Record<string, PanelPosition> = {};
    for (const [panelId, pos] of Object.entries(panelMemoryRef.current)) {
      if (!pos) continue;
      positionsToSave[panelId] = pos;
    }

    try {
      window.localStorage.setItem(FLOATING_LAYOUT_STORAGE_KEY, JSON.stringify({ positions: positionsToSave }));
    } catch {
      // Ignore storage write failures
    }
  }, [panelIdsSignature, panelPositions, persistLayout]);

  React.useEffect(() => {
    setPanelPositions((previous) => {
      const occupied: PanelRect[] = [];
      const next: Record<string, PanelPosition> = {};

      orderedPanelIds.forEach((panelId) => {
        const size = getPanelSize(panelId);
        const existing = previous[panelId];
        const remembered = panelMemoryRef.current[panelId];
        const linkedCandidates = attachmentMemoryRef.current[panelId] ?? [];
        const isLockedPanel = LOCKED_PANEL_IDS.has(panelId);
        const hasManualOverride = !isLockedPanel && manualOverrideRef.current[panelId] === true;
        const anchorRule = layoutProfile?.anchors?.[panelId];
        let effectiveAnchorTarget: string | undefined;

        if (anchorRule) {
          let candidate = anchorRule.to;
          const visited = new Set<string>([panelId]);

          while (manualOverrideRef.current[candidate] === true) {
            if (visited.has(candidate)) break;
            visited.add(candidate);

            const parentRule = layoutProfile?.anchors?.[candidate];
            if (!parentRule) break;
            candidate = parentRule.to;
          }

          effectiveAnchorTarget = candidate;
        }

        const anchored = getAnchoredDesiredPosition(
          panelId,
          size,
          layoutProfile,
          next,
          previous,
          panelMemoryRef.current,
          containerSize,
          getPanelSize,
          panelGap,
          effectiveAnchorTarget,
        );
        const linkedDesired = linkedCandidates
          .map((linked) => {
            if (!panelIdsRef.current.includes(linked.to)) return null;
            const linkedParentPos = next[linked.to] ?? previous[linked.to] ?? panelMemoryRef.current[linked.to];
            if (!linkedParentPos) return null;
            const linkedParentSize = getPanelSize(linked.to);
            return clampPosition(getAttachmentDesiredPosition(linked, size, linkedParentPos, linkedParentSize), size, containerSize);
          })
          .find((pos): pos is PanelPosition => !!pos) ?? null;
        const forceAnchoredPanelIds = new Set(['visual-settings', 'support-settings', 'prepare-smoothing-settings']);
        const hasProfileAnchor = !!layoutProfile?.anchors?.[panelId];
        const shouldPreferAnchor = !hasManualOverride && !!anchored && (forceAnchoredPanelIds.has(panelId) || hasProfileAnchor || isLockedPanel);
        const shouldPinEdgeAnchor = shouldPreferAnchor && isEdgeAnchored(panelId, layoutProfile);
        const desired = hasManualOverride
          ? (linkedDesired
            ? linkedDesired
            : existing
              ? clampPosition(existing, size, containerSize)
              : remembered
                ? clampPosition(remembered, size, containerSize)
                : anchored
                  ? clampPosition(anchored, size, containerSize)
                  : occupied.length > 0
                    ? {
                        x: PANEL_MARGIN,
                        y: occupied[occupied.length - 1].y + occupied[occupied.length - 1].height + panelGap,
                      }
                    : {
                        x: PANEL_MARGIN,
                        y: PANEL_MARGIN,
                      })
          : (shouldPreferAnchor
            ? clampPosition(anchored!, size, containerSize)
            : linkedDesired
              ? linkedDesired
              : existing
                ? clampPosition(existing, size, containerSize)
                : remembered
                  ? clampPosition(remembered, size, containerSize)
                  : anchored
                    ? clampPosition(anchored, size, containerSize)
                    : occupied.length > 0
                      ? {
                          x: PANEL_MARGIN,
                          y: occupied[occupied.length - 1].y + occupied[occupied.length - 1].height + panelGap,
                        }
                      : {
                          x: PANEL_MARGIN,
                          y: PANEL_MARGIN,
                        });

        const freePosition = shouldPinEdgeAnchor
          ? desired
          : findNearestFreePosition(desired, size, occupied, containerSize, panelGap);
        next[panelId] = freePosition;
        panelMemoryRef.current[panelId] = freePosition;
        occupied.push({ ...freePosition, ...size });
      });

      return positionsEqual(previous, next, stablePanelIds) ? previous : next;
    });
  }, [containerSize, getPanelSize, layoutProfile, orderedPanelIdsSignature, panelGap, panelIdsSignature, panelSizeVersion, stablePanelIds, orderedPanelIds]);

  const handlePanelSizeChange = React.useCallback((panelId: string, size: PanelSize) => {
    const prev = panelSizesRef.current[panelId];
    if (prev && prev.width === size.width && prev.height === size.height) {
      return;
    }

    panelSizesRef.current = {
      ...panelSizesRef.current,
      [panelId]: size,
    };

    setPanelSizeVersion((v) => v + 1);

    setPanelPositions((previous) => {
      const current = previous[panelId];
      if (!current) return previous;

      const clamped = clampPosition(current, size, containerSize);
      const heightDelta = prev ? (prev.height - size.height) : 0;
      if (clamped.x === current.x && clamped.y === current.y && Math.abs(heightDelta) < 0.5) {
        return previous;
      }

      const next: Record<string, PanelPosition> = {
        ...previous,
        [panelId]: clamped,
      };

      if (Math.abs(heightDelta) >= 0.5) {
        const queue: Array<{ id: string; delta: number }> = [{ id: panelId, delta: heightDelta }];
        const visited = new Set<string>([panelId]);

        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) break;

          const basePos = next[item.id];
          if (!basePos) continue;

          const baseSize = getPanelSize(item.id);
          const expectedAttachedY = basePos.y + baseSize.height + panelGap + item.delta;

          for (const candidateId of panelIdsRef.current) {
            if (candidateId === item.id || visited.has(candidateId)) continue;

            const candidatePos = next[candidateId];
            if (!candidatePos) continue;

            const candidateSize = getPanelSize(candidateId);
            const overlapsHorizontally = rangesOverlap(
              basePos.x,
              basePos.x + baseSize.width,
              candidatePos.x,
              candidatePos.x + candidateSize.width,
            );

            const sameColumnish = Math.abs(candidatePos.x - basePos.x) <= CHAIN_ATTACH_TOLERANCE * 2;

            if (!overlapsHorizontally && !sameColumnish) continue;

            const attachedAboveMinY = expectedAttachedY - CHAIN_ATTACH_TOLERANCE;
            const attachedBelowMaxY = expectedAttachedY + (CHAIN_ATTACH_TOLERANCE * 3);
            const isLikelyAttached = candidatePos.y >= attachedAboveMinY && candidatePos.y <= attachedBelowMaxY;
            if (!isLikelyAttached) continue;

            const shiftedY = clampPosition(
              { x: candidatePos.x, y: candidatePos.y - item.delta },
              candidateSize,
              containerSize,
            ).y;

            const movedAmount = candidatePos.y - shiftedY;
            next[candidateId] = {
              ...candidatePos,
              y: shiftedY,
            };
            visited.add(candidateId);

            if (Math.abs(movedAmount) >= 0.5) {
              queue.push({ id: candidateId, delta: movedAmount });
            }
          }
        }
      }

      return next;
    });
  }, [containerSize, getPanelSize, panelGap]);

  const snapPanelToNearestSpot = React.useCallback((panelId: string, position: PanelPosition) => {
    const size = getPanelSize(panelId);
    const clamped = clampPosition(position, size, containerSize);

    const otherPanels = stablePanelIds
      .filter((id) => id !== panelId)
      .map((id) => {
        const otherPos = panelPositions[id] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
        const otherSize = getPanelSize(id);
        return {
          ...otherPos,
          ...otherSize,
        };
      });

    const edgeMagnetic = applyEdgeMagnet(clamped, size, containerSize);
    const snappedToPanels = applyPanelMagnet(edgeMagnetic, size, otherPanels, panelGap);

    const rightEdgeX = Math.max(PANEL_MARGIN, containerSize.width - size.width - PANEL_MARGIN);
    const bottomEdgeY = Math.max(PANEL_MARGIN, containerSize.height - size.height - PANEL_MARGIN);

    const snapped = {
      x: Math.abs(snappedToPanels.x - PANEL_MARGIN) <= EDGE_SNAP_THRESHOLD
        ? PANEL_MARGIN
        : Math.abs(snappedToPanels.x - rightEdgeX) <= EDGE_SNAP_THRESHOLD
          ? rightEdgeX
          : snappedToPanels.x,
      y: Math.abs(snappedToPanels.y - PANEL_MARGIN) <= EDGE_SNAP_THRESHOLD
        ? PANEL_MARGIN
        : Math.abs(snappedToPanels.y - bottomEdgeY) <= EDGE_SNAP_THRESHOLD
          ? bottomEdgeY
          : snappedToPanels.y,
    };

    return findNearestFreePosition(snapped, size, otherPanels, containerSize, panelGap);
  }, [containerSize, getPanelSize, panelGap, panelPositions, stablePanelIds]);

  React.useEffect(() => {
    if (!activeDragPanelId) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== activeDragPanelId) return;

      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      const size = getPanelSize(activeDragPanelId);
      const clamped = clampPosition(
        {
          x: event.clientX - containerRect.left - drag.offsetX,
          y: event.clientY - containerRect.top - drag.offsetY,
        },
        size,
        containerSize,
      );

      const otherPanels = panelIdsRef.current
        .filter((id) => id !== activeDragPanelId)
        .map((id) => {
          const otherPos = panelPositionsRef.current[id] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
          const otherSize = getPanelSize(id);
          return {
            ...otherPos,
            ...otherSize,
          };
        });

      const edgeMagnetic = applyEdgeMagnet(clamped, size, containerSize);
      const magneticPosition = applyPanelMagnet(edgeMagnetic, size, otherPanels, panelGap);
      const hint = getEdgeHint(magneticPosition, size, containerSize, EDGE_HINT_THRESHOLD);
      setEdgeHint(hint);

      const previewPosition = findNearestFreePosition(magneticPosition, size, otherPanels, containerSize, panelGap);
      setDropPreview({ id: activeDragPanelId, position: previewPosition, size });

      setPanelPositions((previous) => ({
        ...previous,
        [activeDragPanelId]: magneticPosition,
      }));
    };

    const onPointerUp = () => {
      const drag = dragRef.current;
      if (!drag || drag.id !== activeDragPanelId) {
        setActiveDragPanelId(null);
        return;
      }

      setPanelPositions((previous) => {
        const currentPreview = dropPreviewRef.current;
        const current = currentPreview?.id === activeDragPanelId
          ? currentPreview.position
          : previous[activeDragPanelId] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
        const snapped = snapPanelToNearestSpot(activeDragPanelId, current);

        const otherPanels = panelIdsRef.current
          .filter((id) => id !== activeDragPanelId)
          .map((id) => {
            const otherPos = previous[id] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
            const otherSize = getPanelSize(id);
            return {
              id,
              ...otherPos,
              ...otherSize,
            };
          });

        const attachments = inferAttachments(activeDragPanelId, snapped, getPanelSize(activeDragPanelId), otherPanels);
        manualOverrideRef.current = {
          ...manualOverrideRef.current,
          [activeDragPanelId]: true,
        };

        if (attachments.length > 0) {
          attachmentMemoryRef.current = {
            ...attachmentMemoryRef.current,
            [activeDragPanelId]: attachments,
          };
        } else {
          const nextAttachments = { ...attachmentMemoryRef.current };
          delete nextAttachments[activeDragPanelId];
          attachmentMemoryRef.current = nextAttachments;
        }

        const childLinksToMoved = Object.entries(attachmentMemoryRef.current)
          .filter(([, childAttachments]) => childAttachments.some((childAttachment) => childAttachment.to === activeDragPanelId));

        if (childLinksToMoved.length > 0) {
          const nextAttachments = { ...attachmentMemoryRef.current };

          for (const [childId, childAttachments] of childLinksToMoved) {
            const filtered = childAttachments.filter((childAttachment) => childAttachment.to !== activeDragPanelId);
            if (filtered.length > 0) {
              nextAttachments[childId] = filtered;
            } else {
              delete nextAttachments[childId];
            }
          }

          attachmentMemoryRef.current = nextAttachments;
        }

        return {
          ...previous,
          [activeDragPanelId]: snapped,
        };
      });

      dragRef.current = null;
      setEdgeHint({ left: false, right: false, top: false, bottom: false });
      setDropPreview(null);
      setActiveDragPanelId(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [activeDragPanelId, containerSize, getPanelSize, panelGap, snapPanelToNearestSpot]);

  React.useEffect(() => {
    const validIds = new Set(panelIdsRef.current);
    const cleaned: Record<string, PanelAttachment[]> = {};
    const cleanedOverrides: Record<string, boolean> = {};

    for (const [panelId, attachments] of Object.entries(attachmentMemoryRef.current)) {
      if (!validIds.has(panelId)) continue;
      const filtered = attachments.filter((attachment) => validIds.has(attachment.to) && panelId !== attachment.to);
      if (filtered.length === 0) continue;
      cleaned[panelId] = filtered;
    }

    for (const [panelId, manual] of Object.entries(manualOverrideRef.current)) {
      if (!validIds.has(panelId)) continue;
      if (!manual) continue;
      cleanedOverrides[panelId] = true;
    }

    attachmentMemoryRef.current = cleaned;
    manualOverrideRef.current = cleanedOverrides;
  }, [panelIds]);

  const handlePointerDown = React.useCallback((panelId: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (LOCKED_PANEL_IDS.has(panelId)) return;
    if (isDragBlockedByTarget(event.target)) return;

    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const panelPosition = panelPositions[panelId] ?? seededPositions[panelId] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
    setActiveDragPanelId(panelId);
    setEdgeHint({ left: false, right: false, top: false, bottom: false });
    setDropPreview({ id: panelId, position: panelPosition, size: getPanelSize(panelId) });
    dragRef.current = {
      id: panelId,
      offsetX: event.clientX - containerRect.left - panelPosition.x,
      offsetY: event.clientY - containerRect.top - panelPosition.y,
    };
    event.preventDefault();
  }, [getPanelSize, panelPositions, seededPositions]);

  const closeWindowContextMenu = React.useCallback(() => {
    setWindowContextMenu(null);
  }, []);

  const handlePanelContextMenu = React.useCallback((panelId: string, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setWindowContextMenu({
      panelId,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const resetSingleWindow = React.useCallback((panelId: string) => {
    closeWindowContextMenu();
    setPanelPositions((previous) => {
      const target = seededPositions[panelId] ?? previous[panelId] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
      const next = { ...previous, [panelId]: target };
      panelMemoryRef.current = { ...panelMemoryRef.current, [panelId]: target };

      const nextAttachments = { ...attachmentMemoryRef.current };
      delete nextAttachments[panelId];
      attachmentMemoryRef.current = nextAttachments;

      const nextOverrides = { ...manualOverrideRef.current };
      delete nextOverrides[panelId];
      manualOverrideRef.current = nextOverrides;

      return next;
    });
  }, [closeWindowContextMenu, seededPositions]);

  const resetAllWindows = React.useCallback(() => {
    closeWindowContextMenu();
    setPanelPositions(() => {
      const next: Record<string, PanelPosition> = {};
      for (const panelId of panelIdsRef.current) {
        next[panelId] = seededPositions[panelId] ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };
      }
      panelMemoryRef.current = { ...panelMemoryRef.current, ...next };
      attachmentMemoryRef.current = {};
      manualOverrideRef.current = {};
      return next;
    });

    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(FLOATING_LAYOUT_STORAGE_KEY);
      } catch {
        // ignore storage failures
      }
    }
  }, [closeWindowContextMenu, seededPositions]);

  React.useEffect(() => {
    if (!windowContextMenu) return;

    const handlePointerDown = () => closeWindowContextMenu();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWindowContextMenu();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [windowContextMenu, closeWindowContextMenu]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleDebugDumpRequest = (event: Event) => {
      const customEvent = event as CustomEvent<FloatingLayoutDebugRequestDetail>;
      const detail = customEvent.detail;
      if (!detail?.onResult) return;

      const positions: Record<string, PanelPosition> = {};
      for (const panelId of panelIdsRef.current) {
        const pos = panelPositionsRef.current[panelId]
          ?? panelMemoryRef.current[panelId]
          ?? seededPositions[panelId]
          ?? { x: PANEL_MARGIN, y: PANEL_MARGIN };

        positions[panelId] = { x: pos.x, y: pos.y };
      }

      const snapshot: FloatingLayoutDebugSnapshot = {
        version: 1,
        capturedAt: new Date().toISOString(),
        persistenceEnabled: persistLayout,
        storageKey: FLOATING_LAYOUT_STORAGE_KEY,
        panelIds: [...panelIdsRef.current],
        positions,
      };

      detail.onResult(snapshot);
    };

    window.addEventListener(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, handleDebugDumpRequest as EventListener);
    return () => {
      window.removeEventListener(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, handleDebugDumpRequest as EventListener);
    };
  }, [persistLayout, seededPositions]);

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  return (
    <div
      ref={containerRef}
      className="absolute left-0 right-0 top-[var(--topbar-height)] bottom-0 z-10 pointer-events-none"
    >
      {panelEntries.map((entry, index) => {
        const panelId = entry.id;
        const panelPosition = panelPositions[panelId] ?? seededPositions[panelId] ?? {
          x: PANEL_MARGIN,
          y: PANEL_MARGIN + index * 18,
        };

        const magnetic = activeDragPanelId === panelId && hasEdgeHint(edgeHint);

        return entry.node ? (
          <FloatingPanelItem
            key={panelId}
            id={panelId}
            index={index}
            position={panelPosition}
            panelWidth={getPanelWidth(panelId)}
            isDragging={activeDragPanelId === panelId}
            magnetic={magnetic}
            onPointerDown={handlePointerDown}
            onContextMenu={handlePanelContextMenu}
            onSizeChange={handlePanelSizeChange}
          >
            {entry.node}
          </FloatingPanelItem>
        ) : null;
      })}

      {activeDragPanelId && hasEdgeHint(edgeHint) ? <EdgeSnapOverlay hint={edgeHint} /> : null}

      {dropPreview ? (
        <div
          className="absolute pointer-events-none rounded-lg border-2 border-dashed"
          style={{
            left: dropPreview.position.x,
            top: dropPreview.position.y,
            width: dropPreview.size.width,
            height: dropPreview.size.height,
            borderColor: 'color-mix(in srgb, var(--accent), white 12%)',
            background: 'color-mix(in srgb, var(--accent), transparent 88%)',
            boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent), transparent 82%)',
            zIndex: 90,
          }}
        />
      ) : null}

      {windowContextMenu ? (
        <div
          className="fixed z-[140] pointer-events-auto w-56 rounded-lg border p-1.5 shadow-xl"
          style={{
            left: Math.max(8, Math.min(windowContextMenu.x, viewportWidth - 232)),
            top: Math.max(8, Math.min(windowContextMenu.y, viewportHeight - 120)),
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
            style={{ color: 'var(--text-strong)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={() => resetSingleWindow(windowContextMenu.panelId)}
          >
            Reset this window
          </button>
          <button
            type="button"
            className="w-full rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
            style={{ color: 'var(--text-strong)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
            onClick={resetAllWindows}
          >
            Reset all windows layout
          </button>
        </div>
      ) : null}
    </div>
  );
}
