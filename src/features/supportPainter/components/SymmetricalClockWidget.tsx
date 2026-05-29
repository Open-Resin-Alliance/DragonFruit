import React, { useRef, useState, useEffect } from 'react';

interface SymmetricalClockWidgetProps {
  valueMin: number; // e.g. -30
  valueMax: number; // e.g. 30
  onChange: (min: number, max: number) => void;
  snapIncrement?: number; // e.g. 15
}

export function SymmetricalClockWidget({
  valueMin,
  valueMax,
  onChange,
  snapIncrement = 15,
}: SymmetricalClockWidgetProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // We enforce symmetry: halfAngle = absolute angle from vertical top
  const halfAngle = Math.abs(valueMax);

  const R = 35; // sector radius
  const handleR = 38; // drag handle radius

  // Convert angle (degrees from vertical top) to SVG coordinates (centered at 50,50)
  const getCoords = (deg: number, radius: number) => {
    const rad = (deg - 90) * (Math.PI / 180);
    return {
      x: 50 + radius * Math.cos(rad),
      y: 50 + radius * Math.sin(rad),
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (svgRef.current) {
      svgRef.current.setPointerCapture(e.pointerId);
    }
    setIsDragging(true);
    handlePointerMove(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging && e.type !== 'pointerdown') return;
    if (!svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Angle in radians from 3 o'clock positive
    const angleRad = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    let angleDeg = angleRad * (180 / Math.PI); // -180 to 180

    // Transform angle to be relative to vertical top (12 o'clock = 0 degrees)
    // 12 o'clock is -90 degrees in SVG space
    let relativeAngle = angleDeg + 90;
    if (relativeAngle < -180) relativeAngle += 360;
    if (relativeAngle > 180) relativeAngle -= 360;

    // Enforce absolute half-angle from vertical top (0 to 180 degrees)
    let newHalfAngle = Math.abs(relativeAngle);

    // Apply snap increment
    if (snapIncrement > 0) {
      newHalfAngle = Math.round(newHalfAngle / snapIncrement) * snapIncrement;
    }

    // Clamp between 0 and 180 degrees
    newHalfAngle = Math.min(180, Math.max(0, newHalfAngle));

    onChange(-newHalfAngle, newHalfAngle);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (svgRef.current) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
  };

  // Coordinates for the pie sector
  const leftPos = getCoords(-halfAngle, R);
  const rightPos = getCoords(halfAngle, R);

  // Coordinates for handles
  const leftHandle = getCoords(-halfAngle, handleR);
  const rightHandle = getCoords(halfAngle, handleR);

  // Large-arc-flag is 1 if total angle is greater than 180 degrees
  const largeArcFlag = halfAngle * 2 > 180 ? 1 : 0;

  // Render clock ticks
  const ticks = [];
  for (let i = 0; i < 360; i += 15) {
    const isMajor = i % 45 === 0;
    const innerR = isMajor ? 36 : 38;
    const p1 = getCoords(i, innerR);
    const p2 = getCoords(i, 40);
    ticks.push(
      <line
        key={i}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke="var(--border-subtle, #4b5563)"
        strokeWidth={isMajor ? 0.75 : 0.4}
      />
    );
  }

  // Segment Pie sector path
  // If halfAngle is 0, draw nothing. If 180, draw a full circle.
  let sectorPath = '';
  if (halfAngle > 0.1) {
    if (halfAngle >= 179.9) {
      sectorPath = `M 50 ${50 - R} A ${R} ${R} 0 1 1 49.99 ${50 - R} Z`;
    } else {
      sectorPath = `M 50 50 L ${leftPos.x} ${leftPos.y} A ${R} ${R} 0 ${largeArcFlag} 1 ${rightPos.x} ${rightPos.y} Z`;
    }
  }

  return (
    <div className="flex flex-col items-center gap-1 text-xs select-none">
      <span className="font-semibold" style={{ color: 'var(--text-strong, #f3f4f6)' }}>
        Normals Cone Angle
      </span>
      <span className="text-[10px]" style={{ color: 'var(--text-muted, #9ca3af)' }}>
        Dihedral Range: ±{halfAngle.toFixed(0)}°
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
        {/* Background Dial circle */}
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="var(--surface-1, #1f2937)"
          stroke="var(--border-subtle, #374151)"
          strokeWidth="1"
        />

        {/* Dynamic Highlight Sector */}
        {sectorPath && (
          <path
            d={sectorPath}
            fill="rgba(74, 144, 226, 0.25)"
            stroke="var(--accent, #4a90e2)"
            strokeWidth="1.5"
            className="transition-all duration-100 ease-out"
          />
        )}

        {/* Major vertical/horizontal dash guidelines */}
        <line x1="50" y1="12" x2="50" y2="88" stroke="var(--border-subtle, #374151)" strokeDasharray="1 3" />
        <line x1="12" y1="50" x2="88" y2="50" stroke="var(--border-subtle, #374151)" strokeDasharray="1 3" />

        {/* Ticks */}
        {ticks}

        {/* Handle lines extending from center */}
        {halfAngle > 0.1 && (
          <>
            <line
              x1="50"
              y1="50"
              x2={leftHandle.x}
              y2={leftHandle.y}
              stroke="var(--accent, #4a90e2)"
              strokeWidth="1.25"
              strokeDasharray="2 1"
            />
            <line
              x1="50"
              y1="50"
              x2={rightHandle.x}
              y2={rightHandle.y}
              stroke="var(--accent, #4a90e2)"
              strokeWidth="1.25"
              strokeDasharray="2 1"
            />
          </>
        )}

        {/* Draggable Circle Hands */}
        {halfAngle > 0.1 && (
          <>
            {/* Left Hand */}
            <circle
              cx={leftHandle.x}
              cy={leftHandle.y}
              r="4.5"
              fill="var(--surface-0, #111827)"
              stroke="var(--accent, #4a90e2)"
              strokeWidth="2"
              style={{ cursor: 'grab' }}
            />
            {/* Right Hand */}
            <circle
              cx={rightHandle.x}
              cy={rightHandle.y}
              r="4.5"
              fill="var(--surface-0, #111827)"
              stroke="var(--accent, #4a90e2)"
              strokeWidth="2"
              style={{ cursor: 'grab' }}
            />
          </>
        )}

        {/* Center dot */}
        <circle cx="50" cy="50" r="1.5" fill="var(--text-muted, #9ca3af)" />
      </svg>
    </div>
  );
}
