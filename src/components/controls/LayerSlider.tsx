"use client";

import React from 'react';

type LayerSliderProps = {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  onCrossSectionModeChange?: (mode: 'smooth' | 'rasterized') => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  className?: string;
  showValue?: boolean;
  crossSectionMode?: 'smooth' | 'rasterized';
  docked?: boolean;
  embedded?: boolean;
  expandToContainer?: boolean;
  dragBatchMode?: 'raf' | 'immediate';
  lowerValue?: number;
  onLowerChange?: (next: number) => void;
  lowerCurrentHeightMm?: number;
  showModeIndicator?: boolean;
  crossSectionEnabled?: boolean;
  onToggleCrossSection?: () => void;
  layerHeightMm?: number;
};

export function LayerSlider({ min, max, step, value, onChange, onScrubStart, onScrubEnd, onCrossSectionModeChange, currentHeightMm, maxHeightMm, className, showValue = false, crossSectionMode = 'smooth', docked = false, embedded = false, expandToContainer = false, dragBatchMode = 'raf', lowerValue, onLowerChange, lowerCurrentHeightMm, showModeIndicator = true, crossSectionEnabled = true, onToggleCrossSection, layerHeightMm }: LayerSliderProps) {
  const isMinimalRail = embedded && docked;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const errorTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const valueRef = React.useRef(value);
  const [inputValue, setInputValue] = React.useState(String(Math.round(value)));
  const [showError, setShowError] = React.useState(false);
  const [isShiftHeld, setIsShiftHeld] = React.useState(false);
  const [isDraggingThumb, setIsDraggingThumb] = React.useState(false);
  const dragShiftModeRef = React.useRef<boolean>(false); // Lock shift mode for entire drag
  const lowerValueRef = React.useRef(0);
  const activeDraggingThumbRef = React.useRef<'upper' | 'lower' | 'window'>('upper');
  const windowDragStartClientYRef = React.useRef(0);
  const windowDragStartUpperRef = React.useRef(0);
  const windowDragStartLowerRef = React.useRef(0);

  // Thumb click-to-edit state
  const [editingThumb, setEditingThumb] = React.useState<'upper' | 'lower' | null>(null);
  const [editMode, setEditMode] = React.useState<'layer' | 'mm'>('layer');
  const [editRawValue, setEditRawValue] = React.useState('');
  const editInputRef = React.useRef<HTMLInputElement>(null);
  const editPopoverRef = React.useRef<HTMLDivElement>(null);
  const openThumbEditRef = React.useRef<((thumb: 'upper' | 'lower') => void) | null>(null);

  const formatMm = React.useCallback((mm: number) => {
    if (!Number.isFinite(mm)) return '0';
    return mm.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }, []);

  // Update input value when slider value changes externally
  React.useEffect(() => {
    valueRef.current = value;
    const roundedValue = String(Math.round(value));
    setInputValue((previous) => (previous === roundedValue ? previous : roundedValue));
  }, [value]);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const clamp = React.useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const snap = React.useCallback((v: number) => {
    const s = step || 1;
    return Math.round(v / s) * s;
  }, [step]);

  const emitChange = React.useCallback((rawNext: number) => {
    // Upper thumb must never go below the lower thumb
    const floor = lowerValueRef.current ?? min;
    const next = Math.max(clamp(snap(rawNext)), floor);
    if (next === valueRef.current) return;
    onChange(next);
  }, [clamp, min, onChange, snap]);

  // Keep lowerValueRef in sync
  React.useEffect(() => {
    lowerValueRef.current = lowerValue ?? min;
  }, [lowerValue, min]);

  const emitLowerChange = React.useCallback((rawNext: number) => {
    if (!onLowerChange) return;
    const next = Math.min(clamp(snap(rawNext)), valueRef.current);
    if (next === lowerValueRef.current) return;
    onLowerChange(next);
  }, [clamp, onLowerChange, snap]);

  const emitWindowChange = React.useCallback((rawLower: number, rawUpper: number) => {
    if (!onLowerChange) return;

    const minMaxSpan = Math.max(0, max - min);
    let targetLower = rawLower;
    let targetUpper = rawUpper;

    // Keep ordered and within range.
    if (targetLower > targetUpper) {
      const swap = targetLower;
      targetLower = targetUpper;
      targetUpper = swap;
    }

    const windowSpan = Math.min(minMaxSpan, Math.max(0, targetUpper - targetLower));

    if (targetLower < min) {
      targetLower = min;
      targetUpper = min + windowSpan;
    }
    if (targetUpper > max) {
      targetUpper = max;
      targetLower = max - windowSpan;
    }

    const snappedLower = clamp(snap(targetLower));
    let snappedUpper = snappedLower + windowSpan;

    if (snappedUpper > max) {
      snappedUpper = max;
    }
    if (snappedUpper < snappedLower) {
      snappedUpper = snappedLower;
    }

    const finalUpper = clamp(snap(snappedUpper));
    const finalLower = Math.min(clamp(snap(snappedLower)), finalUpper);

    if (finalLower !== lowerValueRef.current) {
      onLowerChange(finalLower);
    }
    if (finalUpper !== valueRef.current) {
      onChange(finalUpper);
    }
  }, [clamp, max, min, onChange, onLowerChange, snap]);


  const setByClientY = React.useCallback((clientY: number, shiftKey: boolean = false) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientY - rect.top) / rect.height; // 0 at top, 1 at bottom
    const inv = 1 - rel; // 0 bottom, 1 top -> we want 0..1 bottom->top
    const span = Math.max(1e-6, max - min);
    
    if (shiftKey) {
      // Fine-grained control: reduce sensitivity by 10x
      const currentPercent = (valueRef.current - min) / span;
      const delta = (inv - currentPercent) * 0.1; // 10x slower movement
      const newPercent = currentPercent + delta;
      const v = min + newPercent * span;
      emitChange(v);
    } else {
      // Normal control
      const v = min + inv * span;
      emitChange(v);
    }
  }, [emitChange, max, min]);

  const setLowerByClientY = React.useCallback((clientY: number, shiftKey: boolean = false) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientY - rect.top) / rect.height;
    const inv = 1 - rel;
    const span = Math.max(1e-6, max - min);
    if (shiftKey) {
      const currentPercent = (lowerValueRef.current - min) / span;
      const delta = (inv - currentPercent) * 0.1;
      const newPercent = currentPercent + delta;
      emitLowerChange(min + newPercent * span);
    } else {
      emitLowerChange(min + inv * span);
    }
  }, [emitLowerChange, max, min]);

  const openThumbEdit = React.useCallback((thumb: 'upper' | 'lower') => {
    const currentLayer = thumb === 'upper' ? valueRef.current : lowerValueRef.current;
    setEditMode('layer');
    setEditRawValue(String(Math.round(currentLayer)));
    setEditingThumb(thumb);
  }, []);
  // Keep ref in sync so drag closures can call it without stale captures
  openThumbEditRef.current = openThumbEdit;

  const commitThumbEdit = React.useCallback(() => {
    if (!editingThumb) return;
    const parsed = parseFloat(editRawValue);
    if (!isNaN(parsed) && parsed >= 0) {
      const lhMm = layerHeightMm ?? 0;
      const targetLayer = (editMode === 'mm' && lhMm > 0)
        ? Math.round(parsed / lhMm)
        : Math.round(parsed);
      if (editingThumb === 'upper') emitChange(targetLayer);
      else emitLowerChange(targetLayer);
    }
    setEditingThumb(null);
  }, [editingThumb, editRawValue, editMode, layerHeightMm, emitChange, emitLowerChange]);

  const switchEditMode = React.useCallback((newMode: 'layer' | 'mm') => {
    if (newMode === editMode || !layerHeightMm || layerHeightMm <= 0) return;
    const current = parseFloat(editRawValue);
    if (!isNaN(current) && current >= 0) {
      if (newMode === 'mm') {
        setEditRawValue((current * layerHeightMm).toFixed(3).replace(/\.?0+$/, ''));
      } else {
        setEditRawValue(String(Math.round(current / layerHeightMm)));
      }
    }
    setEditMode(newMode);
    requestAnimationFrame(() => { editInputRef.current?.select(); });
  }, [editMode, editRawValue, layerHeightMm]);

  // Auto-focus the input when a thumb edit popover opens
  React.useEffect(() => {
    if (editingThumb) {
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    }
  }, [editingThumb]);

  // Dismiss + commit when clicking outside the popover
  React.useEffect(() => {
    if (!editingThumb) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (editPopoverRef.current && !editPopoverRef.current.contains(e.target as Node)) {
        commitThumbEdit();
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [editingThumb, commitThumbEdit]);
  const onPointerDown = React.useCallback((e: React.MouseEvent) => {
    // Right-click: open the thumb popover if near a thumb, then let onContextMenu handle the rest
    if (e.button === 2) {
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const clickInv = 1 - (e.clientY - rect.top) / rect.height;
        const span = Math.max(1e-6, max - min);
        const upperPos = (valueRef.current - min) / span;
        const thumbGrabThreshold = 0.035;
        if (lowerValue != null) {
          const lowerPos = (lowerValueRef.current - min) / span;
          const lowerDistance = Math.abs(clickInv - lowerPos);
          const upperDistance = Math.abs(clickInv - upperPos);
          if (lowerDistance <= thumbGrabThreshold || upperDistance <= thumbGrabThreshold) {
            openThumbEditRef.current?.(lowerDistance < upperDistance ? 'lower' : 'upper');
            e.preventDefault();
            e.stopPropagation();
          }
        } else if (Math.abs(clickInv - upperPos) <= thumbGrabThreshold) {
          openThumbEditRef.current?.('upper');
          e.preventDefault();
          e.stopPropagation();
        }
      }
      return;
    }
    if (e.button !== 0) return; // only left-click drags
    e.preventDefault();
    e.stopPropagation();
    onScrubStart?.();
    // Start with current shift state
    setIsDraggingThumb(true);
    dragShiftModeRef.current = e.shiftKey;
    setIsShiftHeld(e.shiftKey);
    // Determine which thumb to drag based on proximity — bail if not near any thumb
    if (lowerValue != null && onLowerChange != null) {
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const clickInv = 1 - (e.clientY - rect.top) / rect.height;
        const span = Math.max(1e-6, max - min);
        const upperPos = (valueRef.current - min) / span;
        const lowerPos = (lowerValueRef.current - min) / span;
        const lowerDistance = Math.abs(clickInv - lowerPos);
        const upperDistance = Math.abs(clickInv - upperPos);
        const thumbGrabThreshold = 0.035;

        if (lowerDistance > thumbGrabThreshold && upperDistance > thumbGrabThreshold) {
          // Not near either thumb — only accept if inside the window region for window-drag
          const inWindowRegion = clickInv >= Math.min(lowerPos, upperPos) && clickInv <= Math.max(lowerPos, upperPos);
          if (inWindowRegion) {
            activeDraggingThumbRef.current = 'window';
            windowDragStartClientYRef.current = e.clientY;
            windowDragStartLowerRef.current = lowerValueRef.current;
            windowDragStartUpperRef.current = valueRef.current;
          } else {
            // Bare track click — ignore completely
            setIsDraggingThumb(false);
            dragShiftModeRef.current = false;
            setIsShiftHeld(false);
            onScrubEnd?.();
            return;
          }
        } else if (lowerDistance < upperDistance) {
          activeDraggingThumbRef.current = 'lower';
        } else {
          activeDraggingThumbRef.current = 'upper';
        }
      } else {
        activeDraggingThumbRef.current = 'upper';
      }
    } else {
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const clickInv = 1 - (e.clientY - rect.top) / rect.height;
        const span = Math.max(1e-6, max - min);
        const upperPos = (valueRef.current - min) / span;
        const thumbGrabThreshold = 0.035;

        if (Math.abs(clickInv - upperPos) > thumbGrabThreshold) {
          // Not near thumb — ignore completely
          setIsDraggingThumb(false);
          dragShiftModeRef.current = false;
          setIsShiftHeld(false);
          onScrubEnd?.();
          return;
        }
      }
      activeDraggingThumbRef.current = 'upper';
    }

    let rafId: number | null = null;
    let pendingClientY = e.clientY;

    const flushMove = () => {
      rafId = null;
      if (activeDraggingThumbRef.current === 'lower') {
        setLowerByClientY(pendingClientY, dragShiftModeRef.current);
      } else if (activeDraggingThumbRef.current === 'window') {
        const el = containerRef.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const span = Math.max(1e-6, max - min);
        const dragDeltaInv = -((pendingClientY - windowDragStartClientYRef.current) / Math.max(1, rect.height));
        const precisionFactor = dragShiftModeRef.current ? 0.1 : 1;
        const deltaValue = dragDeltaInv * span * precisionFactor;

        const windowSpan = windowDragStartUpperRef.current - windowDragStartLowerRef.current;
        let nextLower = windowDragStartLowerRef.current + deltaValue;
        let nextUpper = nextLower + windowSpan;

        if (nextLower < min) {
          nextLower = min;
          nextUpper = min + windowSpan;
        }
        if (nextUpper > max) {
          nextUpper = max;
          nextLower = max - windowSpan;
        }

        emitWindowChange(nextLower, nextUpper);
      } else {
        setByClientY(pendingClientY, dragShiftModeRef.current);
      }
    };
    
    const onMove = (ev: MouseEvent) => {
      // Allow shift to be turned ON during drag, but once on it stays on
      if (ev.shiftKey && !dragShiftModeRef.current) {
        dragShiftModeRef.current = true;
        setIsShiftHeld(true);
      }

      if (dragBatchMode === 'immediate') {
        if (activeDraggingThumbRef.current === 'lower') {
          setLowerByClientY(ev.clientY, dragShiftModeRef.current);
        } else if (activeDraggingThumbRef.current === 'window') {
          const el = containerRef.current;
          if (!el) return;

          const rect = el.getBoundingClientRect();
          const span = Math.max(1e-6, max - min);
          const dragDeltaInv = -((ev.clientY - windowDragStartClientYRef.current) / Math.max(1, rect.height));
          const precisionFactor = dragShiftModeRef.current ? 0.1 : 1;
          const deltaValue = dragDeltaInv * span * precisionFactor;

          const windowSpan = windowDragStartUpperRef.current - windowDragStartLowerRef.current;
          let nextLower = windowDragStartLowerRef.current + deltaValue;
          let nextUpper = nextLower + windowSpan;

          if (nextLower < min) {
            nextLower = min;
            nextUpper = min + windowSpan;
          }
          if (nextUpper > max) {
            nextUpper = max;
            nextLower = max - windowSpan;
          }

          emitWindowChange(nextLower, nextUpper);
        } else {
          setByClientY(ev.clientY, dragShiftModeRef.current);
        }
        return;
      }

      pendingClientY = ev.clientY;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(flushMove);
    };

    let settled = false;
    const settleDrag = () => {
      if (settled) return;
      settled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      // Only reset on mouse up
      setIsDraggingThumb(false);
      dragShiftModeRef.current = false;
      setIsShiftHeld(false);
      onScrubEnd?.();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', settleDrag);
    };

    const onUp = () => {
      settleDrag();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', settleDrag);
  }, [dragBatchMode, emitWindowChange, max, min, onLowerChange, onScrubEnd, onScrubStart, setByClientY, setLowerByClientY]);

  const nudge = React.useCallback((dir: 1 | -1) => {
    const s = step || 1;
    emitChange(valueRef.current + dir * s);
  }, [emitChange, step]);

  // Use native wheel event listener with passive: false to allow preventDefault
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Inverted direction: wheel down moves to lower layers, wheel up moves to higher layers.
      const dir: 1 | -1 = e.deltaY > 0 ? -1 : 1;
      
      if (e.shiftKey) {
        // Fine-grained control: move by 0.1 steps
        const fineStep = (step || 1) * 0.1;
        emitChange(valueRef.current + dir * fineStep);
      } else {
        nudge(dir);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [emitChange, nudge, step]);

  const onKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      nudge(1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      nudge(-1);
    }
  }, [nudge]);

  const handleInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    
    // Clear any existing error timeout
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    
    // Allow empty string for clearing
    if (newValue === '') {
      setInputValue('');
      setShowError(false);
      return;
    }
    
    // Parse and validate
    const parsed = parseInt(newValue, 10);
    if (!isNaN(parsed)) {
      // If above max, force to max and show error indicator
      if (parsed > max) {
        setInputValue(String(max));
        emitChange(max);
        setShowError(true);
        // Clear error after 1 second
        errorTimeoutRef.current = setTimeout(() => {
          setShowError(false);
          errorTimeoutRef.current = null;
        }, 1000);
      } else {
        setInputValue(newValue);
        emitChange(parsed);
        setShowError(false);
      }
    }
  }, [emitChange, max]);

  const handleInputBlur = React.useCallback(() => {
    // On blur, ensure we have a valid value
    if (inputValue === '' || isNaN(parseInt(inputValue, 10))) {
      setInputValue(String(Math.round(value)));
    }
  }, [inputValue, value]);

  const handleInputKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }, []);

  const thumbColor = crossSectionEnabled ? 'var(--accent)' : 'var(--text-muted)';
  const percent = Math.min(100, Math.max(0, ((value - min) / Math.max(1, (max - min))) * 100));
  const lowerPercent = lowerValue != null
    ? Math.min(100, Math.max(0, ((lowerValue - min) / Math.max(1, (max - min))) * 100))
    : null;
  const EDGE_BADGE_HIDE_EPS = 1e-6;
  const hideUpperFloatingBadge = percent <= EDGE_BADGE_HIDE_EPS || percent >= (100 - EDGE_BADGE_HIDE_EPS);
  const hideLowerFloatingBadge = lowerPercent != null
    ? (lowerPercent <= EDGE_BADGE_HIDE_EPS || lowerPercent >= (100 - EDGE_BADGE_HIDE_EPS))
    : false;
  const railBadgeClass = 'inline-flex items-center rounded-md border px-1 py-0.5 text-[9px] font-semibold tabular-nums';
  const railBadgeStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 15%)',
    background: 'color-mix(in srgb, var(--surface-1), transparent 10%)',
  };
  const railCurrentBadgeStyle: React.CSSProperties = {
    color: 'var(--text-strong)',
    borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 10%)',
    background: 'color-mix(in srgb, var(--surface-1), transparent 4%)',
  };
  const shouldPlaceCurrentBadgeBelowThumb = isMinimalRail && percent >= 96;

  return (
    <div
      data-no-drag="true"
      className={
        docked
          ? `relative z-10 select-none ${className ?? ''}`
          : `absolute right-3 top-1/2 -translate-y-1/2 z-10 select-none ${className ?? ''}`
      }
    >
      <div
        className={embedded
          ? `${expandToContainer ? 'h-full min-h-0 flex flex-col' : ''} w-full rounded-lg ${isMinimalRail ? 'px-0 py-1.5' : 'px-1 py-1'}`
          : 'ui-panel w-44 rounded-lg px-2.5 py-2.5 shadow-lg'}
        style={embedded
          ? undefined
          : {
              background: 'color-mix(in srgb, var(--surface-0), transparent 10%)',
              borderColor: 'var(--border-subtle)',
            }
        }
      >
        {!isMinimalRail && (
          <div className={embedded ? 'mb-1.5' : 'mb-2'}>
            <div className="flex items-center justify-between">
              <div className={`${embedded ? 'text-[10px]' : 'text-[11px]'} font-semibold uppercase tracking-wide`} style={{ color: 'var(--text-muted)' }}>
                Layer
              </div>
              <div className="text-xs font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                {value}
              </div>
            </div>

            <div className="mt-0.5 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums"
              style={{
                color: 'var(--text-muted)',
                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 25%)',
                background: 'color-mix(in srgb, var(--surface-1), transparent 12%)',
              }}
            >
              {typeof currentHeightMm === 'number' ? `${formatMm(currentHeightMm)} mm` : 'ΓÇö'}
            </div>
            {typeof maxHeightMm === 'number' && !embedded && (
              <div className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                Max {formatMm(maxHeightMm)} mm
              </div>
            )}
          </div>
        )}

        {isMinimalRail && (
          <div className="flex items-center justify-center mb-1">
            <div className={railBadgeClass} style={railBadgeStyle}>
              {max}
            </div>
          </div>
        )}

        <div
          data-no-drag="true"
          className={`relative mx-auto ${embedded ? (expandToContainer ? (isMinimalRail ? 'flex-1 h-full min-h-[300px]' : 'flex-1 h-full min-h-[300px]') : 'h-[46vh]') : 'h-[56vh]'} ${embedded ? (isMinimalRail ? 'w-5' : 'w-7') : 'w-10'} cursor-pointer`}
          onMouseDown={onPointerDown}
          onDoubleClick={(e) => {
            if (!onToggleCrossSection) return;
            e.preventDefault();
            e.stopPropagation();
            onToggleCrossSection();
          }}
          onContextMenu={(e) => {
            if (!onCrossSectionModeChange) return;
            e.preventDefault();
            e.stopPropagation();
            onCrossSectionModeChange(crossSectionMode === 'smooth' ? 'rasterized' : 'smooth');
          }}
          tabIndex={0}
          onKeyDown={onKeyDown}
          title={isMinimalRail
            ? `Layer ${value} ΓÇó ${typeof currentHeightMm === 'number' ? `${formatMm(currentHeightMm)} mm` : 'ΓÇö'} ΓÇó Right-click to toggle ${crossSectionMode === 'smooth' ? 'rasterized' : 'smooth'}`
            : undefined}
        >
          {!isMinimalRail && (
            <div
              className="absolute left-1/2 -translate-x-1/2 -top-5 text-[10px] tabular-nums"
              style={{ color: 'var(--text-muted)' }}
            >
              {max}
            </div>
          )}

          <div
            ref={containerRef}
            data-no-drag="true"
            className={isMinimalRail
              ? 'absolute left-0 right-0 top-0 bottom-0'
              : 'absolute left-0 right-0 top-0 bottom-0'}
          >

            {/* Track */}
            <div
              className="absolute left-1/2 top-0 h-full w-1.5 -translate-x-1/2 rounded-full"
              style={{
                background: 'color-mix(in srgb, var(--surface-2), black 8%)',
                border: '1px solid color-mix(in srgb, var(--border-subtle), transparent 40%)',
              }}
            />

            {/* Progress fill */}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-1.5 rounded-full transition-[background,box-shadow] duration-200"
              style={{
                bottom: `${lowerPercent ?? 0}%`,
                height: `${percent - (lowerPercent ?? 0)}%`,
                background: crossSectionEnabled
                  ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent), white 14%), var(--accent))'
                  : 'linear-gradient(180deg, color-mix(in srgb, var(--text-muted), white 10%), var(--text-muted))',
                boxShadow: crossSectionEnabled
                  ? '0 0 10px color-mix(in srgb, var(--accent), transparent 65%)'
                  : 'none',
                opacity: crossSectionEnabled ? 1 : 0.45,
              }}
            />

            {/* Lower thumb */}
            {lowerPercent != null && (
              <div
                className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{
                  top: `${100 - lowerPercent}%`,
                  transition: isDraggingThumb ? 'none' : 'top 170ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                <div className="relative">
                  {showValue && typeof lowerCurrentHeightMm === 'number' && !hideLowerFloatingBadge && (
                    <div
                      className={isMinimalRail
                        ? `absolute left-1/2 -translate-x-1/2 whitespace-nowrap ${railBadgeClass} pointer-events-none top-3`
                        : 'absolute right-full mr-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] shadow tabular-nums pointer-events-none'}
                      style={isMinimalRail
                        ? railCurrentBadgeStyle
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-0), transparent 12%)',
                            color: 'var(--text-strong)',
                          }}
                    >
                      {isMinimalRail ? `${lowerValue}` : `${formatMm(lowerCurrentHeightMm)} mm`}
                    </div>
                  )}
                  {crossSectionMode === 'rasterized' ? (
                    <div
                      className={`h-[9px] w-[24px] rounded-[3px] border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-[transform,background,box-shadow] duration-150`}
                      style={{
                        borderColor: `color-mix(in srgb, white, ${thumbColor} 20%)`,
                        background: `repeating-linear-gradient(90deg, color-mix(in srgb, ${thumbColor}, white 8%) 0 4px, color-mix(in srgb, ${thumbColor}, black 8%) 4px 8px)`,
                        boxShadow: isDraggingThumb
                          ? `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 65%), 0 6px 14px rgba(0,0,0,0.38)`
                          : `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 80%), 0 4px 10px rgba(0,0,0,0.35)`,
                        opacity: 0.75,
                      }}
                    />
                  ) : (
                    <div
                      className={`h-[9px] w-[24px] rounded-full border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-[transform,background,box-shadow] duration-150`}
                      style={{
                        borderColor: `color-mix(in srgb, white, ${thumbColor} 20%)`,
                        background: `linear-gradient(90deg, color-mix(in srgb, ${thumbColor}, white 20%), ${thumbColor}, color-mix(in srgb, ${thumbColor}, white 20%))`,
                        boxShadow: isDraggingThumb
                          ? `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 65%), 0 6px 14px rgba(0,0,0,0.38)`
                          : `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 80%), 0 4px 10px rgba(0,0,0,0.35)`,
                        opacity: 0.75,
                      }}
                    />
                  )}
                  {/* Lower thumb edit popover */}
                  {editingThumb === 'lower' && (
                    <div
                      ref={editPopoverRef}
                      className="absolute right-full top-1/2 -translate-y-1/2 z-[200] flex flex-col gap-1.5 rounded-lg border p-2"
                      style={{
                        marginRight: '10px',
                        minWidth: '136px',
                        background: 'var(--surface-0)',
                        borderColor: 'var(--border-subtle)',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                      }}
                      onMouseDown={e => e.stopPropagation()}
                      onPointerDown={e => e.stopPropagation()}
                    >
                      {layerHeightMm && layerHeightMm > 0 && (
                        <div className="flex gap-1">
                          <button
                            className="flex-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                            style={editMode === 'layer'
                              ? { background: 'var(--secondary-button-surface)', color: 'var(--accent-secondary-contrast)' }
                              : { background: 'color-mix(in srgb, var(--surface-2), transparent 20%)', color: 'var(--text-muted)' }}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => switchEditMode('layer')}
                          >Layer #</button>
                          <button
                            className="flex-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                            style={editMode === 'mm'
                              ? { background: 'var(--secondary-button-surface)', color: 'var(--accent-secondary-contrast)' }
                              : { background: 'color-mix(in srgb, var(--surface-2), transparent 20%)', color: 'var(--text-muted)' }}
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => switchEditMode('mm')}
                          >mm</button>
                        </div>
                      )}
                      <input
                        ref={editInputRef}
                        type="text"
                        inputMode="decimal"
                        value={editRawValue}
                        onChange={e => setEditRawValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitThumbEdit(); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingThumb(null); }
                          e.stopPropagation();
                        }}
                        onBlur={commitThumbEdit}
                        className="w-full rounded border px-1.5 py-1 text-center text-[11px] tabular-nums focus:outline-none selection:bg-transparent selection:text-[var(--accent)]"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), transparent 10%)',
                          color: 'var(--text-strong)',
                        }}
                        placeholder={editMode === 'layer' ? 'Layer #' : 'Height mm'}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Upper thumb */}
            <div
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{
                top: `${100 - percent}%`,
                transition: isDraggingThumb ? 'none' : 'top 170ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <div className="relative">
                {showValue && typeof currentHeightMm === 'number' && !hideUpperFloatingBadge && (
                  <div
                    className={isMinimalRail
                      ? `absolute left-1/2 -translate-x-1/2 whitespace-nowrap ${railBadgeClass} pointer-events-none ${shouldPlaceCurrentBadgeBelowThumb ? 'top-3' : '-top-5'}`
                      : 'absolute left-full ml-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] shadow tabular-nums pointer-events-none'}
                    style={isMinimalRail
                      ? railCurrentBadgeStyle
                      : {
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-0), transparent 12%)',
                          color: 'var(--text-strong)',
                        }}
                  >
                    {isMinimalRail
                      ? `${value}`
                      : `${formatMm(currentHeightMm)} mm`}
                  </div>
                )}
            {crossSectionMode === 'rasterized' ? (
              <div
                className={`h-[9px] w-[24px] rounded-[3px] border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-[transform,background,box-shadow] duration-150`}
                style={{
                  borderColor: `color-mix(in srgb, white, ${thumbColor} 20%)`,
                  background: `repeating-linear-gradient(90deg, color-mix(in srgb, ${thumbColor}, white 8%) 0 4px, color-mix(in srgb, ${thumbColor}, black 8%) 4px 8px)`,
                  boxShadow: isDraggingThumb
                    ? `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 65%), 0 6px 14px rgba(0,0,0,0.38)`
                    : `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 80%), 0 4px 10px rgba(0,0,0,0.35)`,
                }}
              />
            ) : (
              <div
                className={`h-[9px] w-[24px] rounded-full border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-[transform,background,box-shadow] duration-150`}
                style={{
                  borderColor: `color-mix(in srgb, white, ${thumbColor} 20%)`,
                  background: `linear-gradient(90deg, color-mix(in srgb, ${thumbColor}, white 20%), ${thumbColor}, color-mix(in srgb, ${thumbColor}, white 20%))`,
                  boxShadow: isDraggingThumb
                    ? `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 65%), 0 6px 14px rgba(0,0,0,0.38)`
                    : `0 0 0 2px color-mix(in srgb, ${thumbColor}, transparent 80%), 0 4px 10px rgba(0,0,0,0.35)`,
                }}
              />
            )}
            
            {/* Upper thumb edit popover */}
            {editingThumb === 'upper' && (
              <div
                ref={editPopoverRef}
                className="absolute right-full top-1/2 -translate-y-1/2 z-[200] flex flex-col gap-1.5 rounded-lg border p-2"
                style={{
                  marginRight: '10px',
                  minWidth: '136px',
                  background: 'var(--surface-0)',
                  borderColor: 'var(--border-subtle)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                }}
                onMouseDown={e => e.stopPropagation()}
                onPointerDown={e => e.stopPropagation()}
              >
                {layerHeightMm && layerHeightMm > 0 && (
                  <div className="flex gap-1">
                    <button
                      className="flex-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                      style={editMode === 'layer'
                        ? { background: 'var(--secondary-button-surface)', color: 'var(--accent-secondary-contrast)' }
                        : { background: 'color-mix(in srgb, var(--surface-2), transparent 20%)', color: 'var(--text-muted)' }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => switchEditMode('layer')}
                    >Layer #</button>
                    <button
                      className="flex-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                      style={editMode === 'mm'
                        ? { background: 'var(--secondary-button-surface)', color: 'var(--accent-secondary-contrast)' }
                        : { background: 'color-mix(in srgb, var(--surface-2), transparent 20%)', color: 'var(--text-muted)' }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => switchEditMode('mm')}
                    >mm</button>
                  </div>
                )}
                <input
                  ref={editInputRef}
                  type="text"
                  inputMode="decimal"
                  value={editRawValue}
                  onChange={e => setEditRawValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitThumbEdit(); }
                    if (e.key === 'Escape') { e.preventDefault(); setEditingThumb(null); }
                    e.stopPropagation();
                  }}
                  onBlur={commitThumbEdit}
                  className="w-full rounded border px-1.5 py-1 text-center text-[11px] tabular-nums focus:outline-none selection:bg-transparent selection:text-[var(--accent)]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), transparent 10%)',
                    color: 'var(--text-strong)',
                  }}
                  placeholder={editMode === 'layer' ? 'Layer #' : 'Height mm'}
                />
              </div>
            )}

            {/* Shift indicator - wifi-style precision arcs centered on thumb */}
            {isShiftHeld && (
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
                {crossSectionMode === 'rasterized' ? (
                  // Pixelated arcs for raster mode - 7px gap, cleaner circular shape
                  <svg width="72" height="72" viewBox="0 0 72 72" className="drop-shadow-lg">
                    {/* Outer arc - radius ~24px with 7px gap (14 + 7 + ~3) */}
                    <rect x="12" y="22" width="2" height="2" fill="#3b82f6" />
                    <rect x="10" y="24" width="2" height="2" fill="#3b82f6" />
                    <rect x="8" y="26" width="2" height="2" fill="#3b82f6" />
                    <rect x="6" y="28" width="2" height="2" fill="#3b82f6" />
                    <rect x="4" y="30" width="2" height="2" fill="#3b82f6" />
                    <rect x="4" y="32" width="2" height="2" fill="#3b82f6" />
                    <rect x="2" y="34" width="2" height="2" fill="#3b82f6" />
                    <rect x="2" y="36" width="2" height="2" fill="#3b82f6" />
                    <rect x="4" y="38" width="2" height="2" fill="#3b82f6" />
                    <rect x="4" y="40" width="2" height="2" fill="#3b82f6" />
                    <rect x="6" y="42" width="2" height="2" fill="#3b82f6" />
                    <rect x="8" y="44" width="2" height="2" fill="#3b82f6" />
                    <rect x="10" y="46" width="2" height="2" fill="#3b82f6" />
                    <rect x="12" y="48" width="2" height="2" fill="#3b82f6" />
                    
                    {/* Inner arc - radius ~17px with 7px gap (14 + 7 - 4) */}
                    <rect x="18" y="26" width="2" height="2" fill="#3b82f6" />
                    <rect x="16" y="28" width="2" height="2" fill="#3b82f6" />
                    <rect x="14" y="30" width="2" height="2" fill="#3b82f6" />
                    <rect x="14" y="32" width="2" height="2" fill="#3b82f6" />
                    <rect x="12" y="34" width="2" height="2" fill="#3b82f6" />
                    <rect x="12" y="36" width="2" height="2" fill="#3b82f6" />
                    <rect x="14" y="38" width="2" height="2" fill="#3b82f6" />
                    <rect x="14" y="40" width="2" height="2" fill="#3b82f6" />
                    <rect x="16" y="42" width="2" height="2" fill="#3b82f6" />
                    <rect x="18" y="44" width="2" height="2" fill="#3b82f6" />
                  </svg>
                ) : (
                  // Smooth arcs for normal mode - 7px gap, shorter arcs
                  <svg width="52" height="52" viewBox="0 0 52 52" className="drop-shadow-lg">
                    {/* Outer arc - radius 24px with 7px gap (10 + 7 + 7 spacing) */}
                    <path
                      d="M 9.5 14.5 A 24 24 0 0 0 2 26"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 9.5 37.5 A 24 24 0 0 1 2 26"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    
                    {/* Inner arc - radius 17px with 7px gap (10 + 7) */}
                    <path
                      d="M 14.0 17.0 A 17 17 0 0 0 9 26"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 14.0 35.0 A 17 17 0 0 1 9 26"
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </div>
            )}
              </div>
            </div>
          </div>
        </div>

        {!isMinimalRail && (
          <div className="mt-1 text-center text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {min}
          </div>
        )}

        {isMinimalRail && (
          <div className="mt-1 flex items-center justify-center gap-1.5">
            <div
              className={railBadgeClass}
              style={railBadgeStyle}
            >
              {min}
            </div>
            {showModeIndicator && (
              <div
                className={railBadgeClass}
                style={railBadgeStyle}
                title={`Current cross-section mode: ${crossSectionMode}. Right-click slider to toggle.`}
              >
                {crossSectionMode === 'smooth' ? 'S' : 'R'}
              </div>
            )}
          </div>
        )}

        {/* Static input field below slider */}
        {showValue && !isMinimalRail && (
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleInputKeyDown}
            className="mt-2 w-full rounded border px-1.5 py-1 text-center text-xs shadow tabular-nums focus:outline-none transition-colors"
            style={showError
              ? { borderColor: '#ef4444', background: 'rgba(127, 29, 29, 0.5)', color: '#fecaca' }
              : { borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 10%)', color: 'var(--text-strong)' }
            }
          />
        )}
      </div>
    </div>
  );
}
