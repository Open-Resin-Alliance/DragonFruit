import { useEffect, useState } from 'react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import { usePlatformModifier } from '@/hooks/usePlatformModifier';
import {
  getSavedRotationSnapSettings,
  subscribeToRotationSnapSettings,
  getRotationSnapDegrees,
  getRotationSnapPresetId,
  ROTATION_SNAP_PRESET_LABELS,
  type RotationSnapSettings,
} from '@/components/settings/rotationSnapPreferences';

/** Cursor-following tooltip shown on rotation ring hover with snap shortcut hints. */
export function RotationHintTooltip() {
  const [visible, setVisible] = useState(false);
  const [settings, setSettings] = useState<RotationSnapSettings>(() => getSavedRotationSnapSettings());
  const modKey = usePlatformModifier();

  useEffect(() => {
    const handler = (e: Event) => {
      setVisible((e as CustomEvent).detail?.visible ?? false);
    };
    window.addEventListener('dragonfruit:rotation-hint', handler);
    return () => window.removeEventListener('dragonfruit:rotation-hint', handler);
  }, []);

  // Keep the displayed increments/preset in sync with the configured snap tiers.
  useEffect(() => {
    const apply = () => setSettings(getSavedRotationSnapSettings());
    apply();
    return subscribeToRotationSnapSettings(apply);
  }, []);

  const { coarse, fine } = getRotationSnapDegrees(settings);
  const presetLabel = ROTATION_SNAP_PRESET_LABELS[getRotationSnapPresetId(settings)];

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
          {modKey}+Drag: {coarse}° &nbsp;|&nbsp; +Shift: {fine}°
        </div>
        <div className="mt-0.5 opacity-60">Snap preset: {presetLabel}</div>
      </div>
    </MouseTooltip>
  );
}
