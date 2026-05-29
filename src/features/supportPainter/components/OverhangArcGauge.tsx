import React, { useRef, useState } from 'react';

interface OverhangArcGaugeProps {
  valueMin: number; // e.g. 0
  valueMax: number; // e.g. 45
  onChange: (min: number, max: number) => void;
  snapIncrement?: number; // e.g. 5
}

export function OverhangArcGauge({
  valueMin,
  valueMax,
  onChange,
  snapIncrement = 5,
}: OverhangArcGaugeProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [activeHandle, setActiveHandle] = useState<'min' | 'max' | null>(null);

  const cx = 50;
  const cy = 80;
  const R = 32;

  // Convert slope degree (0° = vertical 12 o'clock, 90° = horizontal 3 o'clock)
  // to SVG coordinates centered at (cx, cy)
  const getCoords = (slope: number) => {
    const rad = (slope - 90) * (Math.PI / 180);
    return {
      x: cx + R * Math.cos(rad),
      y: cy + R * Math.sin(rad),
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!svgRef.current) return;
    svgRef.current.setPointerCapture(e.pointerId);

    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Convert pixel coordinates back to viewbox coordinates
    const vx = (px / rect.width) * 100;
    const vy = (py / rect.height) * 100;

    // Determine which handle is closer in Euclidean distance
    const minCoords = getCoords(valueMin);
    const maxCoords = getCoords(valueMax);

    const distMin = Math.hypot(vx - minCoords.x, vy - minCoords.y);
    const distMax = Math.hypot(vx - maxCoords.x, vy - maxCoords.y);

    const handle = distMin < distMax ? 'min' : 'max';
    setActiveHandle(handle);

    // Run first move
    updateAngle(vx, vy, handle);
  };

  const updateAngle = (vx: number, vy: number, handle: 'min' | 'max') => {
    // Math.atan2 relative to (cx, cy)
    const rad = Math.atan2(vy - cy, vx - cx);
    let slope = rad * (180 / Math.PI) + 90; // 0 to 180

    // Clamp slope to quadrant (0 to 90)
    slope = Math.min(90, Math.max(0, slope));

    if (snapIncrement > 0) {
      slope = Math.round(slope / snapIncrement) * snapIncrement;
    }

    if (handle === 'min') {
      const nextMin = Math.min(slope, valueMax);
      onChange(nextMin, valueMax);
    } else {
      const nextMax = Math.max(slope, valueMin);
      onChange(valueMin, nextMax);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!activeHandle || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const vx = (px / rect.width) * 100;
    const vy = (py / rect.height) * 100;

    updateAngle(vx, vy, activeHandle);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (svgRef.current) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    setActiveHandle(null);
  };

  const minPos = getCoords(valueMin);
  const maxPos = getCoords(valueMax);
  const startArc = getCoords(0);
  const midArc = getCoords(45);
  const endArc = getCoords(90);

  // Active selection arc path
  let activeArcPath = '';
  if (valueMax > valueMin) {
    activeArcPath = `M ${minPos.x} ${minPos.y} A ${R} ${R} 0 0 1 ${maxPos.x} ${maxPos.y}`;
  }

  return (
    <div className="flex flex-col items-center gap-1 text-xs select-none">
      <span className="font-semibold" style={{ color: 'var(--text-strong, #f3f4f6)' }}>
        Overhang Slope Limit
      </span>
      <span className="text-[10px]" style={{ color: 'var(--text-muted, #9ca3af)' }}>
        Z-Slope: {valueMin.toFixed(0)}° to {valueMax.toFixed(0)}°
      </span>

      <svg
        ref={svgRef}
        width="110"
        height="110"
        viewBox="0 0 100 100"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="cursor-crosshair overflow-visible touch-none"
        style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.3))' }}
      >
        {/* Semi-circular dial bounds backing */}
        <path
          d={`M ${startArc.x} ${startArc.y} A ${R} ${R} 0 0 1 ${endArc.x} ${endArc.y}`}
          stroke="var(--border-subtle, #374151)"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
        />

        {/* Stable Overhang range colored Green */}
        <path
          d={`M ${startArc.x} ${startArc.y} A ${R} ${R} 0 0 1 ${midArc.x} ${midArc.y}`}
          stroke="rgba(16, 185, 129, 0.45)"
          strokeWidth="3.5"
          fill="none"
        />

        {/* Critical Overhang range colored Amber */}
        <path
          d={`M ${midArc.x} ${midArc.y} A ${R} ${R} 0 0 1 ${endArc.x} ${endArc.y}`}
          stroke="rgba(245, 158, 11, 0.45)"
          strokeWidth="3.5"
          fill="none"
          strokeLinecap="round"
        />

        {/* Active Selected Arc in overlay accent */}
        {activeArcPath && (
          <path
            d={activeArcPath}
            stroke="var(--accent, #4a90e2)"
            strokeWidth="5"
            fill="none"
            className="transition-all duration-100 ease-out"
          />
        )}

        {/* Center angle guidelines */}
        <line x1={cx} y1={cy} x2={startArc.x} y2={startArc.y} stroke="var(--border-subtle, #374151)" strokeWidth="0.5" strokeDasharray="1 3" />
        <line x1={cx} y1={cy} x2={midArc.x} y2={midArc.y} stroke="var(--border-subtle, #374151)" strokeWidth="0.5" strokeDasharray="1 3" />
        <line x1={cx} y1={cy} x2={endArc.x} y2={endArc.y} stroke="var(--border-subtle, #374151)" strokeWidth="0.5" strokeDasharray="1 3" />

        {/* 0, 45, 90 labels */}
        <text x={startArc.x} y={startArc.y - 4} fontSize="6.5" fill="var(--text-muted, #9ca3af)" textAnchor="middle" fontWeight="bold">0°</text>
        <text x={midArc.x + 4} y={midArc.y - 4} fontSize="6.5" fill="var(--text-muted, #9ca3af)" textAnchor="start" fontWeight="bold">45°</text>
        <text x={endArc.x + 5} y={endArc.y + 2} fontSize="6.5" fill="var(--text-muted, #9ca3af)" textAnchor="start" fontWeight="bold">90°</text>

        {/* Draggable Anchors */}
        {/* Min Anchor */}
        <circle
          cx={minPos.x}
          cy={minPos.y}
          r="4.5"
          fill="var(--surface-0, #111827)"
          stroke="var(--accent, #4a90e2)"
          strokeWidth="2.5"
          style={{ cursor: 'grab' }}
        />

        {/* Max Anchor */}
        <circle
          cx={maxPos.x}
          cy={maxPos.y}
          r="4.5"
          fill="var(--surface-0, #111827)"
          stroke="var(--accent, #4a90e2)"
          strokeWidth="2.5"
          style={{ cursor: 'grab' }}
        />

        {/* Origin base pivot */}
        <circle cx={cx} cy={cy} r="2" fill="var(--border-subtle, #374151)" />
      </svg>
    </div>
  );
}
