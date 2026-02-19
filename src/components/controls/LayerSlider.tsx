"use client";

import React from 'react';

type LayerSliderProps = {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  onCrossSectionModeChange?: (mode: 'smooth' | 'rasterized') => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  className?: string;
  showValue?: boolean;
  crossSectionMode?: 'smooth' | 'rasterized';
  docked?: boolean;
  embedded?: boolean;
  expandToContainer?: boolean;
};

export function LayerSlider({ min, max, step, value, onChange, onCrossSectionModeChange, currentHeightMm, maxHeightMm, className, showValue = false, crossSectionMode = 'smooth', docked = false, embedded = false, expandToContainer = false }: LayerSliderProps) {
  const isMinimalRail = embedded && docked;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const errorTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const [inputValue, setInputValue] = React.useState(String(Math.round(value)));
  const [showError, setShowError] = React.useState(false);
  const [isShiftHeld, setIsShiftHeld] = React.useState(false);
  const [isDraggingThumb, setIsDraggingThumb] = React.useState(false);
  const dragShiftModeRef = React.useRef<boolean>(false); // Lock shift mode for entire drag

  const formatMm = React.useCallback((mm: number) => {
    if (!Number.isFinite(mm)) return '0';
    return mm.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }, []);

  // Update input value when slider value changes externally
  React.useEffect(() => {
    const roundedValue = String(Math.round(value));
    // Only update if the value actually changed
    if (inputValue !== roundedValue) {
      setInputValue(roundedValue);
    }
  }, [value, inputValue]);

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

  const setByClientY = React.useCallback((clientY: number, shiftKey: boolean = false) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientY - rect.top) / rect.height; // 0 at top, 1 at bottom
    const inv = 1 - rel; // 0 bottom, 1 top -> we want 0..1 bottom->top
    
    if (shiftKey) {
      // Fine-grained control: reduce sensitivity by 10x
      const currentPercent = (value - min) / (max - min);
      const delta = (inv - currentPercent) * 0.1; // 10x slower movement
      const newPercent = currentPercent + delta;
      const v = min + newPercent * (max - min);
      onChange(clamp(snap(v)));
    } else {
      // Normal control
      const v = min + inv * (max - min);
      onChange(clamp(snap(v)));
    }
  }, [min, max, value, clamp, snap, onChange]);

  const onPointerDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Start with current shift state
    setIsDraggingThumb(true);
    dragShiftModeRef.current = e.shiftKey;
    setIsShiftHeld(e.shiftKey);
    setByClientY(e.clientY, e.shiftKey);
    
    const onMove = (ev: MouseEvent) => {
      // Allow shift to be turned ON during drag, but once on it stays on
      if (ev.shiftKey && !dragShiftModeRef.current) {
        dragShiftModeRef.current = true;
        setIsShiftHeld(true);
      }
      setByClientY(ev.clientY, dragShiftModeRef.current);
    };
    const onUp = () => {
      // Only reset on mouse up
      setIsDraggingThumb(false);
      dragShiftModeRef.current = false;
      setIsShiftHeld(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setByClientY]);

  const nudge = React.useCallback((dir: 1 | -1) => {
    const s = step || 1;
    const next = clamp(value + dir * s);
    onChange(snap(next));
  }, [value, step, clamp, snap, onChange]);

  // Use native wheel event listener with passive: false to allow preventDefault
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir: 1 | -1 = e.deltaY > 0 ? 1 : -1;
      
      if (e.shiftKey) {
        // Fine-grained control: move by 0.1 steps
        const fineStep = (step || 1) * 0.1;
        const next = clamp(value + dir * fineStep);
        onChange(snap(next));
      } else {
        nudge(dir);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [nudge, step, value, clamp, snap, onChange]);

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
        onChange(clamp(snap(max)));
        setShowError(true);
        // Clear error after 1 second
        errorTimeoutRef.current = setTimeout(() => {
          setShowError(false);
          errorTimeoutRef.current = null;
        }, 1000);
      } else {
        setInputValue(newValue);
        onChange(clamp(snap(parsed)));
        setShowError(false);
      }
    }
  }, [max, clamp, snap, onChange]);

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

  const percent = Math.min(100, Math.max(0, ((value - min) / Math.max(1, (max - min))) * 100));
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
              {typeof currentHeightMm === 'number' ? `${formatMm(currentHeightMm)} mm` : '—'}
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
          onContextMenu={(e) => {
            if (!onCrossSectionModeChange) return;
            e.preventDefault();
            e.stopPropagation();
            onCrossSectionModeChange(crossSectionMode === 'smooth' ? 'rasterized' : 'smooth');
          }}
          tabIndex={0}
          onKeyDown={onKeyDown}
          title={isMinimalRail
            ? `Layer ${value} • ${typeof currentHeightMm === 'number' ? `${formatMm(currentHeightMm)} mm` : '—'} • Right-click to toggle ${crossSectionMode === 'smooth' ? 'rasterized' : 'smooth'}`
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
              className="absolute left-1/2 -translate-x-1/2 bottom-0 w-1.5 rounded-full"
              style={{
                height: `${percent}%`,
                background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent), white 14%), var(--accent))',
                boxShadow: '0 0 10px color-mix(in srgb, var(--accent), transparent 65%)',
              }}
            />

            {/* Thumb */}
            <div
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{
                top: `${100 - percent}%`,
                transition: isDraggingThumb ? 'none' : 'top 170ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <div className="relative">
                {showValue && typeof currentHeightMm === 'number' && (
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
                className={`h-[9px] w-[24px] rounded-[3px] border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-transform duration-150`}
                style={{
                  borderColor: 'color-mix(in srgb, white, var(--accent) 20%)',
                  background: 'repeating-linear-gradient(90deg, color-mix(in srgb, var(--accent), white 8%) 0 4px, color-mix(in srgb, var(--accent), black 8%) 4px 8px)',
                  boxShadow: isDraggingThumb
                    ? '0 0 0 2px color-mix(in srgb, var(--accent), transparent 65%), 0 6px 14px rgba(0,0,0,0.38)'
                    : '0 0 0 2px color-mix(in srgb, var(--accent), transparent 80%), 0 4px 10px rgba(0,0,0,0.35)',
                }}
              />
            ) : (
              <div
                className={`h-[9px] w-[24px] rounded-full border ${isDraggingThumb ? 'scale-105' : 'scale-100'} transition-transform duration-150`}
                style={{
                  borderColor: 'color-mix(in srgb, white, var(--accent) 20%)',
                  background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent), white 20%), var(--accent), color-mix(in srgb, var(--accent), white 20%))',
                  boxShadow: isDraggingThumb
                    ? '0 0 0 2px color-mix(in srgb, var(--accent), transparent 65%), 0 6px 14px rgba(0,0,0,0.38)'
                    : '0 0 0 2px color-mix(in srgb, var(--accent), transparent 80%), 0 4px 10px rgba(0,0,0,0.35)',
                }}
              />
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
            <div
              className={railBadgeClass}
              style={railBadgeStyle}
              title={`Current cross-section mode: ${crossSectionMode}. Right-click slider to toggle.`}
            >
              {crossSectionMode === 'smooth' ? 'S' : 'R'}
            </div>
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
