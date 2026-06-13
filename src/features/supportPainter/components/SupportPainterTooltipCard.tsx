import React, { useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';
import { useSupportPainterState } from '../supportPainterStore';
import { BRUSH_COLORS } from '../supportPainterTypes';
import { subscribeToSupportKindState, getSupportKindSnapshot } from '@/supports/Settings/supportKindState';

interface SupportPainterTooltipCardProps {
  mode?: string;
}

export function SupportPainterTooltipCard({ mode }: SupportPainterTooltipCardProps) {
  const painterState = useSupportPainterState();
  const [isCollapsed, setIsCollapsed] = useState(false);

  const supportKindState = useSyncExternalStore(
    subscribeToSupportKindState,
    getSupportKindSnapshot,
    getSupportKindSnapshot
  );
  const activeKind = supportKindState.kind;

  const isPainterActive = mode === 'supportPainter';
  const isSupportActive = mode === 'support';

  // Do not render if neither support mode is active
  if (!isPainterActive && !isSupportActive) return null;

  // Gather mode and styling details
  let modeLabel = '';
  let modeColor = '';

  if (isPainterActive) {
    const brushLabel = painterState.activeCustomBrushId
      ? painterState.customBrushes.get(painterState.activeCustomBrushId)?.name ?? `${painterState.activeBrush} (Custom)`
      : painterState.activeBrush;

    const brushColor = painterState.activeCustomBrushId
      ? painterState.customBrushes.get(painterState.activeCustomBrushId)?.color ?? BRUSH_COLORS[painterState.activeBrush]
      : BRUSH_COLORS[painterState.activeBrush];

    modeLabel = brushLabel;
    modeColor = brushColor;
  } else {
    modeLabel = activeKind.charAt(0).toUpperCase() + activeKind.slice(1);
    
    // Choose dynamic color based on the selected tab
    const kindColors: Record<string, string> = {
      trunk: '#3b82f6', // blue
      branch: '#10b981', // green
      leaf: '#f59e0b', // amber
      twig: '#8b5cf6', // purple
      raft: '#a78bfa', // lighter purple
      grid: '#ec4899', // pink
      stick: '#06b6d4', // cyan
    };
    modeColor = kindColors[activeKind] ?? 'var(--accent, #3b82f6)';
  }

  // Gather hotkeys dynamically
  let hotkeysToRender: { keys: string[]; desc: string }[] = [];

  if (isPainterActive) {
    const isMarker = painterState.activeBrush === 'Marker';
    hotkeysToRender = [
      { keys: ['Left Click'], desc: 'Add paint / point' },
      { keys: ['Click', 'Drag'], desc: 'Continuous stroke' },
    ];
    if (isMarker) {
      hotkeysToRender.push({ keys: ['Alt', 'Click'], desc: 'Erase paint' });
    }
    hotkeysToRender.push(
      { keys: ['Ctrl', 'Z / Y'], desc: 'Undo / Redo stroke' },
      { keys: ['Shift', 'Click'], desc: 'Directly place trunk' },
      { keys: ['Shift', 'Alt'], desc: 'Direct Branch / Brace' },
      { keys: ['Shift', 'Ctrl', 'Alt'], desc: 'Direct Leaf placement' },
      { keys: ['Shift', 'Control'], desc: 'Direct Kickstand placement' },
      { keys: ['Shift', 'J'], desc: 'Direct Joint Creation' },
      { keys: ['Shift', 'C'], desc: 'Direct Curved segment' }
    );
  } else if (isSupportActive) {
    if (activeKind === 'trunk') {
      hotkeysToRender = [
        { keys: ['Left Click'], desc: 'Place trunk on mesh' },
        { keys: ['Alt'], desc: 'Hold for Branch / Brace' },
        { keys: ['Ctrl', 'Alt'], desc: 'Hold for Leaf placement' },
        { keys: ['Control'], desc: 'Hold for Kickstand placement' },
        { keys: ['J'], desc: 'Hold for Joint Creation' },
        { keys: ['C'], desc: 'Hold for Curved segment' },
        { keys: ['Delete'], desc: 'Delete selected support' },
      ];
    } else if (activeKind === 'branch') {
      hotkeysToRender = [
        { keys: ['Alt'], desc: 'Hold for Branch / Brace' },
        { keys: ['Alt', 'Click'], desc: 'Mesh click sets branch tip' },
        { keys: ['Alt', 'Click'], desc: 'Support click places brace' },
        { keys: ['Alt', 'Drag'], desc: 'Move / adjust joint' },
        { keys: ['C'], desc: 'Hold to create curved segment' },
        { keys: ['Delete'], desc: 'Delete selected branch' },
      ];
    } else if (activeKind === 'leaf') {
      hotkeysToRender = [
        { keys: ['Ctrl', 'Alt'], desc: 'Hold for Leaf placement' },
        { keys: ['Ctrl', 'Alt', 'Click'], desc: 'Place leaf on mesh / support' },
        { keys: ['Delete'], desc: 'Delete selected leaf' },
      ];
    } else if (activeKind === 'twig') {
      hotkeysToRender = [
        { keys: ['Alt'], desc: 'Hold for Twig / Brace' },
        { keys: ['Delete'], desc: 'Delete selected twig' },
      ];
    } else if (activeKind === 'stick') {
      hotkeysToRender = [
        { keys: ['Alt'], desc: 'Hold for Brace placement' },
        { keys: ['Control'], desc: 'Hold for Kickstand placement' },
        { keys: ['Delete'], desc: 'Delete selected bracing' },
      ];
    } else if (activeKind === 'raft') {
      hotkeysToRender = [
        { keys: ['Left Click'], desc: 'Select raft or base' },
        { keys: ['Delete'], desc: 'Delete selected raft' },
      ];
    } else if (activeKind === 'grid') {
      hotkeysToRender = [
        { keys: ['Left Click'], desc: 'Select grid segment' },
        { keys: ['Delete'], desc: 'Delete selected grid' },
      ];
    }
    // Universal undo/redo
    hotkeysToRender.push({ keys: ['Ctrl', 'Z / Y'], desc: 'Undo / Redo action' });
  }

  return (
    <div
      className="w-full max-w-[320px] rounded-md border backdrop-blur-md shadow-xl transition-all duration-200 pointer-events-auto flex flex-col max-h-full min-h-0"
      style={{
        background: 'rgba(15, 17, 23, 0.88)',
        borderColor: 'rgba(45, 55, 72, 0.45)',
        color: 'var(--text-strong, #f7fafc)',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Premium Cased Rollup Header */}
      <div
        onClick={() => setIsCollapsed(!isCollapsed)}
        data-panel-drag-handle="true"
        className="flex items-center justify-between px-3.5 py-2 cursor-pointer select-none flex-shrink-0"
        style={{
          borderBottom: isCollapsed ? 'none' : '1px solid rgba(45, 55, 72, 0.25)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <HelpCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent, #3b82f6)' }} />
          <span className="text-[12px] font-semibold text-gray-200">
            Quick Reference
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Active Mode indicator */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.4)]"
              style={{ backgroundColor: modeColor }}
            />
            <span className="text-[10px] font-semibold text-gray-400">
              {modeLabel}
            </span>
          </div>
          <button className="text-gray-400 hover:text-gray-200 focus:outline-none transition-colors">
            {isCollapsed ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Main Reference Body */}
      {!isCollapsed && (
        <div className="px-3.5 py-3 flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {/* Hotkeys header */}
          <div className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">
            Hotkeys
          </div>

          {/* Shortcuts Grid */}
          <div className="grid grid-cols-[90px_1fr] gap-x-2.5 gap-y-2 text-[11px] items-center">
            {hotkeysToRender.map((hk, i) => (
              <React.Fragment key={i}>
                <div className="flex flex-wrap gap-0.5 justify-start">
                  {hk.keys.map((k, ki) => (
                    <React.Fragment key={ki}>
                      {ki > 0 && <span className="text-gray-500 font-bold px-0.5 text-[9px] self-center">+</span>}
                      <kbd className="px-1.5 py-0.5 rounded bg-gray-900 text-[9px] font-semibold border border-gray-800 text-gray-200">
                        {k}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
                <span className="text-gray-300 text-left font-medium">
                  {hk.desc}
                </span>
              </React.Fragment>
            ))}
          </div>

          {/* Conditional PointPath Reference */}
          {isPainterActive && painterState.activeBrush === 'PointPath' && (
            <div
              className="flex flex-col gap-1.5 p-2 rounded text-left mt-1"
              style={{
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.2)',
              }}
            >
              <span className="text-[10px] font-bold text-emerald-400">
                Point Path Modality
              </span>
              <div className="flex flex-col gap-0.5 text-[10px] leading-relaxed text-gray-300">
                <p>
                  • Place path nodes on mesh. Dragging creates continuous segments.
                </p>
                <p>
                  • Closure proximity highlight (green glow) triggers within{' '}
                  <span className="font-bold text-emerald-400">0.3mm</span>.
                </p>
                <p>
                  • <span className="font-semibold text-emerald-300">Mode A (Line)</span>: Traces support rows.
                </p>
                <p>
                  • <span className="font-semibold text-emerald-300">Mode B (Polygon)</span>: Closes loop to flood-fill paint.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
