import { useEffect, useState } from 'react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';

const AXIS_COLORS: Record<string, string> = {
  x: '#ff3120',
  y: '#00ff00',
  z: '#1596ff',
};

export function SnapAngleReadout() {
  const [snap, setSnap] = useState<{ active: boolean; angle?: number; axis?: string }>({ active: false });

  useEffect(() => {
    const handler = (e: Event) => {
      setSnap((e as CustomEvent).detail);
    };
    window.addEventListener('dragonfruit:snap-angle', handler);
    return () => window.removeEventListener('dragonfruit:snap-angle', handler);
  }, []);

  if (!snap.active || snap.angle === undefined) return null;

  const degrees = Math.round((snap.angle * 180) / Math.PI);
  const color = AXIS_COLORS[snap.axis ?? 'x'] ?? '#ffffff';

  return (
    <MouseTooltip visible offset={{ x: 20, y: -30 }}>
      <div
        className="rounded px-1.5 py-0.5 text-[11px] font-mono font-semibold tabular-nums"
        style={{
          color,
          background: 'rgba(0, 0, 0, 0.75)',
          border: `1px solid ${color}33`,
          textShadow: `0 0 6px ${color}88`,
        }}
      >
        {degrees}°
      </div>
    </MouseTooltip>
  );
}
