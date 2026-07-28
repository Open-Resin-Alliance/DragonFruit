import { useEffect, useState } from 'react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';

/**
 * Cursor-following tooltip shown on rotation ring hover.
 *
 * Snapping is zonal: it is chosen by where the cursor sits during the drag,
 * not by modifier keys — this hint is the one piece of chrome that makes that
 * discoverable, so its copy must match the zones in SnapTickDial.
 */
export function RotationHintTooltip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      setVisible((e as CustomEvent).detail?.visible ?? false);
    };
    window.addEventListener('dragonfruit:rotation-hint', handler);
    return () => window.removeEventListener('dragonfruit:rotation-hint', handler);
  }, []);

  return (
    <MouseTooltip visible={visible} offset={{ x: 20, y: -40 }}>
      <div
        className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium"
        style={{
          background: 'rgba(0, 0, 0, 0.8)',
          color: 'var(--text-strong, #e0e0e0)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          whiteSpace: 'nowrap',
        }}
      >
        <div>Drag to rotate</div>
        <div className="mt-0.5 opacity-70">
          over ticks: 5° snap &nbsp;|&nbsp; over spokes: 45°
        </div>
      </div>
    </MouseTooltip>
  );
}
