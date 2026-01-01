"use client";

import React from 'react';

type LayerSliderProps = {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  className?: string;
  showValue?: boolean;
  onToggleMode?: () => void;
  crossSectionMode?: 'smooth' | 'rasterized';
  docked?: boolean;
};

export function LayerSlider({ min, max, step, value, onChange, className, showValue = false, onToggleMode, crossSectionMode = 'smooth', docked = false }: LayerSliderProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const errorTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const [inputValue, setInputValue] = React.useState(String(Math.round(value)));
  const [showError, setShowError] = React.useState(false);
  const [isShiftHeld, setIsShiftHeld] = React.useState(false);
  const dragShiftModeRef = React.useRef<boolean>(false); // Lock shift mode for entire drag

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
    // Start with current shift state
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

  return (
    <div
      className={
        docked
          ? `relative z-10 select-none ${className ?? ''}`
          : `absolute right-3 top-1/2 -translate-y-1/2 z-10 select-none ${className ?? ''}`
      }
    >
      {/* Max layer label above slider */}
      {showValue && (
        <div className="absolute left-1/2 -translate-x-1/2 top-0 -mt-10 w-12 rounded border border-neutral-600 bg-neutral-800/90 px-1 py-0.5 text-center text-xs text-neutral-400 shadow tabular-nums">
          {max}
        </div>
      )}
      
      <div
        ref={containerRef}
        className="relative h-[70vh] w-8 cursor-pointer"
        onMouseDown={onPointerDown}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {/* Track */}
        <div className="absolute left-1/2 top-0 h-full w-2 -translate-x-1/2 rounded-full bg-neutral-500" />
        {/* Thumb */}
        <div
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ top: `${100 - percent}%` }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onToggleMode) {
              onToggleMode();
            }
          }}
        >
          <div className="relative">
            {crossSectionMode === 'rasterized' ? (
              // Pixelated thumb for raster mode - bigger with chunkier pixels
              <svg width="28" height="28" viewBox="0 0 28 28" className="cursor-context-menu drop-shadow-lg">
                {/* Top row */}
                <rect x="9" y="3" width="3" height="3" fill="white" />
                <rect x="12" y="3" width="3" height="3" fill="white" />
                <rect x="15" y="3" width="3" height="3" fill="white" />
                
                {/* Second row */}
                <rect x="6" y="6" width="3" height="3" fill="white" />
                <rect x="9" y="6" width="3" height="3" fill="#d4d4d4" />
                <rect x="12" y="6" width="3" height="3" fill="#d4d4d4" />
                <rect x="15" y="6" width="3" height="3" fill="#d4d4d4" />
                <rect x="18" y="6" width="3" height="3" fill="white" />
                
                {/* Third row */}
                <rect x="3" y="9" width="3" height="3" fill="white" />
                <rect x="6" y="9" width="3" height="3" fill="#d4d4d4" />
                <rect x="9" y="9" width="3" height="3" fill="#d4d4d4" />
                <rect x="12" y="9" width="3" height="3" fill="#d4d4d4" />
                <rect x="15" y="9" width="3" height="3" fill="#d4d4d4" />
                <rect x="18" y="9" width="3" height="3" fill="#d4d4d4" />
                <rect x="21" y="9" width="3" height="3" fill="white" />
                
                {/* Middle row */}
                <rect x="3" y="12" width="3" height="3" fill="white" />
                <rect x="6" y="12" width="3" height="3" fill="#d4d4d4" />
                <rect x="9" y="12" width="3" height="3" fill="#d4d4d4" />
                <rect x="12" y="12" width="3" height="3" fill="#d4d4d4" />
                <rect x="15" y="12" width="3" height="3" fill="#d4d4d4" />
                <rect x="18" y="12" width="3" height="3" fill="#d4d4d4" />
                <rect x="21" y="12" width="3" height="3" fill="white" />
                
                {/* Fifth row */}
                <rect x="3" y="15" width="3" height="3" fill="white" />
                <rect x="6" y="15" width="3" height="3" fill="#d4d4d4" />
                <rect x="9" y="15" width="3" height="3" fill="#d4d4d4" />
                <rect x="12" y="15" width="3" height="3" fill="#d4d4d4" />
                <rect x="15" y="15" width="3" height="3" fill="#d4d4d4" />
                <rect x="18" y="15" width="3" height="3" fill="#d4d4d4" />
                <rect x="21" y="15" width="3" height="3" fill="white" />
                
                {/* Sixth row */}
                <rect x="6" y="18" width="3" height="3" fill="white" />
                <rect x="9" y="18" width="3" height="3" fill="#d4d4d4" />
                <rect x="12" y="18" width="3" height="3" fill="#d4d4d4" />
                <rect x="15" y="18" width="3" height="3" fill="#d4d4d4" />
                <rect x="18" y="18" width="3" height="3" fill="white" />
                
                {/* Bottom row */}
                <rect x="9" y="21" width="3" height="3" fill="white" />
                <rect x="12" y="21" width="3" height="3" fill="white" />
                <rect x="15" y="21" width="3" height="3" fill="white" />
              </svg>
            ) : (
              // Smooth thumb for normal mode
              <div className="h-5 w-5 rounded-full border-2 border-white bg-neutral-200 shadow cursor-context-menu" />
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
      {/* Static input field below slider */}
      {showValue && (
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          className={`absolute left-1/2 -translate-x-1/2 bottom-0 -mb-10 w-12 rounded border px-1 py-0.5 text-center text-xs shadow tabular-nums focus:outline-none transition-colors ${
            showError 
              ? 'border-red-500 bg-red-900/50 text-red-200' 
              : 'border-neutral-400 bg-neutral-900/90 text-neutral-200 focus:border-blue-500'
          }`}
        />
      )}
    </div>
  );
}
